/**
 * main 进程统一的服务端 API 客户端。
 *
 * - 复用 `authManager.getAccessToken()` 自动注入 Bearer Authorization
 * - 可恢复的 401 自动 refresh 一次再重试
 * - `ACCOUNT_UNAVAILABLE` 或刷新后仍被 401 拒绝时执行完整本地退登
 * - `baseUrl` **必传**:老主 server(apiBaseUrl)2026-07-18 退役后没有"默认
 *   业务 server"了,每个调用方显式指向自己的独立服务(device-link relay /
 *   model-access / oauth-broker / github-server / skillhub-server ...)。
 */

import { net } from 'electron';
import * as authManager from './authManager';

import { createLogger } from './logger';

const log = createLogger('serverApiClient');

function redactedLogPath(apiPath: string): string {
  const pathname = apiPath.split(/[?#]/, 1)[0];
  const segments = pathname.split('/').filter(Boolean).slice(0, 3);
  return segments.length > 0 ? `/${segments.join('/')}` : '/';
}

export class ServerApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly statusCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'ServerApiError';
  }
}

export interface ApiFetchOptions {
  method?: string;
  body?: unknown;
  /** 每次实际请求前重建 body；401 refresh 重试时会再次调用，优先于静态 body。 */
  bodyFactory?: () => unknown;
  headers?: Record<string, string>;
  cache?: RequestCache;
  /** 显式传 token；不传则取 authManager.getAccessToken()。 */
  token?: string | null;
  /** 跳过 401 自动 refresh（避免无限循环；refresh 自身调用时禁用）。 */
  skipAutoRefresh?: boolean;
  /** 目标服务 base URL(必传;来自 clientEndpoints 的对应字段或注入方)。 */
  baseUrl: string;
  /** Abort the request after this many milliseconds; 0 disables the deadline. */
  timeoutMs?: number;
  /** Keep upstream response/network details out of local logs for sensitive flows. */
  redactErrorDetails?: boolean;
}

interface RawResponse<T> {
  ok: boolean;
  status: number;
  data: T | null;
}

async function rawFetch<T>(apiPath: string, opts: ApiFetchOptions): Promise<RawResponse<T>> {
  const url = opts.baseUrl + apiPath;
  const method = opts.method ?? 'GET';
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(opts.headers ?? {}),
  };
  const token = opts.token !== undefined ? opts.token : authManager.getAccessToken();
  if (token) {
    headers['Authorization'] = 'Bearer ' + token;
  }
  const timeoutMs = opts.timeoutMs ?? 0;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  const timeoutId = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const body = opts.bodyFactory ? opts.bodyFactory() : opts.body;
    const response = await net.fetch(url, {
      method,
      headers,
      cache: opts.cache,
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: controller?.signal,
    });
    let data: T | null = null;
    try {
      data = (await response.json()) as T;
    } catch {
      data = null;
    }
    return { ok: response.ok, status: response.status, data };
  } catch (err) {
    if (opts.redactErrorDetails) {
      log.error(
        'serverApiFetch.redacted_network_error',
        'path=' + redactedLogPath(apiPath),
        'method=' + method,
      );
    } else {
      log.error('fetch failed', apiPath, err);
    }
    return { ok: false, status: 0, data: null };
  } finally {
    if (timeoutId !== null) clearTimeout(timeoutId);
  }
}

/**
 * 高层 API：成功 → 返回 data；失败 → throw ServerApiError。
 * 可恢复的 401 自动 refresh 一次再重试（除非 `skipAutoRefresh`）。
 */
export async function serverApiFetch<T>(apiPath: string, opts: ApiFetchOptions): Promise<T> {
  let result = await rawFetch<T>(apiPath, opts);
  let refreshedAndRetried = false;
  const firstCode = readErrorCode(result.data) ?? statusToCode(result.status);

  if (
    result.status === 401 &&
    !opts.skipAutoRefresh &&
    firstCode !== 'ACCOUNT_UNAVAILABLE' &&
    isRefreshableUnauthorizedCode(firstCode)
  ) {
    const refreshed = await authManager.refresh();
    if (refreshed) {
      refreshedAndRetried = true;
      result = await rawFetch<T>(apiPath, opts);
    }
  }

  if (!result.ok) {
    const errCode = readErrorCode(result.data) ?? statusToCode(result.status);
    const errMsg = readErrorMessage(result.data) ?? `请求失败 (${result.status})`;
    if (
      result.status === 401 &&
      (errCode === 'ACCOUNT_UNAVAILABLE' ||
        (refreshedAndRetried && isRefreshableUnauthorizedCode(errCode)))
    ) {
      void authManager.invalidateSession(
        errCode === 'ACCOUNT_UNAVAILABLE'
          ? 'account-unavailable'
          : 'resource-unauthorized-after-refresh',
      );
    }
    // 网络异常 rawFetch 已 log;这里补 not-ok 响应(401/5xx 等)的日志,
    // 否则上层 catch 一吞,排查调用链时完全看不到原因。
    if (opts.redactErrorDetails) {
      log.warn(
        'serverApiFetch.redacted_not_ok',
        'path=' + redactedLogPath(apiPath),
        'method=' + (opts.method ?? 'GET'),
        'status=' + result.status,
        'code=' + statusToCode(result.status),
      );
    } else {
      log.warn(
        'serverApiFetch.not_ok',
        'path=' + apiPath,
        'method=' + (opts.method ?? 'GET'),
        'status=' + result.status,
        'code=' + errCode,
        'msg=' + errMsg,
      );
    }
    throw new ServerApiError(
      opts.redactErrorDetails ? statusToCode(result.status) : errCode,
      result.status,
      opts.redactErrorDetails ? `请求失败 (${result.status})` : errMsg,
    );
  }
  if (result.data === null) {
    throw new ServerApiError('EMPTY_RESPONSE', result.status, '响应体为空');
  }
  return result.data;
}

function isRefreshableUnauthorizedCode(code: string): boolean {
  return code === 'TOKEN_EXPIRED' || code === 'INVALID_TOKEN' || code === 'UNAUTHORIZED';
}

function readErrorCode(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error?: { code?: string } }).error;
    if (err && typeof err.code === 'string') return err.code;
  }
  return null;
}

function readErrorMessage(data: unknown): string | null {
  if (data && typeof data === 'object' && 'error' in data) {
    const err = (data as { error?: { message?: string } }).error;
    if (err && typeof err.message === 'string') return err.message;
  }
  return null;
}

function statusToCode(status: number): string {
  if (status === 0) return 'NETWORK_ERROR';
  if (status === 401) return 'UNAUTHORIZED';
  if (status === 429) return 'RATE_LIMITED';
  if (status >= 500) return 'INTERNAL_ERROR';
  return `HTTP_${status}`;
}
