/**
 * 目录源解析与加载（纯逻辑，IO 由 host 注入，零 Electron / node 依赖）。
 *
 *   - 运行时只读取当前 Model Access 公共接口，失败时使用同源上次有效快照（LKG）。
 *   - 从未加载过服务端且没有缓存时返回空目录；不包含内置配置或 OSS 回退。
 *   - localPath 仅为显式注入的测试/诊断入口，Desktop 不设置本地文件配置源。
 *
 * 目录每进程加载一次、存内存、**无 TTL**（由 host 的 active-catalog 在启动期 await 一次）。
 * host 可注入按源隔离的 LKG 读写：启动仍先请求最新远端，只有远端失败才读缓存，所以不会
 * 引入“新鲜窗口”；坏 JSON / 坏 schema 永不覆盖最后一份有效快照。
 *
 * 本模块不碰文件系统 / 网络 / userData——这些能力由 host 通过 `CatalogIO` 注入，
 * 保证包可独立单测，也保证跨平台路径 / CORS 等细节留在 host。
 */

import { EMPTY_CATALOG, parseCatalog } from "./catalog.js";
import {
  decideModelRegistrySnapshot,
} from "./modelRegistry.js";
import type { Catalog } from "./types.js";

/** 公共模型目录 API 路径。发布版由 model-access-server 匿名提供完整 Catalog。 */
export const CATALOG_API_PATH =
  "/api/model-catalog/catalog?registrySchemaVersion=5&catalogCapabilities=server-managed-catalog";
/** Explicit contract capability; a bare V4 query also identifies older strict readers. */
export const CATALOG_CAPABILITY = "server-managed-catalog";
/** 整条远端 Catalog fallback 链共享的默认启动等待预算。 */
export const DEFAULT_REMOTE_CATALOG_BUDGET_MS = 15_000;


export interface CatalogSourceConfig {
  /** 完整覆盖源 URL（env XDT_MODELS_URL）；缺省使用公共 catalog API。 */
  url?: string;
  /** 公共 catalog API 基址（modelAccessApiBaseUrl）。 */
  baseUrl?: string;
  /** @deprecated Ignored. No OSS fallback is requested. */
  fallbackBaseUrl?: string;
  /** 显式注入的测试/诊断文件；Desktop 不设置此字段。 */
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
  log?: (
    level: "info" | "warn" | "error",
    msg: string,
    meta?: Record<string, unknown>,
  ) => void;
}

export type CatalogLoadSource = "local" | "remote" | "cache" | "empty";
export type CatalogCapabilityEvidence = "current" | "fallback";
export type CatalogXdMediaKind = "image" | "video" | "embedding";

const ALL_XD_MEDIA_KINDS: readonly CatalogXdMediaKind[] = [
  "image",
  "video",
  "embedding",
];

export interface CatalogLoadResult {
  catalog: Catalog;
  /**
   * Exact validated Server/local/LKG source snapshot. `null` means no snapshot was accepted.
   * Consumers use this field to distinguish an accepted publication from the empty initial state.
   */
  authorityCatalog: Catalog | null;
  source: CatalogLoadSource;
  /**
   * `current` means this exact snapshot came from the configured current catalog source
   * (or an explicit local override). `fallback` covers LKG and an empty initial state,
   * which may keep compatibility metadata but cannot prove current regional availability.
   */
  capabilityEvidence: CatalogCapabilityEvidence;
  /**
   * XD media fields not explicitly supplied by the current source. These fields still need
   * the regional fallback projection even when the snapshot has current evidence.
   */
  unverifiedXdMediaKinds: readonly CatalogXdMediaKind[];
}

function unverifiedXdMediaKindsForPrimary(
  primary: Catalog,
): readonly CatalogXdMediaKind[] {
  const xd = primary.providers.find((provider) => provider.id === "xd");
  if (!xd) return ALL_XD_MEDIA_KINDS;
  return xd.embeddingModels === undefined ? ["embedding"] : [];
}

