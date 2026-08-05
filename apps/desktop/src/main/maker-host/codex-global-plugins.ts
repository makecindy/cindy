import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';

import {
  ensureDirectoryLink,
  isDirectory,
  realPathOrNull,
  removeManagedLink,
  type ManagedLinkStatus,
} from './managed-dir-links.js';

/**
 * 把用户在本机 codex CLI(~/.codex)安装的插件桥接进 xdt-maker 的隔离 CODEX_HOME。
 *
 * 背景:xdt-maker 给 codex 用独立的 CODEX_HOME(userData/codex-home)隔离 auth /
 * sessions,副作用是用户用独立 codex CLI 装的插件在 xdt-maker 内全部不可见。
 * codex 加载一个本地安装的插件需要且仅需要两件事(0.142.5 实测,两者缺一不可):
 *   1. `<CODEX_HOME>/plugins/cache/<marketplace>/<plugin>/<version>/` 的插件内容;
 *   2. `<CODEX_HOME>/config.toml` 里的 `[plugins."<plugin>@<marketplace>"]` 条目
 *      (enabled 布尔;`[marketplaces.*]` 注册只影响安装 / 更新,不影响加载)。
 * 因此桥接分两步:
 *   - 缓存:对 ~/.codex/plugins/cache 下每个 marketplace 目录建受管链接
 *     (Windows junction / POSIX dir symlink)。隔离 home 里已被 codex 自建的
 *     真实目录(如 remote 插件的 openai-curated-remote)是预期 conflict,跳过
 *     不告警 —— 那类插件由 codex 的 remote-install 机制在隔离 home 内自愈。
 *   - config:把 ~/.codex/config.toml 的 [plugins] 条目**只增不改**地追加进隔离
 *     config.toml(原子写:临时文件 + rename)。已存在的条目一律不动 —— 用户在
 *     xdt-maker 侧的启用 / 禁用选择优先,与 auth reconcile 的"各管各"哲学一致。
 *     只同步 marketplace 缓存目录真实存在的条目,避免制造指向空缓存的孤儿条目。
 *
 * 并发说明:codex app-server 自己也会重写 config.toml(trust 条目等),且可能在
 * 本模块运行期间落盘(ensureGlobalCodexAssets 会在 app-server 已运行时被 IPC 路径
 * 再次触发)。写入走"tmp + rename 前重读比对 + 有界重试"(见
 * writeFileAtomicIfUnchanged):发现文件在本轮 merge 依据的快照之后被别人改过就
 * 丢弃重来,绝不覆盖 codex 的更新;反方向(codex 整写覆盖本轮追加)则靠下次
 * session start 重跑本函数自愈(幂等)。
 */

export interface CodexGlobalPluginsMarketplaceResult {
  name: string;
  source: string;
  link: string;
  status: ManagedLinkStatus;
  reason?: string;
}

export interface CodexGlobalPluginsPrepareResult {
  codexHome: string;
  cacheDir: string;
  changed: boolean;
  marketplaces: CodexGlobalPluginsMarketplaceResult[];
  /** 本轮新追加进隔离 config.toml 的插件 key(`name@marketplace`)。 */
  addedPluginEntries: string[];
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
}

export function codexGlobalPluginsPaths(codexHome: string, homeDir = os.homedir()) {
  return {
    codexHome,
    cacheDir: path.join(codexHome, 'plugins', 'cache'),
    configFile: path.join(codexHome, 'config.toml'),
    sourceCacheDir: path.join(homeDir, '.codex', 'plugins', 'cache'),
    sourceConfigFile: path.join(homeDir, '.codex', 'config.toml'),
  };
}

/** 列出 source cache 下的 marketplace 目录名(跳过 `.` 开头的 staging / 内部目录)。 */
async function listSourceMarketplaces(sourceCacheDir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await fsp.readdir(sourceCacheDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  const names: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith('.')) continue;
    if (await isDirectory(path.join(sourceCacheDir, entry))) names.push(entry);
  }
  return names;
}

/**
 * 清理悬空的受管链接:隔离 cache 里指向已消失 source marketplace 的 symlink。
 * 仅动 symlink(受管形态);codex 自建的真实目录永不触碰。
 */
