import os from 'node:os';
import path from 'node:path';
import { promises as fsp } from 'node:fs';
import { createHash } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml } from 'smol-toml';
import yaml from 'js-yaml';
import type { CapabilityRoutingPolicy } from '@cindy/maker-core';

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
 *     capability routing 若收紧某个插件能力,则只在隔离 home 内为该
 *     marketplace 建 overlay:目标插件复制后可把 Skill 写成
 *     allow_implicit_invocation=false,也可把 MCP server 改成 Cindy-only
 *     runtime id 以保留来源归属;同 marketplace 其他插件仍链接原缓存。
 *     用户 ~/.codex 下的插件文件始终不改。overlay 无法可靠生成时调用方
 *     fail closed,不退回未经收紧的下游能力继续启动会话。
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
  /**
   * 已启用或启用状态无法可靠确认、且 Cindy 无法在隔离 home 中可靠收紧的下游能力。
   *
   * 调用方必须把非空结果当成 session 启动失败，不能静默退回用户原始
   * marketplace 链接，否则 explicit-only Skill 会重新变成隐式可调用。
   */
  routingFailures: string[];
  warnings: string[];
}

interface PrepareOptions {
  homeDir?: string;
  capabilityRouting?: CapabilityRoutingPolicy;
}

type PluginEnablementSnapshot =
  | { status: 'known'; enabledPluginKeys: ReadonlySet<string> }
  | { status: 'unknown' };

interface CodexPluginOverlayBase {
  pluginKey: string;
  pluginName: string;
  marketplace: string;
}

interface CodexSkillOverlay extends CodexPluginOverlayBase {
  kind: 'skill';
  skillName: string;
}

interface CodexMcpOverlay extends CodexPluginOverlayBase {
  kind: 'mcp';
  sourceServerName: string;
  runtimeServerName: string;
}

type CodexPluginOverlay = CodexSkillOverlay | CodexMcpOverlay;

interface ManagedOverlayMarker {
  schemaVersion: 1;
  source: string;
  sourceSnapshot: string;
  /** Digest of routing-critical files in the isolated, derived overlay. */
  overlaySnapshot?: string;
  skills: Array<{ pluginKey: string; skillName: string }>;
  mcpServers?: Array<{
    pluginKey: string;
    sourceServerName: string;
    runtimeServerName: string;
  }>;
}

const MANAGED_OVERLAY_MARKER = '.cindy-capability-routing.json';
const DISCOVERABLE_PLUGIN_MANIFEST_PATHS = [
  '.codex-plugin/plugin.json',
  '.claude-plugin/plugin.json',
  '.cursor-plugin/plugin.json',
] as const;

function codexCapabilityOverlays(
  policy: CapabilityRoutingPolicy | undefined,
): CodexPluginOverlay[] {
  if (!policy) return [];
  const overlays: CodexPluginOverlay[] = [];
  for (const directive of policy.overrides) {
    if (
      directive.invocation !== 'explicit-only' ||
      directive.source.harness !== 'codex' ||
      directive.source.kind !== 'harness-plugin'
    ) {
      continue;
    }
    const pluginKey = directive.source.containerId;
    if (!pluginKey) continue;
    const marketplace = marketplaceOfPluginKey(pluginKey);
    if (!marketplace) continue;
    const base = {
      pluginKey,
      pluginName: pluginKey.slice(0, -(marketplace.length + 1)),
      marketplace,
    };
    if (directive.source.surface === 'skill') {
      overlays.push({
        ...base,
        kind: 'skill',
        skillName: directive.source.artifactId ?? directive.source.id,
      });
      continue;
    }
    if (
      directive.source.surface === 'mcp' &&
      directive.source.artifactId &&
      directive.source.artifactId !== directive.source.id
    ) {
      overlays.push({
        ...base,
        kind: 'mcp',
        sourceServerName: directive.source.artifactId,
        runtimeServerName: directive.source.id,
      });
    }
  }
  return overlays;
}

function groupOverlaysByMarketplace(
  overlays: readonly CodexPluginOverlay[],
): Map<string, CodexPluginOverlay[]> {
  const grouped = new Map<string, CodexPluginOverlay[]>();
  for (const overlay of overlays) {
    const current = grouped.get(overlay.marketplace) ?? [];
    current.push(overlay);
    grouped.set(overlay.marketplace, current);
  }
  return grouped;
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

async function listDirectoryNames(dir: string): Promise<string[]> {
  let entries: import('node:fs').Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw err;
  }
  return entries
    .filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
    .map((entry) => entry.name)
    .sort();
}