// 去尾部斜杠。不用 /\/+$/ 正则——超长 '/' 串上会 O(n²) 回溯(CodeQL js/polynomial-redos)。
function trimTrailingSlashes(s: string): string {
  let end = s.length;
  while (end > 0 && s.charCodeAt(end - 1) === 0x2f) end -= 1;
  return s.slice(0, end);
}

/** 解析主 catalog URL：显式 url 优先，否则 `${baseUrl}${CATALOG_API_PATH}`。 */
export function resolveCatalogUrl(cfg: CatalogSourceConfig): string | null {
  if (cfg.url && cfg.url.trim()) {
    const explicit = cfg.url.trim();
    try {
      const url = new URL(explicit);
      if (url.pathname.endsWith("/api/model-catalog/catalog")) {
        url.searchParams.set("registrySchemaVersion", "5");
        url.searchParams.set("catalogCapabilities", CATALOG_CAPABILITY);
        return url.toString();
      }
    } catch {
      /* Existing fetch/error path reports malformed custom URLs. */
    }
    return explicit;
  }
  if (cfg.baseUrl && cfg.baseUrl.trim()) {
    return trimTrailingSlashes(cfg.baseUrl.trim()) + CATALOG_API_PATH;
  }
  return null;
}

/** One-way cache compatibility on upgrade. Old scopes are read, never rewritten. */
async function readCatalogCache(io: CatalogIO, scope: string): Promise<{ text: string; catalog: Catalog; sameRepresentation: boolean } | null> {
  if (!io.readCache) return null;
  const candidates = [scope];
  try {
    const url = new URL(scope);
    if (url.pathname.endsWith('/api/model-catalog/catalog') && url.searchParams.get('catalogCapabilities') === CATALOG_CAPABILITY) {
      for (const [version, capability] of [['5', 'registry-v4-media'], ['5', null], ['4', 'registry-v4-media'], ['4', null]]) {
        const previous = new URL(url);
        previous.searchParams.set('registrySchemaVersion', version!);
        if (capability) previous.searchParams.set('catalogCapabilities', capability);
        else previous.searchParams.delete('catalogCapabilities');
        candidates.push(previous.toString());
      }
    }
  } catch { /* Non-URL scopes retain their existing behavior. */ }
  let newest: { text: string; catalog: Catalog; sameRepresentation: boolean } | null = null;
  for (const candidate of candidates) {
    try {
      const text = await io.readCache(candidate);
      if (text !== null) {
        const catalog = parseCatalog(text);
        // Capability scopes can have different shapes at the same revision. The
        // current representation wins ties; only a newer publication replaces it.
        if (!newest || (registryUpdatedAt(catalog) ?? -Infinity) > (registryUpdatedAt(newest.catalog) ?? -Infinity))
          newest = { text, catalog, sameRepresentation: candidate === scope };
      }
    } catch {
      log(io, 'warn', 'cached catalog candidate is unreadable or invalid; trying the next same-source scope', {
        url: catalogUrlForLog(candidate),
      });
    }
  }
  return newest;
}

/** Strip credentials and request-only URL parts before diagnostics leave this package. */
function catalogUrlForLog(value: string): string {
  try {
    const parsed = new URL(value);
    parsed.username = "";
    parsed.password = "";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return "[redacted invalid catalog URL]";
  }
}

function remoteErrorForLog(
  error: unknown,
  remoteUrl: string,
  logUrl: string,
): string {
  return String(error).split(remoteUrl).join(logUrl);
}

function log(
  io: CatalogIO,
  level: "info" | "warn" | "error",
  msg: string,
  meta?: Record<string, unknown>,
): void {
  io.log?.(level, `[model-providers] ${msg}`, meta);
}

function registryUpdatedAt(catalog: Catalog): number | null {
  const value = catalog.modelRegistry?.updatedAt;
  if (!value) return null;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : null;
}