async function cleanupStaleLinks(
  cacheDir: string,
  liveNames: Set<string>,
): Promise<boolean> {
  let entries: string[];
  try {
    entries = await fsp.readdir(cacheDir);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
  let changed = false;
  for (const entry of entries) {
    if (liveNames.has(entry)) continue;
    const entryPath = path.join(cacheDir, entry);
    try {
      const stat = await fsp.lstat(entryPath);
      if (!stat.isSymbolicLink()) continue;
    } catch {
      continue;
    }
    // 只清悬空链接(target 已不存在)。指向仍存在目标的 symlink 可能是用户手工
    // 布置的,保守保留。
    if ((await realPathOrNull(entryPath)) === null) {
      changed = (await removeManagedLink(entryPath)) || changed;
    }
  }
  return changed;
}

/** 从 `name@marketplace` key 提取 marketplace 段;无 `@` 返回 null。 */
function marketplaceOfPluginKey(key: string): string | null {
  const at = key.lastIndexOf('@');
  if (at <= 0 || at === key.length - 1) return null;
  return key.slice(at + 1);
}

/**
 * 读 TOML 文件顶层 `plugins` table;文件缺失返回 {},解析失败抛出(由调用方
 * 决定告警语义 —— source 坏 / dest 坏的处理不同)。
 */
async function readPluginsTable(file: string): Promise<{
  text: string;
  plugins: Record<string, unknown>;
}> {
  let text: string;
  try {
    text = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return { text: '', plugins: {} };
    throw err;
  }
  const parsed = parseToml(text) as Record<string, unknown>;
  const plugins = parsed['plugins'];
  return {
    text,
    plugins:
      plugins && typeof plugins === 'object' && !Array.isArray(plugins)
        ? (plugins as Record<string, unknown>)
        : {},
  };
}

/**
 * 条件原子写:仅当 file 当前内容仍等于 expectedText(本轮 merge 所依据的快照)
 * 时才 rename 覆盖,否则丢弃 tmp 返回 false —— 由调用方拿新内容重算重试。
 * rename 只防半截文件,防不了丢失更新(codex app-server 随时可能整写 config.toml
 * 落 trust 条目);这里在 rename 前重读比对,把竞态窗口从"parse + stringify +
 * 写盘"压缩到"校验读 → rename"的亚毫秒级。文件缺失视作内容 ''(与
 * readPluginsTable 的 ENOENT 语义对齐)。
 */
export async function writeFileAtomicIfUnchanged(
  file: string,
  content: string,
  expectedText: string,
): Promise<boolean> {
  // 保留原文件权限:rename 会让 config.toml 继承 tmp 的 mode,若原文件被收紧过
  // (如 0600,内含 MCP env secrets),默认 umask 落出的 0644 会把它放宽。原文件
  // 不存在时用保守的 0600。writeFile 的 mode 受 umask 影响,故再显式 chmod 一次
  // (chmod 不受 umask 影响;Windows 上近似 no-op,无副作用)。
  let mode = 0o600;
  try {
    mode = (await fsp.stat(file)).mode & 0o777;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
  }
  const tmp = `${file}.xdt-plugins-sync.tmp-${process.pid}-${Date.now()}`;
  await fsp.writeFile(tmp, content, { encoding: 'utf8', mode });
  try {
    await fsp.chmod(tmp, mode);
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
  let currentText = '';
  try {
    currentText = await fsp.readFile(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
      throw err;
    }
  }
  if (currentText !== expectedText) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    return false;
  }
  try {
    await fsp.rename(tmp, file);
    return true;
  } catch (err) {
    await fsp.rm(tmp, { force: true }).catch(() => undefined);
    throw err;
  }
}

/**
 * 把 source config 里、且 marketplace 缓存真实存在、且 dest 尚无同 key 的
 * [plugins] 条目追加到 dest config 末尾。返回追加的 key 列表。
 *
 * 已知取舍(有意为之):用户在独立 CLI 卸载插件后,这里追加过的条目会成为
 * 孤儿(有条目、无缓存)留在隔离 config.toml 里 —— codex 对这种状态的行为
 * 是"该插件不加载",无报错无副作用(0.142.5 用 debug prompt-input 实测)。
 * 不做自动清理,因为无法区分条目是本模块追加的还是用户 / codex 自己写的
 * (bundled / remote 插件的条目本来就没有对应 plugins/cache 目录,按"无缓存
 * 即清"会误删);要区分就得引入 marker 记账 + 整文件重写 codex 自有的
 * config.toml,风险大于孤儿条目的惰性存在。
 */
async function syncPluginEntries(
  paths: ReturnType<typeof codexGlobalPluginsPaths>,
  sourceMarketplaces: Set<string>,
  warnings: string[],
): Promise<string[]> {
  let source: Awaited<ReturnType<typeof readPluginsTable>>;
  try {
    source = await readPluginsTable(paths.sourceConfigFile);
  } catch (err) {
    warnings.push(
      `cannot read user codex config ${paths.sourceConfigFile}: ${(err as Error).message}`,
    );
    return [];
  }

  const candidates: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(source.plugins)) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) continue;
    const marketplace = marketplaceOfPluginKey(key);
    if (!marketplace || !sourceMarketplaces.has(marketplace)) continue;
    candidates[key] = value;
  }
  if (Object.keys(candidates).length === 0) return [];

  // 有界重试:每轮基于最新 dest 快照 merge;写前校验发现并发写入者(多半是
  // codex app-server 落 trust 条目)就拿新内容重来,绝不覆盖别人的更新。
  const MAX_APPEND_ATTEMPTS = 3;
  for (let attempt = 0; attempt < MAX_APPEND_ATTEMPTS; attempt++) {
    let dest: Awaited<ReturnType<typeof readPluginsTable>>;
    try {
      dest = await readPluginsTable(paths.configFile);
    } catch (err) {
      // dest config 解析失败时绝不追加 —— 文件可能是半截 / 损坏,盲写只会更糟。
      warnings.push(
        `cannot parse isolated codex config ${paths.configFile}, skip plugin entry sync: ${(err as Error).message}`,
      );
      return [];
    }

    const missing: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(candidates)) {
      if (!(key in dest.plugins)) missing[key] = value;
    }
    const missingKeys = Object.keys(missing);
    if (missingKeys.length === 0) return [];

    const fragment = stringifyToml({ plugins: missing });
    const base = dest.text !== '' && !dest.text.endsWith('\n') ? `${dest.text}\n` : dest.text;
    const sep = dest.text === '' ? '' : '\n';
    try {
      const applied = await writeFileAtomicIfUnchanged(
        paths.configFile,
        `${base}${sep}${fragment}\n`,
        dest.text,
      );
      if (applied) return missingKeys;
    } catch (err) {
      warnings.push(
        `cannot append plugin entries to ${paths.configFile}: ${(err as Error).message}`,
      );
      return [];
    }
  }
  // 连续撞上并发写入 —— 放弃本轮,下次 session start 重跑本函数自愈,不告警刷屏。
  return [];
}

