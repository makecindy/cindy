/**
 * 读写 Chat Server 账号私有的 preferences(同账号中转目录,格式见 `@cindy/device-link` 的
 * relayAccountDirectory.ts)。不带 `X-Chat-Actor`,读写的就是这个账号本人的记录,别的账号读不到。
 *
 * 只在需要时请求:主人电脑在正在用的中转变化时写一次、收到变更通知时读一次;加入方在打开中转页
 * 与等待主人回写链接时读。写入带 revision,与其他设备同时写时重读后重试。
 */
import { randomUUID } from 'node:crypto';
import { getAccessToken, refresh } from '../authManager.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { outboundFetch } from '../maker-host/outbound-fetch.desktop.js';

const REQUEST_TIMEOUT_MS = 10_000;
const MAX_WRITE_ATTEMPTS = 4;

export class AccountPreferenceError extends Error {
  constructor(readonly code: string, readonly status?: number) {
    super(code);
    this.name = 'AccountPreferenceError';
  }
}

async function request(path: string, init: { method: 'GET' | 'POST'; body?: unknown }, retried = false): Promise<unknown> {
  const base = getClientEndpoint('chatApiBaseUrl');
  if (!base) throw new AccountPreferenceError('UNAVAILABLE');
  const token = getAccessToken();
  if (!token) throw new AccountPreferenceError('AUTH_REQUIRED');
  const res = await outboundFetch(`${base.replace(/\/+$/, '')}/v1${path}`, {
    method: init.method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(init.body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  // 令牌刚好过期:刷新一次再试,与 Chat Server 客户端一致;刷新失败不登出账号。
  if (res.status === 401 && !retried && (await refresh().catch(() => false))) return request(path, init, true);
  const body = (await res.json().catch(() => null)) as { error?: { code?: unknown } } | null;
  if (!res.ok) {
    const code = typeof body?.error?.code === 'string' ? body.error.code : 'FAILED';
    throw new AccountPreferenceError(code, res.status);
  }
  return body;
}

export async function readAccountPreference(key: string): Promise<{ value: unknown; revision: number }> {
  // `?key=` 只读这一条;旧版服务忽略它、返回全部记录,这里照样按 key 挑出来。
  const rows = await request(`/preferences?key=${encodeURIComponent(key)}`, { method: 'GET' });
  const row = Array.isArray(rows)
    ? (rows as Array<{ key?: unknown; value?: unknown; revision?: unknown }>).find((item) => item?.key === key)
    : undefined;
  return { value: row?.value ?? null, revision: typeof row?.revision === 'number' ? row.revision : 0 };
}

/**
 * 读出当前值交给 `update`,写回它返回的新值;返回 `undefined` 表示不用改。
 * 别的设备同时写入时(REVISION_CONFLICT)按新值重来,最多几次。
 */
export async function updateAccountPreference(key: string, update: (value: unknown) => unknown): Promise<void> {
  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt += 1) {
    const { value, revision } = await readAccountPreference(key);
    const next = update(value);
    if (next === undefined) return;
    try {
      await request('/preferences', {
        method: 'POST',
        body: { operationId: `relay.${randomUUID()}`, key, expectedRevision: revision, value: next },
      });
      return;
    } catch (error) {
      if (error instanceof AccountPreferenceError && error.code === 'REVISION_CONFLICT') continue;
      throw error;
    }
  }
  throw new AccountPreferenceError('REVISION_CONFLICT');
}
