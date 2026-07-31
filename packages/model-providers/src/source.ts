/**
 * 目录源解析与加载（纯逻辑，IO 由 host 注入，零 Electron / node 依赖）。
 *
 *   - release：优先从 Model Access 公共匿名接口拉取完整 Catalog；失败时回退旧 OSS 目录。
 *   - dev：直接读仓库本地文件（`localPath`），改了即时生效、默认不联网。
 *   - 兜底优先级：本地(dev) → 公共 API → 旧 OSS → 内置 bundled。
 *
 * 目录每进程加载一次、存内存、**无 TTL**（由 host 的 active-catalog 在启动期 await 一次）；
 * 本模块刻意**不做磁盘缓存**——公共 API 与迁移期 OSS 都是远端目录源，bundled 是最终兜底，
 * 无需再引入会让「重启即拉最新」失效的磁盘新鲜窗口。
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
  /** 诊断日志（可选）。 */
  log?: (level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>) => void;
}

export type CatalogLoadSource = 'local' | 'remote' | 'bundled';

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
 * provider（按 id），并给旧目录中同 id provider 补缺失的 access 元数据。primary
 * 明确提供的 access 永远优先，不被 bundled 覆盖。
 *
 * **顺序契约**：结果按 bundled 数组序稳定排列（anthropic → openai → xai → xd），
 * bundled 之外的远端新增供应商按远端原序追加在后。v2 远端目录只承载 xai 段，
 * 不排序的话 xai 会窜到首位，选择器分段顺序漂移。
 */
export function mergeWithBundled(primary: Catalog): Catalog {
  const byId = new Map(primary.providers.map((p) => [p.id, p]));
  const bundledById = new Map(BUNDLED_CATALOG.providers.map((p) => [p.id, p]));
  const withAccess = primary.providers.map((p) => {
    const bundled = bundledById.get(p.id);
    const bundledAccess = bundled ? legacyAccessFor(p, bundled) : undefined;
    return p.access === undefined && bundledAccess !== undefined ? { ...p, access: bundledAccess } : p;
  });
  const primaryById = new Map(withAccess.map((p) => [p.id, p]));
  // bundled 序在前(同 id 取 primary 内容),远端独有的追加在后(保持远端原序)。
  const merged: Provider[] = BUNDLED_CATALOG.providers.map(
    (bundled) => primaryById.get(bundled.id) ?? bundled,
  );
  for (const p of withAccess) {
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
  // cindyModelMeta 仍按整段缺省兜底透传(消费点见 types.ts:服务端 + 客户端展示元数据基线)。
  const cindyModelMeta = primary.cindyModelMeta ?? BUNDLED_CATALOG.cindyModelMeta;
  return {
    version: primary.version,
    providers: merged,
    ...(presets && presets.length > 0 ? { presets } : {}),
    ...(cindyModelMeta !== undefined ? { cindyModelMeta } : {}),
  };
}

function log(io: CatalogIO, level: 'info' | 'warn' | 'error', msg: string, meta?: Record<string, unknown>): void {
  io.log?.(level, `[model-providers] ${msg}`, meta);
}

/**
 * 加载目录并返回实际命中的来源。返回值永远包含一个合法 Catalog（最差也回退内置
 * bundled），不抛错。来源标记让手动刷新可以把 bundled fallback 视为失败并保留上次
 * 有效快照；启动加载仍可通过 loadCatalog 接受 bundled 兜底。
 *
 * 顺序：
 *  1. dev：cfg.localPath + io.readFile → 读本地、合并 bundled、直接返回（不联网）。
 *  2. 远端依次尝试公共 API、迁移期旧 OSS（除非 disableFetch / 无 URL / 无 fetchText）。
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
    const remoteUrls = cfg.url?.trim()
      ? [url].filter((value): value is string => !!value)
      : [url, fallbackUrl].filter((value): value is string => !!value);
    const now = cfg.now ?? Date.now;
    const configuredBudget = cfg.remoteBudgetMs ?? DEFAULT_REMOTE_CATALOG_BUDGET_MS;
    const budgetMs = Number.isFinite(configuredBudget) ? Math.max(0, configuredBudget) : 0;
    const deadline = now() + budgetMs;
    for (const remoteUrl of remoteUrls) {
      const remainingMs = Math.max(0, deadline - now());
      if (remainingMs === 0) {
        log(io, 'warn', 'remote catalog fallback budget exhausted');
        break;
      }
      try {
        const text = await io.fetchText(remoteUrl, remainingMs);
        const parsed = parseCatalog(text);
        log(io, 'info', 'loaded catalog from remote', { url: remoteUrl });
        return { catalog: mergeWithBundled(parsed), source: 'remote' };
      } catch (err) {
        log(io, 'warn', 'remote catalog read/parse failed, trying fallback', {
          url: remoteUrl,
          err: String(err),
        });
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
