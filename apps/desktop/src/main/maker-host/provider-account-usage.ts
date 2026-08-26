import { createHash } from 'node:crypto';

import {
  storedCustomProviderId,
  type AgentKind,
  type CustomProviderConfig,
  type ProviderAccountUsageIntegrationId,
} from '@cindy/model-providers';

import type {
  DeepSeekAccountUsageSnapshot,
  OpenRouterKeyUsageSnapshot,
  ProviderAccountUsageError,
  ProviderAccountUsageRequest,
  ProviderAccountUsageResult,
  ProviderAccountUsageSnapshot,
} from '../../shared/providerAccountUsage.js';

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const MAX_CACHE_ENTRIES = 64;
const MIN_MANUAL_REFRESH_INTERVAL_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

const INTEGRATIONS: Record<
  ProviderAccountUsageIntegrationId,
  { origin: string; endpoint: string }
> = {
  'deepseek-balance-v1': {
    origin: 'https://api.deepseek.com',
    endpoint: 'https://api.deepseek.com/user/balance',
  },
  'openrouter-key-usage-v1': {
    origin: 'https://openrouter.ai',
    endpoint: 'https://openrouter.ai/api/v1/key',
  },
};

type OwnerStamp = { dataOwnerId: string | null; generation: number };

export interface ProviderAccountUsageServiceDeps {
  getConfig(providerId: string): Promise<CustomProviderConfig | null>;
  readKey(providerId: string, agent: AgentKind): string | null;
  getOwnerStamp(): OwnerStamp;
  getDeviceId(): string;
  getRouteMutationGeneration(providerId: string): number;
  isRouteMutationInProgress(providerId: string): boolean;
  fetchImpl: typeof fetch;
  now(): number;
}

interface ResolvedIdentity {
  cacheKey: string;
  providerId: string;
  agent: AgentKind;
  ownerStamp: OwnerStamp;
  routeGeneration: number;
  integrationId: ProviderAccountUsageIntegrationId;
  endpoint: string;
  key: string;
}

type IdentityResolution =
  | { kind: 'ready'; identity: ResolvedIdentity }
  | { kind: 'result'; result: ProviderAccountUsageResult };

interface CacheRecord {
  snapshot?: ProviderAccountUsageSnapshot;
  expiresAt: number;
  lastAttemptAt: number;
  failures: number;
  retryAt: number;
  lastError?: ProviderAccountUsageError;
}

class AccountUsageRequestError extends Error {
  constructor(
    readonly code: ProviderAccountUsageError,
    readonly retryAt?: number,
  ) {
    super(code);
  }
}

function isFiniteNonNegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function isNullableFiniteNonNegative(value: unknown): value is number | null {
  return value === null || isFiniteNonNegative(value);
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
}