async function treeSnapshot(root: string, relative = ''): Promise<unknown[]> {
  const dir = relative ? path.join(root, relative) : root;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const snapshot: unknown[] = [];
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const childRelative = relative ? path.join(relative, entry.name) : entry.name;
    const child = path.join(root, childRelative);
    if (entry.isDirectory()) {
      snapshot.push({
        path: childRelative,
        kind: 'directory',
        children: await treeSnapshot(root, childRelative),
      });
      continue;
    }
    const stat = await fsp.lstat(child);
    snapshot.push({
      path: childRelative,
      kind: entry.isSymbolicLink() ? 'symlink' : 'file',
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      ...(entry.isSymbolicLink() ? { target: await fsp.readlink(child) } : {}),
    });
  }
  return snapshot;
}

async function assertOverlaySourceHasNoSymlinks(
  root: string,
  relative = '',
): Promise<void> {
  if (!relative && (await fsp.lstat(root)).isSymbolicLink()) {
    throw new Error('protected plugin root is an unsupported symlink');
  }
  const dir = relative ? path.join(root, relative) : root;
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const childRelative = relative
      ? path.join(relative, entry.name)
      : entry.name;
    if (entry.isSymbolicLink()) {
      throw new Error(
        `protected plugin contains unsupported symlink: ${childRelative}`,
      );
    }
    if (entry.isDirectory()) {
      await assertOverlaySourceHasNoSymlinks(root, childRelative);
    }
  }
}

async function sourceMarketplaceSnapshot(
  source: string,
  overlays: readonly CodexPluginOverlay[],
): Promise<string> {
  const plugins = await listDirectoryNames(source);
  const overlaidPlugins = new Set(overlays.map((overlay) => overlay.pluginName));
  const snapshot = await Promise.all(
    plugins.map(async (plugin) => {
      const pluginDir = path.join(source, plugin);
      return {
        plugin,
        ...(overlaidPlugins.has(plugin)
          ? { tree: await treeSnapshot(pluginDir) }
          : { versions: await listDirectoryNames(pluginDir) }),
      };
    }),
  );
  return JSON.stringify(snapshot);
}

async function readManagedOverlayMarker(
  marketplaceDir: string,
): Promise<ManagedOverlayMarker | null> {
  try {
    const raw = await fsp.readFile(path.join(marketplaceDir, MANAGED_OVERLAY_MARKER), 'utf8');
    const parsed = JSON.parse(raw) as Partial<ManagedOverlayMarker>;
    if (
      parsed.schemaVersion !== 1 ||
      typeof parsed.source !== 'string' ||
      typeof parsed.sourceSnapshot !== 'string' ||
      (parsed.overlaySnapshot !== undefined &&
        typeof parsed.overlaySnapshot !== 'string') ||
      !Array.isArray(parsed.skills)
    ) {
      return null;
    }
    return parsed as ManagedOverlayMarker;
  } catch {
    return null;
  }
}

function stableOverlaySkills(overlays: readonly CodexSkillOverlay[]) {
  return overlays
    .map(({ pluginKey, skillName }) => ({ pluginKey, skillName }))
    .sort((a, b) =>
      a.pluginKey === b.pluginKey
        ? a.skillName.localeCompare(b.skillName)
        : a.pluginKey.localeCompare(b.pluginKey),
    );
}

function stableOverlayMcpServers(overlays: readonly CodexMcpOverlay[]) {
  return overlays
    .map(({ pluginKey, sourceServerName, runtimeServerName }) => ({
      pluginKey,
      sourceServerName,
      runtimeServerName,
    }))
    .sort((a, b) => {
      if (a.pluginKey !== b.pluginKey) return a.pluginKey.localeCompare(b.pluginKey);
      if (a.sourceServerName !== b.sourceServerName) {
        return a.sourceServerName.localeCompare(b.sourceServerName);
      }
      return a.runtimeServerName.localeCompare(b.runtimeServerName);
    });
}

function sameOverlayConfiguration(
  marker: ManagedOverlayMarker,
  desired: ManagedOverlayMarker,
): boolean {
  return (
    marker.schemaVersion === desired.schemaVersion &&
    marker.source === desired.source &&
    marker.sourceSnapshot === desired.sourceSnapshot &&
    JSON.stringify(marker.skills) === JSON.stringify(desired.skills) &&
    JSON.stringify(marker.mcpServers ?? []) ===
      JSON.stringify(desired.mcpServers ?? [])
  );
}

