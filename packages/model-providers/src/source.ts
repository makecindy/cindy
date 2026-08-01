/**
 * 目录源解析与加载（纯逻辑，IO 由 host 注入，零 Electron / node 依赖）。
 *
 *   - release：优先从 Model Access 公共匿名接口拉取完整 Catalog；失败时回退旧 OSS 目录。
 *   - dev：直接读仓库本地文件（`localPath`），改了即时生效、默认不联网。
 *   - 兜底优先级：本地(dev) → 公共 API → 上次有效快照(LKG) → 旧 OSS → 内置 bundled。
 *
 * 目录每进程加载一次、存内存、**无 TTL**（由 host 的 active-catalog 在启动期 await 一次）。
 * host 可注入按源隔离的 LKG 读写：启动仍先请求最新远端，只有远端失败才读缓存，所以不会
 * 引入“新鲜窗口”；坏 JSON / 坏 schema 永不覆盖最后一份有效快照。
 *
 * 本模块不碰文件系统 / 网络 / userData——这些能力由 host 通过 `CatalogIO` 注入，
 * 保证包可独立单测，也保证跨平台路径 / CORS 等细节留在 host。
 */

import { BUNDLED_CATALOG, parseCatalog } from './catalog.js';
import type { AgentKind, Catalog, Provider, ProviderPreset } from './types.js';

/** 公共模型目录 API 路径。发布版由 model-access-server 匿名提供完整 Catalog。 */
export const CATALOG_API_PATH = '/api/model-catalog/catalog';
/** 旧客户端目录的 OSS 相对路径。迁移期作为公共 API 失败后的兼容回退。 */
export const CATALOG_CFG_PATH = '/cfg/providers.json';

/** 整条远端 Catalog fallback 链共享的默认启动等待预算。 */
export const DEFAULT_REMOTE_CATALOG_BUDGET_MS = 15_000;

export interface CatalogSourceConfig {
  /** 完整覆盖源 URL（env XDT_MODELS_URL）；缺省使用公共 catalog API。 */
  url?: string;
  /** 公共 catalog API 基址（modelAccessApiBaseUrl）。 */
  baseUrl?: string;
  /** 迁移期旧 OSS/CDN 基址；公共 API 失败后读取 `${fallbackBaseUrl}/cfg/providers.json`。 */
  fallbackBaseUrl?: string;
  /** dev 本地文件路径（env XDT_MODELS_PATH）；命中则只读它、不联网。 */
  localPath?: string;
  /** 整条远端 fallback 链共享的等待预算；缺省 15 秒。 */
  remoteBudgetMs?: number;
  /** 注入单调时钟（测试用）；缺省 Date.now。 */
  now?: () => number;
  /** 关闭远端拉取（env XDT_DISABLE_MODELS_FETCH）；不影响 localPath 覆盖。 */
  disableFetch?: boolean;
}