/**
 * modelRegistry is the only monotonic revision carried by the Catalog today. If it proves the
 * LKG is newer, preserve that complete snapshot: combining its registry with older remote xAI
 * providers/presets would create a catalog version that never existed and can reintroduce retired
 * models. A future top-level Catalog revision may allow finer-grained arbitration.
 *
 * Equal `updatedAt` with different canonical registry content is an illegal republish
 * (corrections must forward-fix with a higher updatedAt): keep the LKG snapshot so a
 * quietly mutated remote revision can never win a tie. Callers log the conflict.
 */
function preserveNewerCachedCatalog(
  remote: Catalog,
  cached: Catalog,
  sameRepresentation = true,
): { catalog: Catalog; tieConflict: boolean } {
  const decision = decideModelRegistrySnapshot(
    remote.modelRegistry,
    cached.modelRegistry,
  );
  if (decision === "preserve-current-conflict") {
    // Schema/capability projections legitimately differ at the same publication
    // revision. Only the current URL's LKG can prove an illegal byte-level republish.
    // A strictly newer old-scope cache still wins through preserve-current below.
    if (!sameRepresentation) return { catalog: remote, tieConflict: false };
    return { catalog: cached, tieConflict: true };
  }
  if (decision === "preserve-current") {
    return { catalog: cached, tieConflict: false };
  }
  return { catalog: remote, tieConflict: false };
}

