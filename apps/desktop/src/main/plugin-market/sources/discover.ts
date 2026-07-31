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

/** 与 Codex 相同的清单位置，按优先级查找。 */
export const MARKETPLACE_MANIFEST_PATHS = [
  '.agents/plugins/marketplace.json',
  '.agents/plugins/api_marketplace.json',
  '.claude-plugin/marketplace.json',
  '.cursor-plugin/marketplace.json',
] as const;

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
    raw = JSON.parse(await fs.promises.readFile(path.join(realDir, 'ghost.json'), 'utf8'));
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
    return {
      ok: false,
      code: 'MARKET_SOURCE_INVALID',
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  let raw: RawMarketplaceManifest;
  try {
    raw = JSON.parse(
      await fs.promises.readFile(realManifestPath, 'utf8'),
    ) as RawMarketplaceManifest;
  } catch (error) {
    return {
      ok: false,
      code: 'MARKET_SOURCE_INVALID',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
  if (!raw || typeof raw.name !== 'string' || raw.name.trim().length === 0) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json missing name' };
  }
  if (!Array.isArray(raw.plugins)) {
    return { ok: false, code: 'MARKET_SOURCE_INVALID', detail: 'marketplace.json plugins must be an array' };
  }

  const displayName =
    raw.interface &&
    typeof raw.interface === 'object' &&
    !Array.isArray(raw.interface) &&
    typeof (raw.interface as Record<string, unknown>).displayName === 'string'
      ? ((raw.interface as Record<string, unknown>).displayName as string)
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
    marketplace: { name: raw.name.trim(), displayName, plugins, skippedCount },
  };
}