export interface CatalogIO {
  /** 拉取远端文本（host 用 electron net.request 绕 CORS；timeoutMs 为本次剩余共享预算）。 */
  fetchText?: (url: string, timeoutMs: number) => Promise<string>;
  /** 读本地文件（dev / localPath）；不存在返回 null。 */
  readFile?: (path: string) => Promise<string | null>;
  /** 读取某远端 scope 的上次有效完整快照；不存在返回 null。 */
  readCache?: (scope: string) => Promise<string | null>;
  /**
   * 原子保存某远端 scope 的完整有效快照。实现可在串行区内保留磁盘上的更新快照，
   * 并返回最终胜出的文本，使调用方内存态与 LKG 使用同一版本。
   */
  writeCache?: (scope: string, text: string) => Promise<string | void>;
  /** 诊断日志（可选）。 */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export type CatalogLoadSource = 'local' | 'remote' | 'cache' | 'bundled';

export interface CatalogLoadResult {
  catalog: Catalog;
  source: CatalogLoadSource;
}

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

/** 解析主 catalog URL：显式 url 优先，否则 `${baseUrl}${CATALOG_API_PATH}`。 */
export function resolveCatalogUrl(cfg: CatalogSourceConfig): string | null {
  if (cfg.url && cfg.url.trim()) return cfg.url.trim();
  if (cfg.baseUrl && cfg.baseUrl.trim()) {
    return trimTrailingSlashes(cfg.baseUrl.trim()) + CATALOG_API_PATH;
  }
  return null;
}

/** 解析迁移期旧 OSS 回退 URL。 */
export function resolveFallbackCatalogUrl(cfg: CatalogSourceConfig): string | null {
  if (!cfg.fallbackBaseUrl?.trim()) return null;
  return trimTrailingSlashes(cfg.fallbackBaseUrl.trim()) + CATALOG_CFG_PATH;
}

/**
 * The migration-only OSS snapshot used to carry cindyModelMeta beside the provider
 * catalog. Strip that one retired block only at the legacy source boundary; canonical
 * API, local dev files, and parseCatalog itself remain strict about unknown fields.
 */
function parseRemoteCatalog(input: string, allowLegacyModelMeta: boolean): Catalog {
  if (!allowLegacyModelMeta) return parseCatalog(input);
  const raw: unknown = JSON.parse(input);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return parseCatalog(raw);
  // Keep every unknown field so parseCatalog can reject it; only the retired legacy block is
  // exempt. A null-prototype destination makes special JSON keys such as `__proto__` ordinary
  // own properties instead of invoking an inherited setter during the compatibility copy.
  const migrated = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (key !== 'cindyModelMeta') migrated[key] = value;
  }
  return parseCatalog(migrated);
}

/** Strip credentials and request-only URL parts before diagnostics leave this package. */
function catalogUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return '[redacted invalid catalog URL]';
  }
}

function remoteErrorForLog(error: unknown, remoteUrl: string, logUrl: string): string {
  return String(error).split(remoteUrl).join(logUrl);
}

/** 只给仍保持 bundled 鉴权与上游路由形状的旧条目迁移 access，不能仅凭 provider id 猜计费。 */
function legacyAccessFor(primary: Provider, bundled: Provider): Provider['access'] {
  if (primary.auth.method !== bundled.auth.method) return undefined;
  const sharedAgents = primary.agents.filter((agent) => bundled.agents.includes(agent));
  if (sharedAgents.length === 0) return undefined;
  const sameRoutes = sharedAgents.every((agent) => {
    const current = primary.routing[agent];
    const baseline = bundled.routing[agent];
    return (
      current !== undefined &&
      baseline !== undefined &&
      current.upstream === baseline.upstream &&
      current.authStrategy === baseline.authStrategy
    );
  });
  return sameRoutes ? bundled.access : undefined;
}

/** 图片能力只可沿用到未声明 access，或仍明确属于同一 bundled 订阅的旧条目。 */
function allowsBundledImageInheritance(
  primaryAccess: Provider['access'],
  bundledAccess: Provider['access'],
): boolean {
  if (primaryAccess === undefined) return true;
  if (bundledAccess === undefined || primaryAccess.kind !== bundledAccess.kind) return false;
  return (
    primaryAccess.kind !== 'subscription' ||
    (bundledAccess.kind === 'subscription' && primaryAccess.product === bundledAccess.product)
  );
}

/**
 * 同 id preset 仍以远端为主；bundled 只给远端仍保留的同 runtime / 同 model
 * 回填缺失的 contextWindow。这样旧远端不会把已核实的长上下文元数据降级，同时远端
 * 仍可通过移除 runtime / model 停止新建，或用显式窗口覆盖 bundled。
 */
function backfillPresetContextWindows(
  primary: ProviderPreset,
  bundled: ProviderPreset,
): ProviderPreset {
  let changed = false;
  const runtimes: ProviderPreset['runtimes'] = {};
  for (const [agent, runtime] of Object.entries(primary.runtimes) as [
    AgentKind,
    NonNullable<ProviderPreset['runtimes'][AgentKind]>,
  ][]) {
    const bundledRuntime = bundled.runtimes[agent];
    if (!bundledRuntime) {
      runtimes[agent] = runtime;
      continue;
    }
    const bundledModels = new Map(bundledRuntime.models.map((model) => [model.id, model]));
    let runtimeChanged = false;
    const models = runtime.models.map((model) => {
      const bundledContextWindow = bundledModels.get(model.id)?.contextWindow;
      if (model.contextWindow !== undefined || bundledContextWindow === undefined) return model;
      runtimeChanged = true;
      changed = true;
      return { ...model, contextWindow: bundledContextWindow };
    });
    runtimes[agent] = runtimeChanged ? { ...runtime, models } : runtime;
  }
  return changed ? { ...primary, runtimes } : primary;
}