/**
 * 读取服务端完整发布；请求失败时保留同源 LKG，没有任何快照则返回空目录。
 * 刷新调用方将 empty 视为失败，保留当前快照；不会从客户端常量补充字段或成员。
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
        log(io, "info", "loaded catalog from local path", {
          path: cfg.localPath,
        });
        return {
          catalog: parsed,
          authorityCatalog: parsed,
          source: "local",
          capabilityEvidence: "current",
          unverifiedXdMediaKinds: unverifiedXdMediaKindsForPrimary(parsed),
        };
      }
    } catch (err) {
      log(io, "warn", "local catalog read/parse failed, falling back", {
        err: String(err),
      });
    }
  }

  // 2) 公共 model-access catalog API；迁移期失败后尝试旧 OSS 目录。
  const url = resolveCatalogUrl(cfg);

  if (url) {
    const remoteSources = url ? [{ url }] : [];
    const now = cfg.now ?? Date.now;
    const configuredBudget =
      cfg.remoteBudgetMs ?? DEFAULT_REMOTE_CATALOG_BUDGET_MS;
    const budgetMs = Number.isFinite(configuredBudget)
      ? Math.max(0, configuredBudget)
      : 0;
    const deadline = now() + budgetMs;
    for (const { url: remoteUrl } of remoteSources) {
      const logUrl = catalogUrlForLog(remoteUrl);
      const remainingMs = Math.max(0, deadline - now());
      if (!cfg.disableFetch && io.fetchText && remainingMs > 0) {
        try {
          const text = await io.fetchText(remoteUrl, remainingMs);
          let parsed = parseCatalog(text);
          let capabilityEvidence: CatalogCapabilityEvidence =
            "current";
          let cacheText = text;
          const remoteRegistryUpdatedAt = registryUpdatedAt(parsed);
          if (io.readCache) {
            try {
              const cachedText = await readCatalogCache(io, remoteUrl);
              if (cachedText !== null) {
                const cached = cachedText.catalog;
                const selected = preserveNewerCachedCatalog(parsed, cached, cachedText.sameRepresentation);
                if (selected.catalog !== parsed) {
                  parsed = selected.catalog;
                  cacheText = JSON.stringify(selected.catalog);
                  capabilityEvidence = "fallback";
                  log(
                    io,
                    "warn",
                    selected.tieConflict
                      ? "remote registry republished the same updatedAt with different content; keeping LKG"
                      : "remote catalog registry is older than LKG; preserving complete newer snapshot",
                    {
                      url: logUrl,
                      remoteUpdatedAt: remoteRegistryUpdatedAt,
                      cachedUpdatedAt: registryUpdatedAt(cached),
                    },
                  );
                }
              }
            } catch (err) {
              log(
                io,
                "warn",
                "cached catalog could not be compared with remote snapshot",
                {
                  url: logUrl,
                  err: remoteErrorForLog(err, remoteUrl, logUrl),
                },
              );
            }
          }
          if (io.writeCache) {
            try {
              const committedText = await io.writeCache(remoteUrl, cacheText);
              if (typeof committedText === "string") {
                const committed = parseCatalog(
                  committedText,
                );
                const selected = preserveNewerCachedCatalog(
                  parsed,
                  committed,
                ).catalog;
                if (selected !== parsed) {
                  parsed = selected;
                  capabilityEvidence = "fallback";
                  log(
                    io,
                    "warn",
                    "serialized LKG commit preserved a newer catalog snapshot",
                    {
                      url: logUrl,
                      remoteUpdatedAt: remoteRegistryUpdatedAt,
                      committedUpdatedAt: registryUpdatedAt(committed),
                    },
                  );
                }
              }
            } catch (err) {
              log(
                io,
                "warn",
                "valid remote catalog loaded but LKG write failed",
                {
                  url: logUrl,
                  err: remoteErrorForLog(err, remoteUrl, logUrl),
                },
              );
            }
          }
          log(io, "info", "loaded catalog from remote", { url: logUrl });
          return {
            catalog: parsed,
            authorityCatalog: parsed,
            source: "remote",
            capabilityEvidence,
            unverifiedXdMediaKinds:
              capabilityEvidence === "current"
                ? unverifiedXdMediaKindsForPrimary(parsed)
                : ALL_XD_MEDIA_KINDS,
          };
        } catch (err) {
          log(io, "warn", "remote catalog read/parse failed, trying fallback", {
            url: logUrl,
            err: remoteErrorForLog(err, remoteUrl, logUrl),
          });
        }
      } else {
        log(
          io,
          "warn",
          "remote catalog fallback budget exhausted, trying cache",
          {
            url: logUrl,
          },
        );
      }
      if (io.readCache) {
        try {
          const cached = await readCatalogCache(io, remoteUrl);
          if (cached !== null) {
            const parsed = cached.catalog;
            log(io, "info", "loaded last-known-good catalog snapshot", {
              url: logUrl,
            });
            return {
              catalog: parsed,
              authorityCatalog: parsed,
              source: "cache",
              capabilityEvidence: "fallback",
              unverifiedXdMediaKinds: ALL_XD_MEDIA_KINDS,
            };
          }
        } catch (err) {
          log(io, "warn", "cached catalog read/parse failed, trying fallback", {
            url: logUrl,
            err: remoteErrorForLog(err, remoteUrl, logUrl),
          });
        }
      }
    }
  }

  // 3) 无有效服务端快照时保持空目录。
  log(io, "warn", "server catalog unavailable and no valid cached snapshot");
  return {
    catalog: EMPTY_CATALOG,
    authorityCatalog: null,
    source: "empty",
    capabilityEvidence: "fallback",
    unverifiedXdMediaKinds: ALL_XD_MEDIA_KINDS,
  };
}

/** 启动期入口：只返回当前目录快照（首次离线可以为空）。 */
export async function loadCatalog(
  cfg: CatalogSourceConfig,
  io: CatalogIO,
  onResolved?: (result: CatalogLoadResult) => void,
): Promise<Catalog> {
  const result = await loadCatalogWithSource(cfg, io);
  try {
    onResolved?.(result);
  } catch {
    // Compatibility callers expect this helper to return a valid catalog unconditionally.
    // Hosts that need the metadata must default to fallback-safe behavior if observation fails.
  }
  return result.catalog;
}
