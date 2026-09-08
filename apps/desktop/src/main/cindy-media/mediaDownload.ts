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

export class MediaDownloadError extends Error {
  constructor(readonly code: string, message: string) {
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
    if (remainingMs <= 0) throw new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '下载超时，客户端重试未能完成，原生成结果已保留');
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
    try {
      const allowPrivateNetwork = approved.has(approvalKey('network'));
      const { response, release } = await guardedOutboundFetch(
        target.href,
        {
          method: 'GET', redirect: 'manual', signal,
          ...(authorization ? { headers: { Authorization: authorization } } : {}),
        },
        assertActive,
        { targetUrl: target.href, allowHttp: url.protocol === 'http:', allowPrivateNetwork },
      );
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
          visitedRedirects.add(redirected.href);
          url = redirected;
        } else if (!response.ok) {
          throw new MediaDownloadError([401, 403, 404, 410].includes(response.status) ? 'MEDIA_DOWNLOAD_URL_EXPIRED' : ([408, 425, 429].includes(response.status) || response.status >= 500) ? 'MEDIA_DOWNLOAD_FAILED' : 'MEDIA_DOWNLOAD_UNAVAILABLE', `下载服务暂不可用（HTTP ${response.status}），生成结果已保留`);
        } else {
          tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-media-download-'));
          const filePath = path.join(tempDir, 'result');
          const file = await fs.open(filePath, 'wx', 0o600);
          const reader = response.body?.getReader();
          try {
            while (reader) {
              const { done, value } = await reader.read();
              if (done) break;
              assertActive();
              resetIdleTimeout();
              // Await each write: network backpressure keeps memory bounded.
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
      if (error instanceof SsrFBlockedError && !approved.has(approvalKey('network'))) {
        decisionNeeded = 'network';
      } else if (error instanceof MediaDownloadError && error.code !== 'MEDIA_DOWNLOAD_FAILED') {
        throw error;
      } else {
        retryError = new MediaDownloadError('MEDIA_DOWNLOAD_FAILED', '客户端重试后仍未完成下载，原生成结果已保留');
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