/**
 * 把远端 / 本地目录与内置 bundled 合并：以输入目录为主，bundled 补它缺失的
 * provider（按 id），并给旧目录中同 id provider 补缺失的 access 与图像能力元数据。
 * primary 明确提供的值（包括显式空图像清单）永远优先，不被 bundled 覆盖。
 *
 * **顺序契约**：结果按 bundled 数组序稳定排列（anthropic → openai → xai → xd），
 * bundled 之外的远端新增供应商按远端原序追加在后。v2 远端目录只承载 xai 段，
 * 不排序的话 xai 会窜到首位，选择器分段顺序漂移。
 */
export function mergeWithBundled(primary: Catalog): Catalog {
  const bundledById = new Map(BUNDLED_CATALOG.providers.map((p) => [p.id, p]));
  const withBundledMetadata = primary.providers.map((p) => {
    const bundled = bundledById.get(p.id);
    const bundledAccess = bundled ? legacyAccessFor(p, bundled) : undefined;
    if (!bundled) return p;
    const inheritImage =
      p.id === 'xai' &&
      p.imageModels === undefined &&
      bundled.imageModels !== undefined &&
      bundledAccess !== undefined &&
      allowsBundledImageInheritance(p.access, bundledAccess);
    if (!(p.access === undefined && bundledAccess !== undefined) && !inheritImage) {
      return p;
    }
    return {
      ...p,
      ...(p.access === undefined && bundledAccess !== undefined ? { access: bundledAccess } : {}),
      ...(inheritImage
        ? {
            imageModels: bundled.imageModels,
            ...(p.imageDefaults === undefined && bundled.imageDefaults !== undefined
              ? { imageDefaults: bundled.imageDefaults }
              : {}),
          }
        : {}),
    };
  });
  const primaryById = new Map(withBundledMetadata.map((p) => [p.id, p]));
  // bundled 序在前(同 id 取 primary 内容),远端独有的追加在后(保持远端原序)。
  const merged: Provider[] = BUNDLED_CATALOG.providers.map(
    (bundled) => primaryById.get(bundled.id) ?? bundled,
  );
  for (const p of withBundledMetadata) {
    if (!bundledById.has(p.id)) merged.push(p);
  }
  // presets 与 providers 同样按 id 合并：bundled 保序兜底，同 id 远端内容优先，
  // 远端独有项按远端原序追加。避免旧远端的非空 presets 整段遮掉新版客户端内置条目。
  const primaryPresets = primary.presets ?? [];
  const bundledPresets = BUNDLED_CATALOG.presets ?? [];
  const primaryPresetsById = new Map(primaryPresets.map((preset) => [preset.id, preset]));
  const bundledPresetIds = new Set(bundledPresets.map((preset) => preset.id));
  const presets = bundledPresets.map((bundled) => {
    const remote = primaryPresetsById.get(bundled.id);
    return remote ? backfillPresetContextWindows(remote, bundled) : bundled;
  });
  for (const preset of primaryPresets) {
    if (!bundledPresetIds.has(preset.id)) presets.push(preset);
  }
  // modelRegistry 是带 updatedAt 的完整快照，不做逐字段拼接。远端比 bundled 旧时
  // 保留新版客户端随包快照，避免复现 presets 曾出现的“旧远端遮掉新本地能力”；
  // 远端较新时整份生效，继续支持 status=retired、route 删除和价格纠错。
  const selectedRegistry = selectNewerModelRegistry(primary, BUNDLED_CATALOG);
  // xAI is the only provider whose model list is a static part of this Catalog snapshot. When
  // bundled wins the registry revision guard, keep its xAI provider with that same snapshot
  // instead of combining a new registry with an older remote/LKG list.
  const providers = selectedRegistry.fromFallback && primary.modelRegistry !== undefined
    ? merged.map((provider) =>
        provider.id === 'xai' ? (bundledById.get('xai') ?? provider) : provider,
      )
    : merged;
  return {
    version: primary.version,
    providers,
    ...(presets && presets.length > 0 ? { presets } : {}),
    ...(selectedRegistry.modelRegistry ? { modelRegistry: selectedRegistry.modelRegistry } : {}),
  };
}

