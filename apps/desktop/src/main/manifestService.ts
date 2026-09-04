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

import { resolveUpdateChannel, type UpdateChannel } from '@cindy/maker-shared/update-channel';

import { supportsBetaUpdateChannel } from '../shared/updateChannelCapability';
import { createLogger } from './logger';
import { getClientEndpoint } from './clientEndpointsService';
import { isBetaChannelEnabled } from './updateChannelStore';
import { parseAppUpdateVersion } from './updateVersionPolicy';

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
  codexPackage?: CodexManifest;
  ripgrep?: RipgrepManifest;
  pi?: PiManifest;
}

// ── Constants ──────────────────────────────────────────────────────────────

const REQUEST_TIMEOUT_MS = 30_000;

// ── State ──────────────────────────────────────────────────────────────────

let cached: Manifest | null = null;
/** 当前缓存对应的发布通道。读取时跟磁盘对账,共库另一实例切过渠道就丢掉。 */
let cachedChannel: UpdateChannel | null = null;
/**
 * manifest 代际:切渠道(clearCachedManifest)时 +1。fetchManifest 发起时快照,
 * 响应完成写 cached 前核对——若期间切了渠道,这次 in-flight 的旧渠道响应直接作废,
 * 不写缓存、返回 null,让调用方(agent prepare / 更新轮询)下次按新渠道重新 fetch。
 */
let manifestEpoch = 0;

function currentUpdateChannel(): UpdateChannel {
  return resolveUpdateChannel(canaryFlagStore.read(), isBetaChannelEnabled());
}

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
 *
 * beta 渠道(2026-08):设备级开关(isBetaChannelEnabled)。发布通道按
 * resolveUpdateChannel 收敛为 canary > beta > release;release 无后缀,
 * canary/beta 分别拼 -canary / -beta 后缀。canary 命中时忽略 beta。
 */
export async function fetchManifest(
  timeoutMs?: number,
  signal?: AbortSignal,
): Promise<Manifest | null> {
  if (isDev()) return null;
  if (signal?.aborted) return null;

  const channel = currentUpdateChannel();
  const channelSuffix = channel === 'release' ? '' : `-${channel}`;
  // Cache-bust: append timestamp to prevent Chromium / CDN serving stale manifest
  const url = `${getBaseUrl()}/manifest-${getPlatformKey()}${channelSuffix}.json?t=${Date.now()}`;
  // 快照发起时的代际:响应完成写 cached 前核对,期间切渠道则作废本次结果。
  const epochAtStart = manifestEpoch;
  log.info('Fetching (%s channel): %s', channel, url);

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
            // 响应回来前切了渠道:这是旧渠道的 manifest,不作废会污染 cached,
            // 让后续 agent prepare 装旧渠道资产。返回 null 让调用方下次按新渠道重取。
            // 共库另一实例改开关不会推进本进程 epoch,所以还要再对一次当前通道。
            if (epochAtStart !== manifestEpoch || currentUpdateChannel() !== channel) {
              log.info('manifest channel changed during fetch — discarding stale response');
              finish(null);
              return;
            }
            cached = json;
            cachedChannel = channel;
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
 * 读取时跟当前发布通道对账:共库另一实例切过渠道后,旧缓存不能再给 agent prepare 用。
 */
export function getCachedManifest(): Manifest | null {
  if (!cached) return null;
  if (cachedChannel !== currentUpdateChannel()) {
    log.info('cached manifest channel is stale — discarding');
    clearCachedManifest();
    return null;
  }
  return cached;
}

/**
 * 清掉内存里的 manifest 缓存。
 *
 * 切渠道(beta↔release)时调用:agent 二进制(Claude Code / Codex / ripgrep / pi)
 * 的 prepare 会先 getCachedManifest() 再 fetchManifest(),若缓存还停在旧渠道,
 * 同进程内切渠道后可能继续按旧渠道的版本号/下载地址安装资产。清掉后下一次
 * prepare/轮询会重新按新渠道 fetch。
 */
export function clearCachedManifest(): void {
  cached = null;
  cachedChannel = null;
  manifestEpoch += 1;
}

/**
 * 探测 beta 渠道 manifest 是否可达(HTTP 200)。
 *
 * 供设置页在用户打开 beta 开关前预检:CDN 尚未部署 manifest-{platform}-beta.json
 * 时拒绝开启。beta 失败不回落 stable(与 canary 同口径),一旦开启却拉不到,
 * 不只应用热更失效,连 agent 二进制(Claude Code / Codex / ripgrep / pi)也会因
 * 拿不到 manifest 里的版本号而不可用(见 agent-binaries/factory.ts 的
 * 「manifest 之后才判 isInstalled」顺序)——所以「能不能开」必须提前探明,
 * 而不是等用户重启后才发现坏了。
 *
 * HTTP 200 之后还要能解析出 app.version；Linux 还必须带完整可信的 .deb 元数据。
 * 截断 JSON / 错误页 / 不完整安装清单都不能当成渠道可用。
 * 不写 cache、不改当前发布通道。dev 不联网,直接返回 true。
 */
function isUsableBetaManifest(manifest: Manifest): boolean {
  if (!parseAppUpdateVersion(manifest.app?.version)) return false;
  if (process.platform !== 'linux') return true;

  const installer = manifest.app.installer;
  return Boolean(
    installer &&
      typeof installer.file === 'string' &&
      installer.file.endsWith('.deb') &&
      typeof installer.sha256 === 'string' &&
      /^[a-f0-9]{64}$/i.test(installer.sha256) &&
      typeof installer.size === 'number' &&
      Number.isFinite(installer.size) &&
      installer.size > 0,
  );
}

export function probeBetaManifest(timeoutMs = 8_000): Promise<boolean> {
  if (!supportsBetaUpdateChannel(process.platform, process.arch)) return Promise.resolve(false);
  if (isDev()) return Promise.resolve(true);
  const url = `${getBaseUrl()}/manifest-${getPlatformKey()}-beta.json?t=${Date.now()}`;
  return new Promise<boolean>((resolve) => {
    try {
      const request = net.request(url);
      let body = '';
      let settled = false;
      let timeout: ReturnType<typeof setTimeout> | undefined;
      const finish = (value: boolean, abortRequest = false): void => {
        if (settled) return;
        settled = true;
        if (timeout) clearTimeout(timeout);
        if (abortRequest) request.abort();
        resolve(value);
      };
      timeout = setTimeout(() => finish(false, true), timeoutMs);
      request.on('response', (response) => {
        if (response.statusCode !== 200) {
          response.on('data', () => {});
          response.on('end', () => finish(false));
          response.on('error', () => finish(false));
          return;
        }
        response.on('data', (chunk) => {
          body += chunk.toString();
        });
        response.on('end', () => {
          try {
            const json = JSON.parse(body) as Manifest;
            finish(isUsableBetaManifest(json));
          } catch {
            finish(false);
          }
        });
        response.on('error', () => finish(false));
      });
      request.on('error', () => finish(false));
      try {
        request.end();
      } catch {
        finish(false, true);
      }
    } catch {
      resolve(false);
    }
  });
}