export function parseDeepSeekAccountUsage(
  value: unknown,
  fetchedAt: number,
): DeepSeekAccountUsageSnapshot {
  const fail = (): never => {
    throw new Error('invalid DeepSeek balance response');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const payload = value as Record<string, unknown>;
  if (typeof payload.is_available !== 'boolean' || !Array.isArray(payload.balance_infos)) {
    return fail();
  }
  const balances = payload.balance_infos.map((candidate) => {
    if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return fail();
    const line = candidate as Record<string, unknown>;
    if (
      typeof line.currency !== 'string'
      || line.currency.trim().length === 0
      || line.currency.length > 16
      || !isDecimalString(line.total_balance)
      || !isDecimalString(line.granted_balance)
      || !isDecimalString(line.topped_up_balance)
    ) {
      return fail();
    }
    return {
      currency: line.currency,
      totalBalance: line.total_balance,
      grantedBalance: line.granted_balance,
      toppedUpBalance: line.topped_up_balance,
    };
  });
  return {
    kind: 'deepseek-balance',
    isAvailable: payload.is_available,
    balances,
    fetchedAt,
  };
}

export function parseOpenRouterKeyUsage(
  value: unknown,
  fetchedAt: number,
): OpenRouterKeyUsageSnapshot {
  const fail = (): never => {
    throw new Error('invalid OpenRouter key response');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const data = (value as Record<string, unknown>).data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  const payload = data as Record<string, unknown>;
  const required = [
    'limit',
    'limit_remaining',
    'limit_reset',
    'usage',
    'usage_daily',
    'usage_weekly',
    'usage_monthly',
  ];
  if (required.some((field) => !Object.prototype.hasOwnProperty.call(payload, field))) {
    return fail();
  }
  if (
    !isNullableFiniteNonNegative(payload.limit)
    || !isNullableFiniteNonNegative(payload.limit_remaining)
    || (payload.limit_reset !== null && typeof payload.limit_reset !== 'string')
    || !isFiniteNonNegative(payload.usage)
    || !isFiniteNonNegative(payload.usage_daily)
    || !isFiniteNonNegative(payload.usage_weekly)
    || !isFiniteNonNegative(payload.usage_monthly)
  ) {
    return fail();
  }
  return {
    kind: 'openrouter-key-usage',
    limit: payload.limit,
    limitRemaining: payload.limit_remaining,
    limitReset: payload.limit_reset,
    usage: payload.usage,
    usageDaily: payload.usage_daily,
    usageWeekly: payload.usage_weekly,
    usageMonthly: payload.usage_monthly,
    fetchedAt,
  };
}

async function readBoundedJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => undefined);
    throw new AccountUsageRequestError('invalid-response');
  }
  if (!response.body) throw new AccountUsageRequestError('invalid-response');
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel().catch(() => undefined);
        throw new AccountUsageRequestError('invalid-response');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new AccountUsageRequestError('invalid-response');
  }
}

function retryAfterAt(response: Response, now: number): number | undefined {
  const raw = response.headers.get('retry-after')?.trim();
  if (!raw) return undefined;
  const seconds = Number(raw);
  if (Number.isFinite(seconds) && seconds >= 0) {
    return now + Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
  }
  const date = Date.parse(raw);
  if (!Number.isFinite(date)) return undefined;
  return Math.min(Math.max(date, now), now + MAX_RETRY_AFTER_MS);
}

function backoffMs(failures: number): number {
  return Math.min(30_000 * 2 ** Math.max(0, failures - 1), 5 * 60_000);
}

function sameOwner(left: OwnerStamp, right: OwnerStamp): boolean {
  return left.dataOwnerId === right.dataOwnerId && left.generation === right.generation;
}

function identityDigest(parts: unknown[]): string {
  return createHash('sha256').update(JSON.stringify(parts)).digest('hex');
}

