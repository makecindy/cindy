import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SsrFBlockedError } from '@cindy/browser-control-runtime/ssrf-runtime';
import { guardedOutboundFetch } from '../maker-host/outbound-fetch.js';
import { mediaRequestUrlForLog } from './mediaRequestLog.js';

export type MediaDownloadReason = 'source' | 'http' | 'port' | 'credentials' | 'network';

/** Only Host code constructs this context; it is never part of the media tool schema. */
export interface MediaDownloadContext {
  signal?: AbortSignal;
  /** Scoped to one Host invocation operation, including read-only URL refresh. */
  approvals?: Set<string>;
  dispose?(): void;
  assertActive(): void;
  confirm(input: { source: string; reasons: MediaDownloadReason[] }): Promise<boolean>;
}

export interface MediaDeliveryDiagnostic {
  stage: 'dns' | 'connect' | 'http' | 'body' | 'storage' | 'validation' | 'ingest' | 'ledger' | 'policy';
  hostname?: string;
  httpStatus?: number;
  networkCode?: string;
}

export function mediaNetworkErrorCode(error: unknown): string | undefined {
  const queue: unknown[] = [error];
  for (let visited = 0; visited < 8 && queue.length; visited++) {
    const current = queue.shift();
    if (!current || typeof current !== 'object') continue;
    const candidate = current as { code?: unknown; cause?: unknown; errors?: unknown[] };
    if (typeof candidate.code === 'string' && /^(?:E[A-Z0-9_]+|UND_ERR_[A-Z0-9_]+|ERR_[A-Z0-9_]+|CERT_[A-Z0-9_]+|UNABLE_TO_[A-Z0-9_]+|DEPTH_ZERO_[A-Z0-9_]+|SELF_SIGNED_[A-Z0-9_]+|XAI_CDN_DNS_UNAVAILABLE)$/.test(candidate.code) && candidate.code.length <= 64) return candidate.code;
    if (candidate.cause) queue.push(candidate.cause);
    if (Array.isArray(candidate.errors)) queue.push(...candidate.errors.slice(0, 3));
  }
  return undefined;
}

export class MediaDownloadError extends Error {
  constructor(readonly code: string, message: string, readonly diagnostic?: MediaDeliveryDiagnostic,
    readonly retryable = code === 'MEDIA_DOWNLOAD_FAILED' || code === 'MEDIA_DOWNLOAD_URL_EXPIRED') {
    super(message);
    this.name = 'MediaDownloadError';
  }
}

function parseUrl(raw: string, base?: URL): URL {
  try {
    const url = new URL(raw, base);
    if (url.protocol === 'https:' || url.protocol === 'http:') return url;
  } catch { /* Report without the signed URL. */ }
  throw new MediaDownloadError('MEDIA_RESULT_INVALID', '生成结果的下载地址无效，已保留原结果');
}