export async function prepareCodexGlobalPluginsBridge(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalPluginsPrepareResult> {
  const paths = codexGlobalPluginsPaths(codexHome, opts.homeDir);
  const warnings: string[] = [];
  const marketplaces: CodexGlobalPluginsMarketplaceResult[] = [];
  let changed = false;

  const sourceNames = await listSourceMarketplaces(paths.sourceCacheDir);
  const liveNames = new Set(sourceNames);

  changed = (await cleanupStaleLinks(paths.cacheDir, liveNames)) || changed;

  if (sourceNames.length > 0) {
    await fsp.mkdir(paths.cacheDir, { recursive: true });
    for (const name of sourceNames) {
      const source = path.join(paths.sourceCacheDir, name);
      const link = path.join(paths.cacheDir, name);
      const result = await ensureDirectoryLink(link, source);
      changed = changed || result.changed;
      marketplaces.push({ name, source, link, status: result.status, reason: result.reason });
      // conflict 是稳态(codex remote-install 会在隔离 home 自建同名真实目录),
      // 不进 warnings 以免每次 session start 刷告警;只有真实错误才告警。
      if (result.status === 'error') {
        warnings.push(
          `cannot link codex plugin marketplace cache ${name} from ${source}: ${result.reason ?? 'unknown error'}`,
        );
      }
    }

    const added = await syncPluginEntries(paths, liveNames, warnings);
    changed = changed || added.length > 0;
    return { codexHome, cacheDir: paths.cacheDir, changed, marketplaces, addedPluginEntries: added, warnings };
  }

  return { codexHome, cacheDir: paths.cacheDir, changed, marketplaces, addedPluginEntries: [], warnings };
}