async function routingArtifactDigest(
  marketplaceDir: string,
  file: string,
): Promise<{ path: string; sha256: string } | { path: string; missing: true }> {
  const relativePath = path.relative(marketplaceDir, file);
  try {
    const content = await fsp.readFile(file);
    return {
      path: relativePath,
      sha256: createHash('sha256').update(content).digest('hex'),
    };
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { path: relativePath, missing: true };
    }
    throw err;
  }
}

/**
 * Snapshot only files that decide whether routed Skills and MCP servers stay
 * constrained. This keeps the reuse check cheap while still detecting a
 * deleted/rewritten policy, manifest pointer, or MCP configuration.
 */
async function mcpRoutingArtifactDigests(
  marketplaceDir: string,
  pluginVersionDir: string,
): Promise<unknown[]> {
  const artifacts: unknown[] = [];
  let manifest: Record<string, unknown> | null = null;
  for (const relativeManifest of DISCOVERABLE_PLUGIN_MANIFEST_PATHS) {
    const candidate = path.join(pluginVersionDir, relativeManifest);
    try {
      await fsp.access(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    manifest = await readJsonObject(candidate);
    artifacts.push(await routingArtifactDigest(marketplaceDir, candidate));
    break;
  }

  const declaration = manifest?.['mcpServers'];
  if (isRecord(declaration)) return artifacts;
  const configFile =
    typeof declaration === 'string'
      ? resolvePluginOwnedPath(pluginVersionDir, declaration)
      : path.join(pluginVersionDir, '.mcp.json');
  artifacts.push(await routingArtifactDigest(marketplaceDir, configFile));
  return artifacts;
}

async function capabilityRoutingPluginSnapshot(
  marketplaceDir: string,
  pluginName: string,
  overlays: readonly CodexPluginOverlay[],
): Promise<unknown> {
  const pluginDir = path.join(marketplaceDir, pluginName);
  const versions = await listDirectoryNames(pluginDir);
  const artifacts: unknown[] = [];
  const skillOverlays = overlays.filter(
    (overlay): overlay is CodexSkillOverlay => overlay.kind === 'skill',
  );
  const hasMcpOverlays = overlays.some((overlay) => overlay.kind === 'mcp');

  for (const version of versions) {
    const pluginVersionDir = path.join(pluginDir, version);
    for (const overlay of skillOverlays) {
      const skillDir = path.join(
        pluginVersionDir,
        'skills',
        overlay.skillName,
      );
      if (!(await isDirectory(skillDir))) continue;
      artifacts.push(
        await routingArtifactDigest(
          marketplaceDir,
          path.join(skillDir, 'agents', 'openai.yaml'),
        ),
      );
    }
    if (hasMcpOverlays) {
      artifacts.push(
        ...(await mcpRoutingArtifactDigests(
          marketplaceDir,
          pluginVersionDir,
        )),
      );
    }
  }
  return { pluginName, versions, artifacts };
}

async function capabilityRoutingOverlaySnapshot(
  marketplaceDir: string,
  overlays: readonly CodexPluginOverlay[],
): Promise<string> {
  const overlaysByPlugin = new Map<string, CodexPluginOverlay[]>();
  for (const overlay of overlays) {
    const current = overlaysByPlugin.get(overlay.pluginName) ?? [];
    current.push(overlay);
    overlaysByPlugin.set(overlay.pluginName, current);
  }
  const plugins = await Promise.all(
    [...overlaysByPlugin.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([pluginName, pluginOverlays]) =>
        capabilityRoutingPluginSnapshot(
          marketplaceDir,
          pluginName,
          pluginOverlays,
        ),
      ),
  );
  return JSON.stringify(plugins);
}

async function applyExplicitOnlySkillPolicy(
  pluginDir: string,
  overlays: readonly CodexSkillOverlay[],
): Promise<void> {
  const versions = await listDirectoryNames(pluginDir);
  for (const version of versions) {
    for (const overlay of overlays) {
      const skillDir = path.join(pluginDir, version, 'skills', overlay.skillName);
      if (!(await isDirectory(skillDir))) {
        // Plugin caches retain old versions. A version that predates this
        // Skill exposes nothing to constrain, so only mutate versions that
        // actually contain the routed capability.
        continue;
      }
      const agentDir = path.join(skillDir, 'agents');
      const metadataFile = path.join(agentDir, 'openai.yaml');
      let metadata: Record<string, unknown> = {};
      try {
        const raw = await fsp.readFile(metadataFile, 'utf8');
        const parsed = yaml.load(raw);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
          metadata = parsed as Record<string, unknown>;
        }
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
          throw new Error(
            `cannot parse Codex skill metadata ${metadataFile}: ${(err as Error).message}`,
          );
        }
      }
      const existingPolicy =
        metadata.policy && typeof metadata.policy === 'object' && !Array.isArray(metadata.policy)
          ? (metadata.policy as Record<string, unknown>)
          : {};
      metadata.policy = {
        ...existingPolicy,
        allow_implicit_invocation: false,
      };
      await fsp.mkdir(agentDir, { recursive: true });
      await fsp.writeFile(metadataFile, yaml.dump(metadata), 'utf8');
    }
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function renameMcpServerKey(
  servers: Record<string, unknown>,
  overlay: CodexMcpOverlay,
  sourceLabel: string,
): void {
  const source = overlay.sourceServerName;
  const target = overlay.runtimeServerName;
  if (source in servers && target in servers) {
    throw new Error(
      `cannot isolate Codex MCP server ${overlay.pluginKey}/${source}: ${target} already exists in ${sourceLabel}`,
    );
  }
  if (!(source in servers)) {
    // As with Skills, cached plugin versions can predate this MCP server. No
    // source entry means this version does not expose the target capability.
    return;
  }
  const config = servers[source];
  if (!isRecord(config)) {
    throw new Error(
      `cannot isolate Codex MCP server ${overlay.pluginKey}/${source}: expected an object in ${sourceLabel}`,
    );
  }
  // The host guard only runs when Codex emits an MCP approval request. A
  // plugin-provided auto/approve policy could otherwise skip that request
  // entirely, so the isolated copy must force every declared tool back through
  // the host-visible prompt path.
  config['default_tools_approval_mode'] = 'prompt';
  const tools = config['tools'];
  if (tools !== undefined) {
    if (!isRecord(tools)) {
      throw new Error(
        `cannot isolate Codex MCP server ${overlay.pluginKey}/${source}: expected tools to be an object in ${sourceLabel}`,
      );
    }
    for (const [toolName, toolPolicy] of Object.entries(tools)) {
      if (!isRecord(toolPolicy)) {
        throw new Error(
          `cannot isolate Codex MCP server ${overlay.pluginKey}/${source}: expected policy for ${toolName} to be an object in ${sourceLabel}`,
        );
      }
      toolPolicy['approval_mode'] = 'prompt';
    }
  }
  delete servers[source];
  servers[target] = config;
}

function resolvePluginOwnedPath(pluginVersionDir: string, declaredPath: string): string {
  const resolved = path.resolve(pluginVersionDir, declaredPath);
  const relative = path.relative(pluginVersionDir, resolved);
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return resolved;
  }
  throw new Error(`plugin MCP config path escapes its plugin root: ${declaredPath}`);
}

async function writeJson(file: string, value: Record<string, unknown>): Promise<void> {
  await fsp.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function readJsonObject(file: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await fsp.readFile(file, 'utf8');
  } catch (err) {
    throw new Error(`cannot read ${file}: ${(err as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(`cannot parse ${file}: ${(err as Error).message}`);
  }
  if (!isRecord(parsed)) throw new Error(`expected a JSON object in ${file}`);
  return parsed;
}

async function applyMcpServerRename(
  pluginVersionDir: string,
  overlays: readonly CodexMcpOverlay[],
): Promise<void> {
  let manifestFile: string | null = null;
  let manifest: Record<string, unknown> | null = null;
  for (const relativeManifest of DISCOVERABLE_PLUGIN_MANIFEST_PATHS) {
    const candidate = path.join(pluginVersionDir, relativeManifest);
    try {
      await fsp.access(candidate);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw err;
    }
    manifestFile = candidate;
    manifest = await readJsonObject(candidate);
    break;
  }

  const declaration = manifest?.['mcpServers'];
  if (isRecord(declaration)) {
    for (const overlay of overlays) renameMcpServerKey(declaration, overlay, manifestFile!);
    await writeJson(manifestFile!, manifest!);
    return;
  }

  const configFile =
    typeof declaration === 'string'
      ? resolvePluginOwnedPath(pluginVersionDir, declaration)
      : path.join(pluginVersionDir, '.mcp.json');
  try {
    await fsp.access(configFile);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw err;
  }
  const config = await readJsonObject(configFile);
  const servers = isRecord(config['mcpServers']) ? config['mcpServers'] : config;
  for (const overlay of overlays) renameMcpServerKey(servers, overlay, configFile);
  await writeJson(configFile, config);
}

async function applyCapabilityRoutingOverlay(
  pluginDir: string,
  overlays: readonly CodexPluginOverlay[],
): Promise<void> {
  const skillOverlays = overlays.filter(
    (overlay): overlay is CodexSkillOverlay => overlay.kind === 'skill',
  );
  if (skillOverlays.length > 0) {
    await applyExplicitOnlySkillPolicy(pluginDir, skillOverlays);
  }
  const mcpOverlays = overlays.filter(
    (overlay): overlay is CodexMcpOverlay => overlay.kind === 'mcp',
  );
  if (mcpOverlays.length === 0) return;
  for (const version of await listDirectoryNames(pluginDir)) {
    await applyMcpServerRename(path.join(pluginDir, version), mcpOverlays);
  }
}

async function removeManagedOverlayDirectory(
  marketplaceDir: string,
  source: string,
  warnings: string[],
): Promise<boolean> {
  const marker = await readManagedOverlayMarker(marketplaceDir);
  const sourceReal = await realPathOrNull(source);
  if (!marker || !sourceReal || marker.source !== sourceReal) return false;
  const backup = `${marketplaceDir}.cindy-overlay-backup-${process.pid}-${Date.now()}`;
  await fsp.rename(marketplaceDir, backup);
  const linked = await ensureDirectoryLink(marketplaceDir, source);
  if (linked.status !== 'linked' && linked.status !== 'kept') {
    await removeManagedLink(marketplaceDir).catch(() => false);
    try {
      await fsp.rename(backup, marketplaceDir);
    } catch (err) {
      warnings.push(
        `cannot restore Codex plugin marketplace overlay ${marketplaceDir}; preserved it at ${backup}: ${(err as Error).message}`,
      );
    }
    warnings.push(
      `cannot restore direct Codex plugin marketplace link ${marketplaceDir}: ${linked.reason ?? linked.status}`,
    );
    return false;
  }
  try {
    await fsp.rm(backup, { recursive: true, force: true });
  } catch (err) {
    warnings.push(
      `restored direct Codex plugin marketplace link but could not remove backup ${backup}: ${(err as Error).message}`,
    );
  }
  return true;
}

async function ensureOverlayMarketplace(
  source: string,
  marketplaceDir: string,
  overlays: readonly CodexPluginOverlay[],
  warnings: string[],
): Promise<ManagedLinkStatus> {
  const sourceReal = await realPathOrNull(source);
  if (!sourceReal) return 'missing';
  let desiredMarker: ManagedOverlayMarker;
  try {
    desiredMarker = {
      schemaVersion: 1,
      source: sourceReal,
      sourceSnapshot: await sourceMarketplaceSnapshot(source, overlays),
      skills: stableOverlaySkills(
        overlays.filter((overlay): overlay is CodexSkillOverlay => overlay.kind === 'skill'),
      ),
      mcpServers: stableOverlayMcpServers(
        overlays.filter((overlay): overlay is CodexMcpOverlay => overlay.kind === 'mcp'),
      ),
    };
  } catch (err) {
    warnings.push(
      `cannot snapshot Codex capability-routing source ${source}: ${(err as Error).message}`,
    );
    return 'error';
  }

  const rawCurrentMarker = await readManagedOverlayMarker(marketplaceDir);
  const currentMarker = rawCurrentMarker?.source === sourceReal ? rawCurrentMarker : null;
  if (
    currentMarker?.overlaySnapshot &&
    sameOverlayConfiguration(currentMarker, desiredMarker)
  ) {
    try {
      const currentOverlaySnapshot = await capabilityRoutingOverlaySnapshot(
        marketplaceDir,
        overlays,
      );
      if (currentOverlaySnapshot === currentMarker.overlaySnapshot) {
        return 'kept';
      }
    } catch {
      // A broken derived overlay is rebuilt from the already-snapshotted source.
    }
  }

  try {
    const current = await fsp.lstat(marketplaceDir);
    if (!current.isSymbolicLink() && !currentMarker) return 'conflict';
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      warnings.push(
        `cannot inspect Codex plugin marketplace overlay ${marketplaceDir}: ${(err as Error).message}`,
      );
      return 'error';
    }
  }

  await fsp.mkdir(path.dirname(marketplaceDir), { recursive: true });
  const staging = await fsp.mkdtemp(
    path.join(path.dirname(marketplaceDir), `.${path.basename(marketplaceDir)}.cindy-overlay-`),
  );
  let backup: string | null = null;
  try {
    const pluginNames = await listDirectoryNames(source);
    const overlaysByPlugin = new Map<string, CodexPluginOverlay[]>();
    for (const overlay of overlays) {
      const current = overlaysByPlugin.get(overlay.pluginName) ?? [];
      current.push(overlay);
      overlaysByPlugin.set(overlay.pluginName, current);
    }
    for (const pluginName of overlaysByPlugin.keys()) {
      if (!pluginNames.includes(pluginName)) {
        throw new Error(`overlaid plugin ${pluginName} is missing from ${source}`);
      }
    }

    for (const pluginName of pluginNames) {
      const sourcePlugin = path.join(source, pluginName);
      const stagedPlugin = path.join(staging, pluginName);
      const pluginOverlays = overlaysByPlugin.get(pluginName);
      if (!pluginOverlays || pluginOverlays.length === 0) {
        const linked = await ensureDirectoryLink(stagedPlugin, sourcePlugin);
        if (linked.status === 'error' || linked.status === 'conflict') {
          throw new Error(
            `cannot link unchanged plugin ${pluginName}: ${linked.reason ?? linked.status}`,
          );
        }
        continue;
      }
      // The protected plugin is copied so Cindy can edit only its isolated
      // metadata. Reject symlinks first: following one could copy unrelated
      // user files into the overlay, while preserving one could make our
      // metadata write escape the staging directory.
      await assertOverlaySourceHasNoSymlinks(sourcePlugin);
      await fsp.cp(sourcePlugin, stagedPlugin, {
        recursive: true,
        dereference: true,
        errorOnExist: true,
        force: false,
      });
      await applyCapabilityRoutingOverlay(stagedPlugin, pluginOverlays);
    }
    desiredMarker.overlaySnapshot = await capabilityRoutingOverlaySnapshot(
      staging,
      overlays,
    );
    await fsp.writeFile(
      path.join(staging, MANAGED_OVERLAY_MARKER),
      `${JSON.stringify(desiredMarker, null, 2)}\n`,
      'utf8',
    );

    try {
      const current = await fsp.lstat(marketplaceDir);
      if (current.isSymbolicLink()) {
        await removeManagedLink(marketplaceDir);
      } else if (currentMarker) {
        backup = `${marketplaceDir}.cindy-overlay-backup-${process.pid}-${Date.now()}`;
        await fsp.rename(marketplaceDir, backup);
      } else {
        await fsp.rm(staging, { recursive: true, force: true });
        return 'conflict';
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
    }

    await fsp.rename(staging, marketplaceDir);
    const replacedOverlay = backup;
    backup = null;
    if (replacedOverlay) {
      try {
        await fsp.rm(replacedOverlay, { recursive: true, force: true });
      } catch (err) {
        warnings.push(
          `updated Codex plugin marketplace overlay but could not remove backup ${replacedOverlay}: ${(err as Error).message}`,
        );
      }
    }
    return 'linked';
  } catch (err) {
    warnings.push(
      `cannot prepare Codex capability-routing overlay for ${marketplaceDir}: ${(err as Error).message}`,
    );
    await fsp.rm(staging, { recursive: true, force: true }).catch(() => undefined);
    if (backup) {
      try {
        await fsp.rename(backup, marketplaceDir);
      } catch (restoreErr) {
        warnings.push(
          `cannot restore the previous Codex plugin marketplace overlay ${marketplaceDir}; preserved it at ${backup}: ${(restoreErr as Error).message}`,
        );
      }
    } else if (!(await isDirectory(marketplaceDir))) {
      await ensureDirectoryLink(marketplaceDir, source);
    }
    return 'error';
  }
}

/**
 * 清理悬空的受管内容:
 * - 隔离 cache 里指向已消失 source marketplace 的 symlink;
 * - source 已消失、且带本模块 marker 的 capability-routing overlay。
 * codex 自建或用户手工布置的真实目录永不触碰。
 */
async function cleanupStaleLinks(cacheDir: string, liveNames: Set<string>): Promise<boolean> {
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
    let stat: import('node:fs').Stats;
    try {
      stat = await fsp.lstat(entryPath);
    } catch {
      continue;
    }
    if (stat.isSymbolicLink()) {
      // 只清悬空链接(target 已不存在)。指向仍存在目标的 symlink 可能是用户手工
      // 布置的,保守保留。
      if ((await realPathOrNull(entryPath)) === null) {
        changed = (await removeManagedLink(entryPath)) || changed;
      }
      continue;
    }
    if (!stat.isDirectory()) continue;
    const marker = await readManagedOverlayMarker(entryPath);
    if (marker && (await realPathOrNull(marker.source)) === null) {
      await fsp.rm(entryPath, { recursive: true, force: true });
      changed = true;
    }
  }
  return changed;
}

async function collectCapabilityRoutingFailures(
  cacheDir: string,
  sourceCacheDir: string,
  overlaysByMarketplace: ReadonlyMap<string, readonly CodexPluginOverlay[]>,
  marketplaces: readonly CodexGlobalPluginsMarketplaceResult[],
  enablement: PluginEnablementSnapshot,
  inventory: { sourceReadable: boolean; isolatedReadable: boolean },
): Promise<string[]> {
  const statusByMarketplace = new Map(
    marketplaces.map(({ name, status }) => [name, status] as const),
  );
  const failures: string[] = [];
  for (const [marketplace, overlays] of overlaysByMarketplace) {
    const status = statusByMarketplace.get(marketplace);
    if (status === 'linked' || status === 'kept') continue;
    const protectedPlugins = new Map(
      overlays.map((overlay) => [overlay.pluginKey, overlay.pluginName] as const),
    );
    for (const [pluginKey, pluginName] of protectedPlugins) {
      // A cache directory alone does not make a plugin active. A readable
      // isolated config is authoritative because syncPluginEntries preserves
      // `enabled = false`. If config or inventory cannot be read, absence is
      // no longer proof of safety: an unenforced overlay must fail closed.
      if (
        enablement.status === 'known' &&
        !enablement.enabledPluginKeys.has(pluginKey)
      ) {
        continue;
      }
      const [isolatedPluginExists, sourcePluginExists] = await Promise.all([
        isDirectory(path.join(cacheDir, marketplace, pluginName)),
        isDirectory(path.join(sourceCacheDir, marketplace, pluginName)),
      ]);
      if (
        !isolatedPluginExists &&
        !sourcePluginExists &&
        inventory.sourceReadable &&
        inventory.isolatedReadable
      ) {
        continue;
      }
      failures.push(
        `cannot enforce Cindy capability routing for installed Codex plugin ${pluginName}@${marketplace} (marketplace status: ${status ?? 'unmanaged'})`,
      );
    }
  }
  return failures;
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

async function readEnabledPluginKeys(
  configFile: string,
  warnings: string[],
): Promise<PluginEnablementSnapshot> {
  let config: Awaited<ReturnType<typeof readPluginsTable>>;
  try {
    config = await readPluginsTable(configFile);
  } catch (err) {
    warnings.push(
      `cannot confirm enabled plugins in isolated codex config ${configFile}: ${(err as Error).message}`,
    );
    return { status: 'unknown' };
  }
  return {
    status: 'known',
    enabledPluginKeys: new Set(
      Object.entries(config.plugins).flatMap(([key, value]) =>
        isRecord(value) && value['enabled'] !== false ? [key] : [],
      ),
    ),
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

    let fragment: string;
    try {
      fragment = stringifyToml({ plugins: missing });
    } catch (err) {
      warnings.push(
        `cannot serialize plugin entries for ${paths.configFile}: ${(err as Error).message}`,
      );
      return [];
    }
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

async function inspectPluginInventories(
  paths: ReturnType<typeof codexGlobalPluginsPaths>,
  warnings: string[],
): Promise<{
  sourceNames: string[];
  sourceReadable: boolean;
  isolatedReadable: boolean;
  changed: boolean;
}> {
  let sourceNames: string[] = [];
  try {
    sourceNames = await listSourceMarketplaces(paths.sourceCacheDir);
  } catch (err) {
    warnings.push(
      `cannot inspect user Codex plugin cache ${paths.sourceCacheDir}: ${(err as Error).message}`,
    );
    return {
      sourceNames,
      sourceReadable: false,
      isolatedReadable: true,
      changed: false,
    };
  }

  try {
    return {
      sourceNames,
      sourceReadable: true,
      isolatedReadable: true,
      changed: await cleanupStaleLinks(paths.cacheDir, new Set(sourceNames)),
    };
  } catch (err) {
    warnings.push(
      `cannot inspect isolated Codex plugin cache ${paths.cacheDir}: ${(err as Error).message}`,
    );
    return {
      sourceNames,
      sourceReadable: true,
      isolatedReadable: false,
      changed: false,
    };
  }
}

async function prepareSourceMarketplace(
  paths: ReturnType<typeof codexGlobalPluginsPaths>,
  name: string,
  overlays: readonly CodexPluginOverlay[] | undefined,
  cacheReady: boolean,
  warnings: string[],
): Promise<{ result: CodexGlobalPluginsMarketplaceResult; changed: boolean }> {
  const source = path.join(paths.sourceCacheDir, name);
  const link = path.join(paths.cacheDir, name);
  let status: ManagedLinkStatus;
  let reason: string | undefined;
  let changed = false;

  if (!cacheReady) {
    status = 'error';
    reason = 'isolated plugin cache is unavailable';
  } else {
    try {
      if (overlays && overlays.length > 0) {
        status = await ensureOverlayMarketplace(source, link, overlays, warnings);
        changed = status === 'linked';
      } else {
        changed = await removeManagedOverlayDirectory(link, source, warnings);
        const linked = await ensureDirectoryLink(link, source);
        status = linked.status;
        reason = linked.reason;
        changed = changed || linked.changed;
      }
    } catch (err) {
      status = 'error';
      reason = (err as Error).message;
      warnings.push(`cannot prepare Codex plugin marketplace ${name}: ${reason}`);
    }
  }

  if (status === 'error' && (!overlays || overlays.length === 0)) {
    warnings.push(
      `cannot link codex plugin marketplace cache ${name} from ${source}: ${reason ?? 'unknown error'}`,
    );
  }
  return { result: { name, source, link, status, reason }, changed };
}

async function prepareSourceMarketplaces(
  paths: ReturnType<typeof codexGlobalPluginsPaths>,
  sourceNames: readonly string[],
  overlaysByMarketplace: ReadonlyMap<string, readonly CodexPluginOverlay[]>,
  warnings: string[],
): Promise<{
  marketplaces: CodexGlobalPluginsMarketplaceResult[];
  added: string[];
  changed: boolean;
  isolatedReadable: boolean;
}> {
  if (sourceNames.length === 0) {
    return { marketplaces: [], added: [], changed: false, isolatedReadable: true };
  }

  let cacheReady = true;
  try {
    await fsp.mkdir(paths.cacheDir, { recursive: true });
  } catch (err) {
    cacheReady = false;
    warnings.push(
      `cannot prepare isolated Codex plugin cache ${paths.cacheDir}: ${(err as Error).message}`,
    );
  }

  const marketplaces: CodexGlobalPluginsMarketplaceResult[] = [];
  let changed = false;
  for (const name of sourceNames) {
    const prepared = await prepareSourceMarketplace(
      paths,
      name,
      overlaysByMarketplace.get(name),
      cacheReady,
      warnings,
    );
    marketplaces.push(prepared.result);
    changed = changed || prepared.changed;
  }
  const added = await syncPluginEntries(paths, new Set(sourceNames), warnings);
  return {
    marketplaces,
    added,
    changed: changed || added.length > 0,
    isolatedReadable: cacheReady,
  };
}

export async function prepareCodexGlobalPluginsBridge(
  codexHome: string,
  opts: PrepareOptions = {},
): Promise<CodexGlobalPluginsPrepareResult> {
  const paths = codexGlobalPluginsPaths(codexHome, opts.homeDir);
  const warnings: string[] = [];
  const overlaysByMarketplace = groupOverlaysByMarketplace(
    codexCapabilityOverlays(opts.capabilityRouting),
  );
  const inventory = await inspectPluginInventories(paths, warnings);
  const prepared = await prepareSourceMarketplaces(
    paths,
    inventory.sourceNames,
    overlaysByMarketplace,
    warnings,
  );

  const enablement: PluginEnablementSnapshot =
    overlaysByMarketplace.size > 0
      ? await readEnabledPluginKeys(paths.configFile, warnings)
      : { status: 'known', enabledPluginKeys: new Set<string>() };
  const routingFailures = await collectCapabilityRoutingFailures(
    paths.cacheDir,
    paths.sourceCacheDir,
    overlaysByMarketplace,
    prepared.marketplaces,
    enablement,
    {
      sourceReadable: inventory.sourceReadable,
      isolatedReadable:
        inventory.isolatedReadable && prepared.isolatedReadable,
    },
  );
  return {
    codexHome,
    cacheDir: paths.cacheDir,
    changed: inventory.changed || prepared.changed,
    marketplaces: prepared.marketplaces,
    addedPluginEntries: prepared.added,
    routingFailures,
    warnings,
  };
}
