import { i18n } from '@/i18n';

export class ApiError extends Error {
  constructor(
    public readonly code: string,
    public readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

export interface ApiFetchOptions {
  /** 目标服务 base URL(必传:老主 server 2026-07 退役后没有"默认业务 server")。 */
  baseUrl: string;
  method?: string;
  token?: string | null;
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_API_TIMEOUT_MS = 20_000;
type AccountUnavailableHandler = () => void | Promise<void>;
let accountUnavailableHandler: AccountUnavailableHandler | null = null;

/**
 * Registers the process-wide terminal auth boundary used by low-level API
 * helpers (uploads included). The returned disposer only removes its own
 * registration, so a remounted AuthProvider cannot be cleared by an old one.
 */
export function registerAccountUnavailableHandler(
  handler: AccountUnavailableHandler,
): () => void {
  accountUnavailableHandler = handler;
  return () => {
    if (accountUnavailableHandler === handler) accountUnavailableHandler = null;
  };
}

export async function apiFetchRaw<T>(
  path: string,
  opts: ApiFetchOptions,
): Promise<T> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (opts.token) headers.Authorization = `Bearer ${opts.token}`;

  let response: Response;
  let data: unknown = null;
  let timeoutId: ReturnType<typeof setTimeout> | null = null;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_API_TIMEOUT_MS;
  const controller = timeoutMs > 0 ? new AbortController() : null;
  try {
    const requestPromise = (async (): Promise<{ response: Response; data: unknown }> => {
      const nextResponse = await fetch(opts.baseUrl + path, {
        method: opts.method ?? 'GET',
        headers,
        body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
        signal: controller?.signal,
      });
      let nextData: unknown = null;
      try {
        nextData = await nextResponse.json();
      } catch {
        nextData = null;
      }
      return { response: nextResponse, data: nextData };
    })();
    const result = timeoutMs > 0
      ? await Promise.race([
        requestPromise,
        new Promise<never>((_, reject) => {
          timeoutId = setTimeout(() => {
            void requestPromise.catch(() => undefined);
            reject(new ApiError('REQUEST_TIMEOUT', 0, i18n.t('apiErrors.requestTimeout')));
            controller?.abort();
          }, timeoutMs);
        }),
      ])
      : await requestPromise;
    response = result.response;
    data = result.data;
  } catch (err) {
    if (err instanceof ApiError) throw err;
    if (isAbortError(err)) {
      throw new ApiError('REQUEST_TIMEOUT', 0, i18n.t('apiErrors.requestTimeout'));
    }
    if (err instanceof TypeError) {
      // fetch 的网络层失败统一走类型化离线错误:RN 离线抛 "Network request failed"
      // (不含 "fetch" 子串,旧分支匹配不到,英文原文会一路透传到 UI);浏览器
      // (Web 预览)抛 "Failed to fetch",还可能是 CORS——只在 web 环境附加提示。
      const webHint = typeof document !== 'undefined'
        ? i18n.t('apiErrors.networkUnavailableWebHint')
        : '';
      throw new ApiError('NETWORK_UNAVAILABLE', 0, i18n.t('apiErrors.networkUnavailable', { webHint }));
    }
    throw err;
  } finally {
    if (timeoutId) clearTimeout(timeoutId);
  }

  if (!response.ok) {
    const error = readError(data);
    const code = error.code ?? `HTTP_${response.status}`;
    if (response.status === 401 && code === 'ACCOUNT_UNAVAILABLE') {
      try {
        await accountUnavailableHandler?.();
      } catch {
        // Preserve the original typed API error even if local cleanup fails.
      }
    }
    throw new ApiError(code, response.status, error.message ?? i18n.t('apiErrors.requestFailed'));
  }

  return data as T;
}

function isAbortError(err: unknown): boolean {
  return !!err && typeof err === 'object' && 'name' in err && err.name === 'AbortError';
}

function readError(data: unknown): { code?: string; message?: string } {
  if (!data || typeof data !== 'object') return {};
  const payload = data as Record<string, unknown>;
  const nested = payload.error;
  const record = nested && typeof nested === 'object'
    ? nested as Record<string, unknown>
    : payload;
  return {
    code: typeof record.code === 'string' ? record.code : undefined,
    message: typeof record.message === 'string' ? record.message : undefined,
  };
}
