/**
 * xaiSubscriptionUsage(main) — 拉取 SuperGrok 账号周用量。
 *
 * 配额权威源只有 settings + billing?format=credits,共用独立超时信号。
 * /v1/user 与 userinfo 是可选 identity:独立短超时,失败或超时不得 abort 配额请求。
 *
 * 请求头与模型发现共用 buildXaiCliProxyHeaders。邮箱/姓名/完整响应当场丢弃。
 * settings/billing 的 401/403/429 才控制配额可用性;5xx / 半成功无字段返回 null 保缓存。
 * 仅当 currentPeriod.type=USAGE_PERIOD_TYPE_WEEKLY、窗口未结束、
 * 且响应里没有 creditUsagePercent 键时,视为 0%(重置后常见)。
 * 字段在但解不出数,仍当残缺 200 保缓存。
 */

import { createHash } from 'node:crypto';

import { createLogger } from '../logger.js';
import {
  XAI_ACCOUNT_USER_URL,
  buildXaiCliProxyHeaders,
} from '../maker-host/model-discovery/xai.js';
import {
  buildXaiSubscriptionUsageSnapshot,
  parseXaiBillingCreditsConfig,
  parseXaiSettingsPlanLabel,
  type XaiSubscriptionUsageSnapshot,
} from '../../shared/xaiSubscriptionUsage.js';

const log = createLogger('usage:xai-subscription');

const XAI_SETTINGS_URL = 'https://cli-chat-proxy.grok.com/v1/settings';
const XAI_BILLING_CREDITS_URL = 'https://cli-chat-proxy.grok.com/v1/billing?format=credits';
const XAI_USERINFO_URL = 'https://auth.x.ai/oauth2/userinfo';
const XAI_SUB_FINGERPRINT_SALT = 'cindy-xai-subscription-sub-fp-v1';
const QUOTA_FETCH_TIMEOUT_MS = 8_000;
const IDENTITY_FETCH_TIMEOUT_MS = 2_500;

export class XaiSubscriptionUsageUnauthorizedError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`xAI subscription usage unauthorized (${status})`);
    this.name = 'XaiSubscriptionUsageUnauthorizedError';
    this.status = status;
  }
}

export class XaiSubscriptionUsageRateLimitedError extends Error {
  constructor() {
    super('xAI subscription usage rate limited (429)');
    this.name = 'XaiSubscriptionUsageRateLimitedError';
  }
}

export const XAI_SUBSCRIPTION_USAGE_EMPTY = 'empty' as const;
export type XaiSubscriptionUsageFetchResult =
  | XaiSubscriptionUsageSnapshot
  | typeof XAI_SUBSCRIPTION_USAGE_EMPTY
  | null;

export function fingerprintXaiSubject(sub: string): string {
  return createHash('sha256')
    .update(`${XAI_SUB_FINGERPRINT_SALT}:${sub}`)
    .digest('hex')
    .slice(0, 16);
}

function throwIfQuotaFatalStatus(status: number): void {
  if (status === 401 || status === 403) {
    throw new XaiSubscriptionUsageUnauthorizedError(status);
  }
  if (status === 429) {
    throw new XaiSubscriptionUsageRateLimitedError();
  }
}

async function readQuotaJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<{ ok: boolean; data: unknown }> {
  const res = await fetchFn(url, {
    method: 'GET',
    headers,
    signal,
  });
  throwIfQuotaFatalStatus(res.status);
  if (!res.ok) return { ok: false, data: null };
  try {
    return { ok: true, data: await res.json() };
  } catch {
    return { ok: false, data: null };
  }
}

async function readIdentityJson(
  fetchFn: typeof fetch,
  url: string,
  headers: Record<string, string>,
  signal: AbortSignal,
): Promise<unknown> {
  try {
    const res = await fetchFn(url, {
      method: 'GET',
      headers,
      signal,
    });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

function subjectFromUserinfo(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const sub = (data as { sub?: unknown }).sub;
  return typeof sub === 'string' && sub.trim().length > 0 ? sub.trim() : null;
}

function userIdFromAccountUser(data: unknown): string | null {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return null;
  const userId = (data as { userId?: unknown }).userId;
  return typeof userId === 'string' && userId.trim().length > 0 ? userId.trim() : null;
}

export async function fetchXaiSubscriptionUsageSnapshot(opts: {
  accessToken: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
  identityTimeoutMs?: number;
  now?: number;
}): Promise<XaiSubscriptionUsageFetchResult> {
  const quotaController = new AbortController();
  const identityController = new AbortController();
  const quotaTimeout = setTimeout(
    () => quotaController.abort(),
    opts.timeoutMs ?? QUOTA_FETCH_TIMEOUT_MS,
  );
  const identityTimeout = setTimeout(
    () => identityController.abort(),
    opts.identityTimeoutMs ?? IDENTITY_FETCH_TIMEOUT_MS,
  );
  const fetchFn = opts.fetchFn ?? fetch;
  const now = opts.now ?? Date.now();
  const baseHeaders = buildXaiCliProxyHeaders(opts.accessToken);
  try {
    // 配额与 identity 同时发出。identity 即使先返回 userId,也不回头改配额请求:
    // billing/settings 无 x-userid 已实测可用,不能让 /v1/user 拖住或 abort 配额。
    const accountUserPromise = readIdentityJson(
      fetchFn,
      XAI_ACCOUNT_USER_URL,
      baseHeaders,
      identityController.signal,
    );
    const userinfoPromise = readIdentityJson(
      fetchFn,
      XAI_USERINFO_URL,
      baseHeaders,
      identityController.signal,
    );
    const [settings, credits] = await Promise.all([
      readQuotaJson(fetchFn, XAI_SETTINGS_URL, baseHeaders, quotaController.signal),
      readQuotaJson(fetchFn, XAI_BILLING_CREDITS_URL, baseHeaders, quotaController.signal),
    ]);
    const [accountUser, userinfo] = await Promise.all([accountUserPromise, userinfoPromise]);
    void userIdFromAccountUser(accountUser);

    const planLabel = parseXaiSettingsPlanLabel(settings.data);
    const parsedCredits = parseXaiBillingCreditsConfig(credits.data, now);
    const subject = subjectFromUserinfo(userinfo);
    if (
      !settings.ok
      || !credits.ok
      || !parsedCredits
      || typeof parsedCredits.creditUsagePercent !== 'number'
    ) {
      // 权威端点失败,或 200 但没有仍开放的 weekly currentPeriod 可推出百分比:
      // 残缺快照不能盖掉缓存。明确的未结束周窗口省略该字段已在 parse 里当成 0%。
      return null;
    }
    const snapshot = buildXaiSubscriptionUsageSnapshot({
      planLabel,
      credits: parsedCredits,
      accountFingerprint: subject ? fingerprintXaiSubject(subject) : null,
      now,
    });
    if (!snapshot) {
      // 两个权威端点都成功但解析不出字段 → empty(清缓存)。任一非 ok 当瞬时失败保缓存。
      if (settings.ok) {
        log.warn('xAI subscription usage response had no parsable plan or weekly window');
        return XAI_SUBSCRIPTION_USAGE_EMPTY;
      }
      return null;
    }
    return snapshot;
  } catch (err) {
    if (
      err instanceof XaiSubscriptionUsageUnauthorizedError
      || err instanceof XaiSubscriptionUsageRateLimitedError
    ) {
      throw err;
    }
    log.warn('xAI subscription usage fetch failed', {
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(quotaTimeout);
    clearTimeout(identityTimeout);
    if (!quotaController.signal.aborted) quotaController.abort();
    if (!identityController.signal.aborted) identityController.abort();
  }
}
