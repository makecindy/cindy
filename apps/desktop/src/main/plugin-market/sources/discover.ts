/**
 * 自定义市场发现：在市场根目录查找 Codex 兼容的 marketplace.json 并解析插件列表。
 *
 * 兼容 Codex 的清单位置与基础 schema（name + plugins[]，source 为相对路径或
 * {source:"local",path}），但插件本体必须是 Cindy 插件（目录内含合法 ghost.json）。
 * 清单里的描述性字段不作为事实来源——展示与安装一律以 ghost.json 为准。
 *
 * 容错策略与 Codex 一致：单个插件条目非法只跳过并记日志，不让整个市场不可用。
 */
import fs from 'node:fs';
import path from 'node:path';

import { validateGhostManifest, type GhostManifest } from '../../../shared/ghost.js';
import { redactAbsolutePaths } from './git.js';

/** 与 Codex 相同的清单位置，按优先级查找。 */
export const MARKETPLACE_MANIFEST_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

/**
 * 清单与身份卡的读取上限。市场仓库是不受信内容,git clone 不限制单文件大小,
 * 不设上限时一份数 GB 的 marketplace.json / ghost.json 会在 readFile + JSON.parse
 * 里把 main 进程内存打爆。合法清单远小于此(Codex 生态同量级)。
 */
const MARKETPLACE_MANIFEST_MAX_BYTES = 1024 * 1024;
const GHOST_MANIFEST_MAX_BYTES = 512 * 1024;

/**
 * 插件条目数上限。每个条目都会触发 realpath + 读身份卡,不设上限时一份十万条目的
 * 清单能把快照/列表/刷新拖住很久。合法市场远小于此。
 */
const MARKETPLACE_MAX_PLUGIN_ENTRIES = 512;

/** 市场名上限:进 store 持久化、进 pluginId、进 UI,不能不设边界。 */
const MARKET_NAME_MAX_CHARS = 128;