/** A GET-only, credential-isolated download. Approval never grants another result or invocation. */
export async function downloadMediaResult(input: {
  raw: string;
  allowedHosts?: string[];
  context?: MediaDownloadContext;
  assertActive(): void;
  /** 仅 Host Provider 可给出，工具参数不可声明此权限。 */
  providerDownload?: 'xai-video';
  maxBytes?: number;
}): Promise<{ filePath: string; headerMime: string | null; dispose(): Promise<void> }> {
  let url = parseUrl(input.raw);
  const visitedRedirects = new Set([url.href]);
  let failures = 0;
  let remainingMs = 120_000;
  const approved = input.context?.approvals ?? new Set<string>();
  const approvalKey = (reason: MediaDownloadReason) => {
    if (reason === 'network') {
      // A private-network exception belongs to this exact HTTP target. Source
      // approval may cover an origin, but cannot authorize another internal API.
      const target = new URL(url);
      target.hash = '';
      return `network:${createHash('sha256').update(target.href).digest('hex')}`;
    }
    const credentials = reason === 'credentials'
      ? createHash('sha256').update(`${url.username}:${url.password}`).digest('hex') : '';
    return `${url.origin}:${reason}:${credentials}`;
  };
  const assertActive = () => {
    input.assertActive();
    input.context?.assertActive();
  };
  const confirm = async (reasons: MediaDownloadReason[]) => {
    assertActive();
    if (!input.context) {
      throw new MediaDownloadError('MEDIA_DOWNLOAD_CONFIRMATION_REQUIRED', '本次下载需要用户确认，当前任务的审批通道不可用');
    }
    // Private-network approval is bound to an exact target, so show its path
    // and non-secret query values using the existing URL redaction policy.
    const source = reasons.includes('network') ? mediaRequestUrlForLog(url.href) : url.origin;
    const allowed = await input.context.confirm({ source, reasons });
    assertActive();
    if (!allowed) {
      throw new MediaDownloadError('MEDIA_DOWNLOAD_DENIED', '用户未允许本次下载，已停止；不要自动重试或再次请求审批');
    }
    for (const reason of reasons) approved.add(approvalKey(reason));
  };

  for (;;) {
    assertActive();
    if (input.providerDownload === 'xai-video' && (url.protocol !== 'https:' || url.username || url.password ||
      url.port || !(url.hostname === 'x.ai' || url.hostname.endsWith('.x.ai')))) {
      throw new MediaDownloadError('MEDIA_DOWNLOAD_BLOCKED', '视频来源返回了白名单外的下载地址，已保留原结果', { stage: 'policy', hostname: url.hostname }, false);
    }
    const reasons: MediaDownloadReason[] = [];
    const knownHost = input.allowedHosts?.some((suffix) => {
      const host = suffix.toLowerCase();
      return url.hostname === host || url.hostname.endsWith(`.${host}`);
    });
    if (!knownHost) reasons.push('source');
    if (url.protocol === 'http:') reasons.push('http');
    if (url.port) reasons.push('port');
    if (url.username || url.password) reasons.push('credentials');
    const missing = reasons.filter((reason) => !approved.has(approvalKey(reason)));
    if (missing.length) await confirm(missing);

    // The network budget excludes human decisions, but includes every DNS lookup,
    // response and retry. No body or dispatcher is held while showing a card.
    if (remainingMs <= 0) throw new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '下载超时，客户端重试未能完成，原生成结果已保留', { stage: 'connect', hostname: url.hostname, networkCode: 'ETIMEDOUT' });
    const target = new URL(url);
    // URL credentials, when explicitly approved, belong only to this exact hop.
    let authorization: string | undefined;
    try {
      if (target.username || target.password) {
        authorization = `Basic ${Buffer.from(`${decodeURIComponent(target.username)}:${decodeURIComponent(target.password)}`).toString('base64')}`;
      }
    } catch {
      throw new MediaDownloadError('MEDIA_RESULT_INVALID', '下载地址的登录信息格式无效');
    }
    target.username = '';
    target.password = '';
    const controller = new AbortController();
    const signal = input.context?.signal
      ? AbortSignal.any([controller.signal, input.context.signal]) : controller.signal;
    const startedAt = Date.now();
    const timeout = setTimeout(() => controller.abort(), remainingMs);
    timeout.unref?.();
    let idleTimeout: ReturnType<typeof setTimeout> | undefined;
    const resetIdleTimeout = () => {
      clearTimeout(idleTimeout);
      idleTimeout = setTimeout(() => controller.abort(), 30_000);
      idleTimeout.unref?.();
    };
    resetIdleTimeout();
    let decisionNeeded: MediaDownloadReason | undefined;
    let retryError: MediaDownloadError | undefined;
    let tempDir: string | undefined;
    let result: { filePath: string; headerMime: string | null; dispose(): Promise<void> } | undefined;
    let stage: MediaDeliveryDiagnostic['stage'] = 'connect';
    let httpStatus: number | undefined;
    try {
      const allowPrivateNetwork = input.providerDownload === 'xai-video' ? false : approved.has(approvalKey('network'));
      const { response, release } = await guardedOutboundFetch(
        target.href,
        {
          method: 'GET', redirect: 'manual', signal,
          ...(authorization ? { headers: { Authorization: authorization } } : {}),
        },
        assertActive,
        { targetUrl: target.href, allowHttp: url.protocol === 'http:', allowPrivateNetwork,
          ...(input.providerDownload ? { providerDownload: input.providerDownload } : {}) },
      );
      stage = 'http'; httpStatus = response.status;
      resetIdleTimeout();
      try {
        assertActive();
        if ([301, 302, 303, 307, 308].includes(response.status)) {
          const location = response.headers.get('location');
          if (!location) throw new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '下载服务未返回跳转地址，生成结果已保留');
          // Do not inherit embedded credentials, even on a relative redirect.
          const redirected = parseUrl(location, target);
          if (visitedRedirects.has(redirected.href)) {
            throw new MediaDownloadError('MEDIA_DOWNLOAD_REDIRECT_LOOP', '下载服务返回循环跳转，下载未能完成');
          }
          if (input.providerDownload === 'xai-video' && visitedRedirects.size >= 2) {
            throw new MediaDownloadError('MEDIA_DOWNLOAD_REDIRECT_LIMIT', '视频下载超出 Provider 的单次重定向范围，原结果仍保留', { stage: 'policy', hostname: url.hostname, httpStatus }, false);
          }
          visitedRedirects.add(redirected.href);
          url = redirected;
        } else if (!response.ok) {
          // 这些状态只是地址可能失效的线索；只允许刷新原任务，不宣称确定鉴权原因。
          throw new MediaDownloadError([401, 403, 404, 410].includes(response.status) ? 'MEDIA_DOWNLOAD_URL_EXPIRED' : ([408, 425, 429].includes(response.status) || response.status >= 500) ? 'MEDIA_DOWNLOAD_FAILED' : 'MEDIA_DOWNLOAD_UNAVAILABLE', `下载服务暂不可用（HTTP ${response.status}），生成结果已保留`, { stage, hostname: url.hostname, httpStatus });
        } else {
          if (input.maxBytes !== undefined && Number(response.headers.get('content-length')) > input.maxBytes) {
            throw new MediaDownloadError('MEDIA_RESULT_TOO_LARGE', '视频结果超过允许大小，已保留原任务', { stage: 'validation', hostname: url.hostname, httpStatus }, false);
          }
          stage = 'storage';
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-media-download-'));
          const filePath = path.join(tempDir, 'result');
          const file = await fs.open(filePath, 'wx', 0o600);
          const reader = response.body?.getReader();
          let bytesRead = 0;
          try {
            while (reader) {
              stage = 'body';
              const { done, value } = await reader.read();
              if (done) break;
              assertActive();
              resetIdleTimeout();
              bytesRead += value.byteLength;
              if (input.maxBytes !== undefined && bytesRead > input.maxBytes) throw new MediaDownloadError('MEDIA_RESULT_TOO_LARGE', '视频结果超过允许大小，已保留原任务', { stage: 'validation', hostname: url.hostname, httpStatus }, false);
              // Await each write: network backpressure keeps memory bounded.
              stage = 'storage';
              await file.writeFile(value);
            }
          } finally {
            reader?.releaseLock();
            await file.close();
          }
          const completedDir = tempDir;
          result = {
            filePath,
            headerMime: response.headers.get('content-type')?.split(';', 1)[0].trim().toLowerCase() ?? null,
            dispose: () => fs.rm(completedDir, { recursive: true, force: true }).catch(() => undefined),
          };
        }
      } finally {
        try { await response.body?.cancel().catch(() => undefined); }
        finally { await release(); }
      }
    } catch (error) {
      result = undefined;
      assertActive();
      const networkCode = mediaNetworkErrorCode(error);
      const storageFailure = stage === 'storage' || ['ENOSPC', 'EACCES', 'EPERM', 'EIO', 'EBADF'].includes(networkCode ?? '');
      const diagnostic: MediaDeliveryDiagnostic = { stage: storageFailure ? 'storage' : networkCode === 'XAI_CDN_DNS_UNAVAILABLE' || networkCode === 'ENOTFOUND' || networkCode === 'EAI_AGAIN' ? 'dns' : stage,
        hostname: url.hostname, ...(httpStatus !== undefined ? { httpStatus } : {}),
        ...(networkCode ? { networkCode } : controller.signal.aborted ? { networkCode: 'ETIMEDOUT' } : {}) };
      if (input.context?.signal?.aborted) throw new MediaDownloadError('MEDIA_DOWNLOAD_CANCELLED', '本次下载已取消，原结果仍保留', diagnostic, false);
      if (networkCode && /^(?:ERR_TLS_CERT|CERT_|UNABLE_TO_(?:VERIFY|GET_ISSUER)|DEPTH_ZERO_|SELF_SIGNED_)/.test(networkCode)) {
        throw new MediaDownloadError('MEDIA_DOWNLOAD_TLS_FAILED', '下载目标的 TLS 证书未通过校验，原结果仍保留', diagnostic, false);
      }
      if (error instanceof SsrFBlockedError && input.providerDownload === 'xai-video') {
        throw new MediaDownloadError('MEDIA_DOWNLOAD_BLOCKED', '视频下载目标未通过网络安全校验，原结果仍保留', { stage: 'policy', hostname: url.hostname }, false);
      }
      if (error instanceof SsrFBlockedError && !approved.has(approvalKey('network'))) {
        decisionNeeded = 'network';
      } else if (error instanceof MediaDownloadError && error.code !== 'MEDIA_DOWNLOAD_FAILED') {
        throw error;
      } else {
        if (storageFailure) throw new MediaDownloadError('MEDIA_STORAGE_UNAVAILABLE', '暂时无法保存下载内容，原结果仍保留', diagnostic, false);
        retryError = error instanceof MediaDownloadError ? new MediaDownloadError(error.code, error.message, error.diagnostic ?? diagnostic, error.retryable)
          : new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '客户端重试后仍未完成下载，原生成结果已保留', diagnostic);
      }
    } finally {
      clearTimeout(timeout);
      clearTimeout(idleTimeout);
      remainingMs -= Date.now() - startedAt;
      if (tempDir && !result) await fs.rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
    }
    if (retryError) {
      // Retry only transient network failures. Human denial never enters this branch.
      // Keep approvals and the exact current target; do not resubmit generation.
      if (++failures >= 3 || remainingMs <= 0) throw retryError;
      const backoff = Math.min(250 * 2 ** (failures - 1), remainingMs);
      await delay(backoff, undefined, { signal: input.context?.signal });
      remainingMs -= backoff;
      assertActive();
      continue;
    }
    if (decisionNeeded) {
      await confirm([decisionNeeded]);
    } else if (result) {
      try { assertActive(); }
      catch (error) { await result.dispose(); throw error; }
      return result;
    }
  }
}