export function createProviderAccountUsageService(deps: ProviderAccountUsageServiceDeps): {
  read(input: ProviderAccountUsageRequest): Promise<ProviderAccountUsageResult>;
} {
  const cache = new Map<string, CacheRecord>();
  const inFlight = new Map<string, Promise<ProviderAccountUsageResult>>();
  let observedOwner: OwnerStamp | undefined;

  const syncOwner = (owner: OwnerStamp): void => {
    if (observedOwner && !sameOwner(observedOwner, owner)) {
      cache.clear();
      inFlight.clear();
    }
    observedOwner = owner;
  };

  const isIdentityCurrent = (identity: ResolvedIdentity): boolean => {
    const owner = deps.getOwnerStamp();
    syncOwner(owner);
    return (
      sameOwner(identity.ownerStamp, owner)
      && !deps.isRouteMutationInProgress(identity.providerId)
      && deps.getRouteMutationGeneration(identity.providerId) === identity.routeGeneration
    );
  };

  const setCacheRecord = (cacheKey: string, record: CacheRecord): void => {
    cache.delete(cacheKey);
    cache.set(cacheKey, record);
    while (cache.size > MAX_CACHE_ENTRIES) {
      const oldestCacheKey = cache.keys().next().value;
      if (oldestCacheKey === undefined) break;
      cache.delete(oldestCacheKey);
    }
  };

  const resolveIdentity = async (
    input: ProviderAccountUsageRequest,
  ): Promise<IdentityResolution> => {
    const providerId = storedCustomProviderId(input.providerId);
    const ownerBefore = deps.getOwnerStamp();
    syncOwner(ownerBefore);
    if (deps.isRouteMutationInProgress(providerId)) {
      return { kind: 'result', result: { status: 'unavailable', error: 'updating' } };
    }
    const routeGeneration = deps.getRouteMutationGeneration(providerId);
    const config = await deps.getConfig(providerId);
    if (
      deps.isRouteMutationInProgress(providerId)
      || deps.getRouteMutationGeneration(providerId) !== routeGeneration
      || !sameOwner(ownerBefore, deps.getOwnerStamp())
    ) {
      return { kind: 'result', result: { status: 'unavailable', error: 'updating' } };
    }
    const runtime = config?.runtimes[input.agent];
    const integrationId = runtime?.accountUsage?.integrationId;
    const integration = integrationId ? INTEGRATIONS[integrationId] : undefined;
    if (!config || !runtime || !integrationId || !integration) {
      return { kind: 'result', result: { status: 'unsupported' } };
    }
    if (config.auth && config.auth.method !== 'apiKey') {
      return { kind: 'result', result: { status: 'unsupported' } };
    }
    let runtimeUrl: URL;
    try {
      runtimeUrl = new URL(runtime.baseUrl);
    } catch {
      return { kind: 'result', result: { status: 'unsupported' } };
    }
    if (
      runtimeUrl.protocol !== 'https:'
      || runtimeUrl.username
      || runtimeUrl.password
      || runtimeUrl.origin !== integration.origin
    ) {
      return { kind: 'result', result: { status: 'unsupported' } };
    }
    const key = deps.readKey(providerId, input.agent);
    if (!key) {
      return { kind: 'result', result: { status: 'unavailable', error: 'no-credentials' } };
    }
    if (
      deps.isRouteMutationInProgress(providerId)
      || deps.getRouteMutationGeneration(providerId) !== routeGeneration
      || !sameOwner(ownerBefore, deps.getOwnerStamp())
    ) {
      return { kind: 'result', result: { status: 'unavailable', error: 'updating' } };
    }
    return {
      kind: 'ready',
      identity: {
        cacheKey: identityDigest([
          ownerBefore.dataOwnerId,
          ownerBefore.generation,
          deps.getDeviceId(),
          providerId,
          input.agent,
          integrationId,
          routeGeneration,
          runtime,
          createHash('sha256').update(key).digest('hex'),
        ]),
        providerId,
        agent: input.agent,
        ownerStamp: ownerBefore,
        routeGeneration,
        integrationId,
        endpoint: integration.endpoint,
        key,
      },
    };
  };

  const fetchSnapshot = async (identity: ResolvedIdentity): Promise<ProviderAccountUsageSnapshot> => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      let response: Response;
      try {
        response = await deps.fetchImpl(identity.endpoint, {
          method: 'GET',
          redirect: 'error',
          headers: {
            accept: 'application/json',
            authorization: `Bearer ${identity.key}`,
          },
          signal: controller.signal,
        });
      } catch {
        throw new AccountUsageRequestError('network');
      }
      const now = deps.now();
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        if (response.status === 401 || response.status === 403) {
          throw new AccountUsageRequestError('auth');
        }
        if (response.status === 429) {
          throw new AccountUsageRequestError('rate-limited', retryAfterAt(response, now));
        }
        if (response.status >= 500) throw new AccountUsageRequestError('server');
        throw new AccountUsageRequestError('invalid-response');
      }
      const payload = await readBoundedJson(response);
      try {
        return identity.integrationId === 'deepseek-balance-v1'
          ? parseDeepSeekAccountUsage(payload, now)
          : parseOpenRouterKeyUsage(payload, now);
      } catch (error) {
        if (error instanceof AccountUsageRequestError) throw error;
        throw new AccountUsageRequestError('invalid-response');
      }
    } finally {
      clearTimeout(timeout);
    }
  };

  const runFetch = (
    input: ProviderAccountUsageRequest,
    identity: ResolvedIdentity,
    record: CacheRecord,
  ): Promise<ProviderAccountUsageResult> => {
    const promise = (async (): Promise<ProviderAccountUsageResult> => {
      record.lastAttemptAt = deps.now();
      try {
        const snapshot = await fetchSnapshot(identity);
        const current = await resolveIdentity(input);
        if (
          current.kind !== 'ready'
          || current.identity.cacheKey !== identity.cacheKey
          || !isIdentityCurrent(identity)
        ) {
          return { status: 'unavailable', error: 'superseded' };
        }
        setCacheRecord(identity.cacheKey, {
          snapshot,
          expiresAt: deps.now() + CACHE_TTL_MS,
          lastAttemptAt: record.lastAttemptAt,
          failures: 0,
          retryAt: 0,
        });
        return { status: 'ready', snapshot, stale: false };
      } catch (error) {
        const current = await resolveIdentity(input);
        if (
          current.kind !== 'ready'
          || current.identity.cacheKey !== identity.cacheKey
          || !isIdentityCurrent(identity)
        ) {
          return { status: 'unavailable', error: 'superseded' };
        }
        const requestError =
          error instanceof AccountUsageRequestError
            ? error
            : new AccountUsageRequestError('network');
        record.failures += 1;
        record.expiresAt = 0;
        record.lastError = requestError.code;
        const backoffRetryAt = deps.now() + backoffMs(record.failures);
        record.retryAt = Math.max(requestError.retryAt ?? 0, backoffRetryAt);
        setCacheRecord(identity.cacheKey, record);
        if (record.snapshot) {
          return {
            status: 'ready',
            snapshot: record.snapshot,
            stale: true,
            error: requestError.code,
            retryAt: record.retryAt,
          };
        }
        return {
          status: 'unavailable',
          error: requestError.code,
          retryAt: record.retryAt,
        };
      }
    })();
    inFlight.set(identity.cacheKey, promise);
    const clearInFlight = () => {
      if (inFlight.get(identity.cacheKey) === promise) inFlight.delete(identity.cacheKey);
    };
    void promise.then(clearInFlight, clearInFlight);
    return promise;
  };

  return {
    async read(input: ProviderAccountUsageRequest): Promise<ProviderAccountUsageResult> {
      try {
        const resolved = await resolveIdentity(input);
        if (resolved.kind === 'result') return resolved.result;
        const { identity } = resolved;
        if (!isIdentityCurrent(identity)) {
          return { status: 'unavailable', error: 'superseded' };
        }
        const pending = inFlight.get(identity.cacheKey);
        if (pending) {
          const result = await pending;
          return isIdentityCurrent(identity)
            ? result
            : { status: 'unavailable', error: 'superseded' };
        }
        const now = deps.now();
        const record = cache.get(identity.cacheKey) ?? {
          expiresAt: 0,
          lastAttemptAt: Number.NEGATIVE_INFINITY,
          failures: 0,
          retryAt: 0,
        };
        if (!input.forceRefresh && record.snapshot && now < record.expiresAt) {
          return { status: 'ready', snapshot: record.snapshot, stale: false };
        }
        if (now < record.retryAt) {
          if (record.snapshot) {
            return {
              status: 'ready',
              snapshot: record.snapshot,
              stale: true,
              ...(record.lastError ? { error: record.lastError } : {}),
              retryAt: record.retryAt,
            };
          }
          return {
            status: 'unavailable',
            error: record.lastError ?? 'throttled',
            retryAt: record.retryAt,
          };
        }
        if (input.forceRefresh && now - record.lastAttemptAt < MIN_MANUAL_REFRESH_INTERVAL_MS) {
          if (record.snapshot) {
            return { status: 'ready', snapshot: record.snapshot, stale: false };
          }
          return {
            status: 'unavailable',
            error: 'throttled',
            retryAt: record.lastAttemptAt + MIN_MANUAL_REFRESH_INTERVAL_MS,
          };
        }
        const result = await runFetch(input, identity, record);
        return isIdentityCurrent(identity)
          ? result
          : { status: 'unavailable', error: 'superseded' };
      } catch {
        return { status: 'unavailable', error: 'unknown' };
      }
    },
  };
}