function log(io: CatalogIO, level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  io.log?.(level, `[model-providers] ${msg}`, meta);
}

function registryUpdatedAt(catalog: Catalog): number | null {
  const value = catalog.modelRegistry?.updatedAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

function selectNewerModelRegistry(
  primary: Catalog,
  fallback: Catalog,
): { modelRegistry: Catalog['modelRegistry']; fromFallback: boolean } {
  const primaryUpdatedAt = registryUpdatedAt(primary);
  const fallbackUpdatedAt = registryUpdatedAt(fallback);
  if (
    fallback.modelRegistry &&
    fallbackUpdatedAt !== null &&
    (primaryUpdatedAt === null || fallbackUpdatedAt > primaryUpdatedAt)
  ) {
    return { modelRegistry: fallback.modelRegistry, fromFallback: true };
  }
  if (primary.modelRegistry) {
    return { modelRegistry: primary.modelRegistry, fromFallback: false };
  }
  return { modelRegistry: fallback.modelRegistry, fromFallback: fallback.modelRegistry !== undefined };
}

function newerModelRegistry(primary: Catalog, fallback: Catalog): Catalog['modelRegistry'] {
  return selectNewerModelRegistry(primary, fallback).modelRegistry;
}

/**
 * modelRegistry is the only monotonic revision carried by the Catalog today. If it proves the
 * LKG is newer, preserve that complete snapshot: combining its registry with older remote xAI
 * providers/presets would create a catalog version that never existed and can reintroduce retired
 * models. A future top-level Catalog revision may allow finer-grained arbitration.
 */
function preserveNewerCachedCatalog(remote: Catalog, cached: Catalog): Catalog {
  const modelRegistry = newerModelRegistry(remote, cached);
  return modelRegistry !== remote.modelRegistry ? cached : remote;
}

/**
 * 加载目录并返回实际命中的来源。返回值永远包含一个合法 Catalog（最差也回退内置
 * bundled），不抛错。来源标记让手动刷新可以把 bundled fallback 视为失败并保留上次
 * 有效快照；启动加载仍可通过 loadCatalog 接受 bundled 兜底。
 *
 * 顺序：
 *  1. dev：cfg.localPath + io.readFile → 读本地、合并 bundled、直接返回（不联网）。
 *  2. 远端依次尝试公共 API、迁移期旧 OSS；每个远端失败后先尝试它自己的 LKG。
 *  3. 任意上述来源均不可用 → 内置 bundled。
 */
export async function loadCatalogWithSource(
  cfg: CatalogSourceConfig,
  io: CatalogIO,
): Promise<CatalogLoadResult> {
  // 1) dev 本地文件优先（命中即用，不联网）。
  if (cfg.localPath && io.readFile) {
    try {
      const text = await io.readFile(cfg.localPath);
      if (text != null) {
        const parsed = parseCatalog(text);
        log(io, 'info', 'loaded catalog from local path', { path: cfg.localPath });
        return { catalog: mergeWithBundled(parsed), source: 'local' };
      }
    } catch (err) {
      log(io, 'warn', 'local catalog read/parse failed, falling back', { err: String(err) });
    }
  }

  // 2) 公共 model-access catalog API；迁移期失败后尝试旧 OSS 目录。
  const url = resolveCatalogUrl(cfg);
  const fallbackUrl = resolveFallbackCatalogUrl(cfg);
  if (!cfg.disableFetch && io.fetchText) {
    const remoteSources = cfg.url?.trim()
      ? url
        ? [{ url, allowLegacyModelMeta: false }]
        : []
      : [
          ...(url ? [{ url, allowLegacyModelMeta: false }] : []),
          ...(fallbackUrl ? [{ url: fallbackUrl, allowLegacyModelMeta: true }] : []),
        ];
    const now = cfg.now ?? Date.now;
    const configuredBudget = cfg.remoteBudgetMs ?? DEFAULT_REMOTE_CATALOG_BUDGET_MS;
    const budgetMs = Number.isFinite(configuredBudget) ? Math.max(0, configuredBudget) : 0;
    const deadline = now() + budgetMs;
    for (const { url: remoteUrl, allowLegacyModelMeta } of remoteSources) {
      const logUrl = catalogUrlForLog(remoteUrl);
      const remainingMs = Math.max(0, deadline - now());
      if (remainingMs > 0) {
        try {
          const text = await io.fetchText(remoteUrl, remainingMs);
          let parsed = parseRemoteCatalog(text, allowLegacyModelMeta);
          // Never propagate the retired compatibility block into a newly written LKG.
          let cacheText = allowLegacyModelMeta ? JSON.stringify(parsed) : text;
          const remoteRegistryUpdatedAt = registryUpdatedAt(parsed);
          if (io.readCache) {
            try {
              const cachedText = await io.readCache(remoteUrl);
              if (cachedText !== null) {
                const cached = parseRemoteCatalog(cachedText, allowLegacyModelMeta);
                const merged = preserveNewerCachedCatalog(parsed, cached);
                if (merged !== parsed) {
                  parsed = merged;
                  cacheText = JSON.stringify(merged);
                  log(io, 'warn', 'remote catalog registry is older than LKG; preserving complete newer snapshot', {
                    url: logUrl,
                    remoteUpdatedAt: remoteRegistryUpdatedAt,
                    cachedUpdatedAt: registryUpdatedAt(cached),
                  });
                }
              }
            } catch (err) {
              log(io, 'warn', 'cached catalog could not be compared with remote snapshot', {
                url: logUrl,
                err: remoteErrorForLog(err, remoteUrl, logUrl),
              });
            }
          }
          if (io.writeCache) {
            try {
              const committedText = await io.writeCache(remoteUrl, cacheText);
              if (typeof committedText === 'string') {
                const committed = parseRemoteCatalog(committedText, allowLegacyModelMeta);
                const selected = preserveNewerCachedCatalog(parsed, committed);
                if (selected !== parsed) {
                  parsed = selected;
                  log(io, 'warn', 'serialized LKG commit preserved a newer catalog snapshot', {
                    url: logUrl,
                    remoteUpdatedAt: remoteRegistryUpdatedAt,
                    committedUpdatedAt: registryUpdatedAt(committed),
                  });
                }
              }
            } catch (err) {
              log(io, 'warn', 'valid remote catalog loaded but LKG write failed', {
                url: logUrl,
                err: remoteErrorForLog(err, remoteUrl, logUrl),
              });
            }
          }
          log(io, 'info', 'loaded catalog from remote', { url: logUrl });
          return { catalog: mergeWithBundled(parsed), source: 'remote' };
        } catch (err) {
          log(io, 'warn', 'remote catalog read/parse failed, trying fallback', {
            url: logUrl,
            err: remoteErrorForLog(err, remoteUrl, logUrl),
          });
        }
      } else {
        log(io, 'warn', 'remote catalog fallback budget exhausted, trying cache', {
          url: logUrl,
        });
      }
      if (io.readCache) {
        try {
          const cached = await io.readCache(remoteUrl);
          if (cached !== null) {
            const parsed = parseRemoteCatalog(cached, allowLegacyModelMeta);
            log(io, 'info', 'loaded last-known-good catalog snapshot', { url: logUrl });
            return { catalog: mergeWithBundled(parsed), source: 'cache' };
          }
        } catch (err) {
          log(io, 'warn', 'cached catalog read/parse failed, trying fallback', {
            url: logUrl,
            err: remoteErrorForLog(err, remoteUrl, logUrl),
          });
        }
      }
    }
  }

  // 3) 兜底：内置 bundled。
  log(io, 'info', 'using bundled catalog');
  return { catalog: BUNDLED_CATALOG, source: 'bundled' };
}

/** 启动期兼容入口：接受最终 bundled fallback，只返回目录快照。 */
export async function loadCatalog(cfg: CatalogSourceConfig, io: CatalogIO): Promise<Catalog> {
  return (await loadCatalogWithSource(cfg, io)).catalog;
}
