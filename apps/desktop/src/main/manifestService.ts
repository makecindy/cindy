/**
 * manifestService.ts
 * ---------------------------------------------------------------------------
 * Fetches and caches the CDN manifest.json that drives both app hot-updates
 * and Claude Code binary management.
 *
 * - The CDN base URL comes from the client endpoint manifest
 *   (`getClientEndpoint('cdnBaseUrl')`) — the endpoint manifest is resolved
 *   blocking-style BEFORE any update check (bootstrap-electron:
 *   initClientEndpoints → …later… update chain), so all reads here happen
 *   strictly after init. The base URL is therefore read lazily inside
 *   functions — NEVER capture it in module-level constants (module
 *   evaluation happens before initClientEndpoints and would throw).
 * - In dev mode (app.isPackaged === false), fetching is skipped entirely.
 */

import { app, net } from 'electron';
import * as canaryFlagStore from './canaryFlagStore';

import { createLogger } from './logger';
import { getClientEndpoint } from './clientEndpointsService';

const log = createLogger('manifestService');

// ── Types ──────────────────────────────────────────────────────────────────

export interface PlatformAsset {
  /** Relative path under baseUrl, e.g. "claude-code/2.1.108/win32-x64/claude.exe.gz" */
  file: string;
  sha256: string;
  size: number;
}

export interface AppManifest {
  version: string;
  releaseNotes?: string;
  /** Hotfix ZIP for auto-update */
  hotfix?: PlatformAsset;
  /** Full installer for fresh install / manual download */
  installer?: PlatformAsset;
  /**
   * Force users to re-authorize Feishu after auto-update relaunch into this version.
   * Set true when the release adds new Feishu OAuth scopes / changes auth contract.
   * Consumed once on the first launch of the new version, then cleared.
   */
  requireRelogin?: boolean;
}

export interface ClaudeCodeManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

export interface CodexManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

export interface RipgrepManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
  binarySha256?: string;
}

/**
 * pi 是整目录分发:`file` 指向整包 tar.gz(归档根即完整运行时目录,主二进制 +
 * theme/ 等旁侧资产,与 apps/pi-bin/<platform>/ 同布局),`sha256`/`size` 是该
 * tar.gz 的。可选字段:清单未发 pi 资产或下载失败时，本次不注册 pi，但不阻塞启动。
 */
export interface PiManifest {
  version: string;
  file: string;
  sha256: string;
  size: number;
}

export interface Manifest {
  app: AppManifest;
  /** Linux manifests omit agent assets; packaged Linux uses its official runtime fallback. */
  claudeCode?: ClaudeCodeManifest;
  codex?: CodexManifest;
  ripgrep?: RipgrepManifest;
  pi?: PiManifest;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

// ── State ──────────────────────────────────────────────────────────────────

let cached: Manifest | null = null;

// ── Helpers ────────────────────────────────────────────────────────────────

// 惰性读取(见文件顶注):清单在 initClientEndpoints 之后才可读,模块级捕获会炸。
// 2026-07 退役 cdnInternalBaseUrl:内网加速镜像与 internal_test.txt 探测已下线,
// 更新/hotfix 链一律直连 cdnBaseUrl。
export function getBaseUrl(): string {
  if (process.env.XDT_CDN_BASE_URL) return process.env.XDT_CDN_BASE_URL;
  return getClientEndpoint('cdnBaseUrl');
}

/**
 * Async variant of getBaseUrl(), kept for callers that predate the intranet
 * probe removal (e.g. skillhub auto-sync). No async work remains — it simply
 * resolves with getBaseUrl().
 */
export async function ensureBaseUrl(): Promise<string> {
  return getBaseUrl();
}

export function getPlatformKey(): string {
  return `${process.platform}-${process.arch}`;
}

export function isDev(): boolean {
  return !app.isPackaged;
}

// ── Core ───────────────────────────────────────────────────────────────────

/**
 * Fetch manifest.json from CDN. Returns null on any failure (silent).
 * In dev mode, always returns null — no remote fetching.
 *
 * canary-release V0.1: when canaryFlagStore.read() === true (server marked
 * the logged-in user as a canary tester), pull manifest-{platform}-canary.json
 * instead of the stable manifest. On failure we deliberately do NOT fall back
 * to stable — that would silently downgrade canary users to whatever stale
 * version is sitting on the stable channel.
 */
export async function fetchManifest(
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Manifest | null> {
  if (isDev()) return null;
  if (signal?.aborted) return null;

  const isCanary = canaryFlagStore.read();
  const channelSuffix = isCanary ? '-canary' : '';
  // Cache-bust: append timestamp to prevent Chromium / CDN serving stale manifest
  const url = `${getBaseUrl()}/manifest-${getPlatformKey()}${channelSuffix}.json?t=${Date.now()}`;
  log.info('Fetching (%s channel): %s', isCanary ? 'canary' : 'stable', url);

  return new Promise<Manifest | null>((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;

      const finish = (value: Manifest | null, abortRequest = false): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        signal?.removeEventListener('abort', onAbort);
        if (abortRequest) request.abort();
        resolve(value);
      };
      const onAbort = (): void => finish(null, true);
      signal?.addEventListener('abort', onAbort, { once: true });

      timeout = setTimeout(() => finish(null, true), timeoutMs ?? REQUEST_TIMEOUT_MS);

      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          log.info('HTTP %d for %s', response.statusCode, url);
          finish(null);
          return;
        }

        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          if (settled) return;
          try {
            const json = JSON.parse(body) as Manifest;
            cached = json;
            log.info('Fetched OK: app.version=%s, hotfix=%s', json.app?.version, json.app?.hotfix?.file ?? 'none');
            finish(json);
          } catch (err) {
            log.error('JSON parse failed:', err);
            finish(null);
          }
        });
        response.on('error', () => finish(null));
      });

      request.on('error', () => finish(null));

      try {
        request.end();
      } catch {
        finish(null, true);
      }
    } catch {
      resolve(null);
    }
  });
}

/**
 * Return the in-memory cached manifest (may be null if never fetched or dev mode).
 */
export function getCachedManifest(): Manifest | null {
  return cached;
}