/** 控制字符与双向文本控制符不允许出现在市场名里,防 UI 欺骗与日志注入。 */
// eslint-disable-next-line no-control-regex
const FORBIDDEN_NAME_CHARS = /[\u0000-\u001f\u007f\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

/** 错误 message 可能携带完整宿主路径(ENOENT/EACCES 自带),进 IPC detail 前脱敏。 */
function sanitizedDetail(error: unknown): string {
  return redactAbsolutePaths(error instanceof Error ? error.message : String(error)).slice(0, 256);
}

export type DiscoverError =
  | 'MARKET_MANIFEST_MISSING'
  | 'MARKET_SOURCE_INVALID';

export interface DiscoveredMarketPlugin {
  ghostId: string;
  version: string;
  /** 插件目录的绝对路径（已校验不越出市场根目录）。 */
  dir: string;
  manifest: GhostManifest;
}

export interface DiscoveredMarketplace {
  name: string;
  displayName: string | null;
  plugins: DiscoveredMarketPlugin[];
  /** 被跳过的插件条目数（非法 source / 缺 ghost.json / 校验失败）。 */
  skippedCount: number;
}

export type DiscoverResult =
  | { ok: true; marketplace: DiscoveredMarketplace }
  | { ok: false; code: DiscoverError; detail?: string };

interface RawMarketplaceManifest {
  name?: unknown;
  interface?: unknown;
  plugins?: unknown;
}

/** 解析插件条目的 source 字段为市场内相对路径；不支持的形态返回 null。 */
function pluginEntryRelativePath(source: unknown): string | null {
  if (typeof source === 'string') return source;
  if (source && typeof source === 'object' && !Array.isArray(source)) {
    const record = source as Record<string, unknown>;
    if (record.source === 'local' && typeof record.path === 'string') return record.path;
    // url / git-subdir / npm 形态的远程插件源 Phase 1 不支持。
    return null;
  }
  return null;
}

/** 解析并校验单个插件目录；非法时返回 null（调用方计数跳过）。 */
async function resolvePluginDir(
  marketRoot: string,
  relPath: string,
): Promise<DiscoveredMarketPlugin | null> {
  const trimmed = relPath.trim();
  if (!trimmed || path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) return null;
  const dir = path.resolve(marketRoot, trimmed);
  const rootWithSep = marketRoot.endsWith(path.sep) ? marketRoot : `${marketRoot}${path.sep}`;
  if (dir !== marketRoot && !dir.startsWith(rootWithSep)) return null;

  let realRoot: string;
  let realDir: string;
  try {
    // 字符串前缀只能挡住 "../" 形式的路径穿越；市场内 symlink 仍会指向外部。
    // 边界判定必须以真实路径为准，市场克隆缓存也不应允许 symlink 越出根目录。
    [realRoot, realDir] = await Promise.all([
      fs.promises.realpath(marketRoot),
      fs.promises.realpath(dir),
    ]);
  } catch {
    return null;
  }
  const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
  if (realDir !== realRoot && !realDir.startsWith(realRootWithSep)) return null;

  let raw: unknown;
  try {
    // 身份卡必须是**普通文件**且在大小上限内,并且用 lstat(不跟随链接)判定:
    // realpath 只校验了插件目录,ghost.json 自己仍可以是指向市场外的 symlink——
    // stat 会跟随它,`/dev/zero` 这类特殊文件 size 为 0 还能绕过大小闸,readFile
    // 会无限读到 OOM;普通外部 JSON 也会被解析并投影给 Renderer。目录已经
    // realpath 过,最后一段用 lstat 拒掉 symlink,链接就无处藏身(与打包侧
    // "符号链接一律不穿透"同口径)。
    const manifestFile = path.join(realDir, 'ghost.json');
    const stat = await fs.promises.lstat(manifestFile);
    if (!stat.isFile() || stat.size > GHOST_MANIFEST_MAX_BYTES) return null;
    raw = JSON.parse(await fs.promises.readFile(manifestFile, 'utf8'));
  } catch {
    return null;
  }
  const validated = validateGhostManifest(raw);
  if (!validated.ok) return null;
  return {
    ghostId: validated.manifest.id,
    version: validated.manifest.version,
    dir: realDir,
    manifest: validated.manifest,
  };
}

/**
 * 在市场根目录发现插件。marketRoot 必须已存在（调用方负责克隆/路径校验）。
 */
export async function discoverMarketplace(marketRoot: string): Promise<DiscoverResult> {
  let manifestPath: string | null = null;
  for (const relPath of MARKETPLACE_MANIFEST_PATHS) {
    const candidate = path.join(marketRoot, ...relPath.split('/'));
    if (fs.existsSync(candidate)) {
      manifestPath = candidate;
      break;
    }
  }
  if (!manifestPath) return { ok: false, code: 'MARKET_MANIFEST_MISSING' };

  // 清单读取也必须按真实路径做包含性判定(与 resolvePluginDir 同一套):候选路径是
  // 我们自己拼的,挡不住仓库内的 symlink —— 恶意市场可以把
  // `.agents/plugins/marketplace.json` 做成指向市场根目录外的链接,从而让宿主去读
  // 任意路径。realpath 落在根目录外一律拒。
  let realManifestPath: string;
  try {
    const [realRoot, realManifest] = await Promise.all([
      fs.promises.realpath(marketRoot),
      fs.promises.realpath(manifestPath),
    ]);
    const realRootWithSep = realRoot.endsWith(path.sep) ? realRoot : `${realRoot}${path.sep}`;
    if (!realManifest.startsWith(realRootWithSep)) {
      return {
        ok: false,
        code: 'MARKET_SOURCE_INVALID',
        detail: 'marketplace manifest escapes the marketplace root',
      };
    }
    realManifestPath = realManifest;
  } catch (error) {
    // realpath 的 ENOENT/EACCES message 自带完整宿主路径,进 IPC detail 前必须脱敏。
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: sanitizedDetail(error) };
  }

  let raw: RawMarketplaceManifest;
  try {
    // 不受信内容先看大小再读:git clone 不限制单文件大小,数 GB 的清单会在
    // readFile + JSON.parse 里把 main 进程内存打爆。
    const stat = await fs.promises.stat(realManifestPath);
    if (!stat.isFile()) {
      return {
        ok: false,
        code: 'MARKET_SOURCE_INVALID',
        detail: 'marketplace manifest is not a regular file',
      };
    }
    if (stat.size > MARKETPLACE_MANIFEST_MAX_BYTES) {
      return {
        ok: false,
        code: 'MARKET_SOURCE_INVALID',
        detail: `marketplace manifest exceeds ${MARKETPLACE_MANIFEST_MAX_BYTES} bytes`,
      };
    }
    raw = JSON.parse(
      await fs.promises.readFile(realManifestPath, 'utf8'),
    ) as RawMarketplaceManifest;
  } catch (error) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: sanitizedDetail(error) };
  }
  if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json missing name' };
  }
  const name = raw.name.trim();
  // 市场名会进 store 持久化、进 pluginId、进 UI 与路径 slug,必须有边界:超长
  // 会让配置与账本无界膨胀,控制字符/双向控制符可伪装 UI 文案与污染日志。
  if (name.length > MARKET_NAME_MAX_CHARS || FORBIDDEN_NAME_CHARS.test(name)) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace name is invalid' };
  }
  if (!Array.isArray(raw.plugins)) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json plugins must be an array' };
  }
  if (raw.plugins.length > MARKETPLACE_MAX_PLUGIN_ENTRIES) {
    return {
      ok: false,
      code: 'MARKET_SOURCE_INVALID',
      detail: `marketplace lists more than ${MARKETPLACE_MAX_PLUGIN_ENTRIES} plugins`,
    };
  }

  const rawDisplayName =
    raw.interface &&
    typeof raw.interface === 'object' &&
    !Array.isArray(raw.interface) &&
    typeof (raw.interface as Record<string, unknown>).displayName === 'string'
      ? ((raw.interface as Record<string, unknown>).displayName as string).trim()
      : null;
  // displayName 是描述性字段:非法就丢弃,不因它拒掉整个市场。
  const displayName =
    rawDisplayName &&
    rawDisplayName.length <= MARKET_NAME_MAX_CHARS &&
    !FORBIDDEN_NAME_CHARS.test(rawDisplayName)
      ? rawDisplayName
      : null;

  const plugins: DiscoveredMarketPlugin[] = [];
  const seenGhostIds = new Set<string>();
  let skippedCount = 0;
  for (const entry of raw.plugins) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      skippedCount += 1;
      continue;
    }
    const relPath = pluginEntryRelativePath((entry as Record<string, unknown>).source);
    if (!relPath) {
      skippedCount += 1;
      continue;
    }
    const plugin = await resolvePluginDir(marketRoot, relPath);
    if (!plugin || seenGhostIds.has(plugin.ghostId)) {
      skippedCount += 1;
      continue;
    }
    seenGhostIds.add(plugin.ghostId);
    plugins.push(plugin);
  }

  return {
    ok: true,
    marketplace: { name, displayName, plugins, skippedCount },
  };
}
