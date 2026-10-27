/**
 * provider-account-usage —— API Key 供应商账户余额查询（设置页余额卡的数据源）。
 *
 * 设计要点：
 *   - **端点钉死在 main**：integration 表是硬编码的官方端点（deepseek →
 *     `https://api.deepseek.com/user/balance`）。renderer 只传 providerId，不传 URL；
 *     key 只发给官方端点，永远不会发到用户配置的第三方代理。
 *   - **按官方 origin 认领**：只有当供应商某个 runtime 的 baseUrl origin 与官方端点
 *     origin 一致且鉴权方式是 apiKey 时才启用。走代理 / 自定义域名的连接不查（key 属于
 *     代理，不属于官方账户）；这也让官方预设创建的老连接无需迁移就能直接生效。
 *   - **key 读取器注入**：同 provider-diagnostics 的 setDiagnosticsKeyReader 模式，模块
 *     不直接 import safeStorage（maker-host 不触电 Electron），host 注册期接通。
 *   - 查询型结果：失败不 throw，映射为 ProviderAccountUsageError（规则 13 例外条款）。
 *   - 缓存：TTL 5 分钟内存缓存；手动刷新受 15s 节流；账号切换（owner / generation 变化）
 *     整体失效。缓存键含 providerId + agent，换 runtime 配置不串数据。
 */

import { createHash } from 'node:crypto';

import type { AgentKind, Provider } from '@cindy/model-providers';

import {
  PROVIDER_ACCOUNT_USAGE_AGENTS,
  getProviderAccountUsageDashboardUrl,
  type DeepSeekAccountUsageSnapshot,
  type ProviderAccountUsageError,
  type ProviderAccountUsageRequest,
  type ProviderAccountUsageResult,
  type ProviderAccountUsageSnapshot,
  type ZhipuCodingPlanQuotaSnapshot,
} from '../../shared/providerAccountUsage.js';
import { createMakerLogger } from './logger-adapter.js';

const log = createMakerLogger('provider-account-usage');

const MAX_RESPONSE_BYTES = 64 * 1024;
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 5 * 60_000;
const MIN_MANUAL_REFRESH_INTERVAL_MS = 15_000;
const MAX_RETRY_AFTER_MS = 60 * 60_000;

/** 官方账户接口清单。端点是唯一事实源，不从目录 / 用户配置推导。 */
const INTEGRATIONS = {
  'deepseek-balance-v1': {
    origins: ['https://api.deepseek.com'],
    endpoint: 'https://api.deepseek.com/user/balance',
  },
  // 智谱 GLM Coding Plan 额度（GET /api/monitor/usage/quota/limit，裸 key 鉴权）。
  // CN 与 Global 共享路径，端点跟认领到的 runtime 同域；按量付费（/api/paas）不认领。
  'zhipu-coding-plan-quota-v1': {
    origins: ['https://open.bigmodel.cn', 'https://api.z.ai'],
    endpointFor: (origin: string) =>
      origin === 'https://api.z.ai'
        ? 'https://api.z.ai/api/monitor/usage/quota/limit'
        : 'https://open.bigmodel.cn/api/monitor/usage/quota/limit',
    // Coding Plan 专属接入路径：/api/anthropic（cc）或 /api/coding/*（codex/pi）。
    // 按量付费连接也在这两个域，但路径是 /api/paas/*，不认领。
    pathPrefixes: ['/api/anthropic', '/api/coding/'],
  },
} as const;

export type ProviderAccountUsageIntegrationId = keyof typeof INTEGRATIONS;

/** 迭代时的宽化视图（异构配置统一成可选字段集合）。 */
type IntegrationView = {
  origins: readonly string[];
  pathPrefixes?: readonly string[];
  endpoint?: string;
  endpointFor?: (origin: string) => string;
};

/** 该供应商是否命中智谱 GLM Coding Plan 的官方接入端点（设置页给「查看套餐用量」入口用）。 */
export function isZhipuCodingPlanProvider(provider: Provider | undefined | null): boolean {
  if (!provider) return false;
  if (provider.id === 'zhipu-coding-plan-cn' || provider.id === 'zai-coding-plan-global') return true;
  return Object.values(provider.routing).some((route) => {
    const upstream = route?.upstream;
    if (!upstream) return false;
    return (
      upstream === 'https://open.bigmodel.cn/api/anthropic' || upstream === 'https://api.z.ai/api/anthropic'
      || upstream.startsWith('https://open.bigmodel.cn/api/coding/') || upstream.startsWith('https://api.z.ai/api/coding/')
    );
  });
}

export interface ProviderAccountUsageResolution {
  integrationId: ProviderAccountUsageIntegrationId;
  endpoint: string;
  /** key 所属 runtime；与缓存键一起区分不同 runtime 的 key。 */
  agent: AgentKind;
  key: string;
}
type ProviderReader = (providerId: string) => Provider | undefined;
type KeyReader = (providerId: string, agent: AgentKind) => string | null;
type OwnerStampReader = () => { dataOwnerId: string | null; generation: number };

let providerReader: ProviderReader = () => undefined;
let keyReader: KeyReader = () => null;
let ownerStampReader: OwnerStampReader = () => ({ dataOwnerId: null, generation: 0 });
let fetchImpl: typeof fetch = globalThis.fetch;

/** host 注册期接通真实目录读取（active-catalog）。 */
export function setAccountUsageProviderReader(reader: ProviderReader): void {
  providerReader = reader;
}

/** host 注册期接通真实 safeStorage key 读取（provider_key_<id>_<agent>）。 */
export function setAccountUsageKeyReader(reader: KeyReader): void {
  keyReader = reader;
}

/** host 注册期接通账号身份戳（缓存隔离用）。 */
export function setAccountUsageOwnerStampReader(reader: OwnerStampReader): void {
  ownerStampReader = reader;
}

/** 测试注入 fetch。 */
export function setAccountUsageFetch(impl: typeof fetch): void {
  fetchImpl = impl;
}

/** 测试注入时钟。 */
export let accountUsageNow: () => number = Date.now;

export function setAccountUsageNow(now: () => number): void {
  accountUsageNow = now;
}

interface CacheRecord {
  snapshot?: ProviderAccountUsageSnapshot;
  expiresAt: number;
  lastAttemptAt: number;
  lastError?: ProviderAccountUsageError;
  retryAt: number;
}

const cache = new Map<string, CacheRecord>();

class AccountUsageRequestError extends Error {
  constructor(
    readonly code: ProviderAccountUsageError,
    readonly retryAt?: number,
  ) {
    super(code);
  }
}

function isDecimalString(value: unknown): value is string {
  return typeof value === 'string' && /^-?\d+(?:\.\d+)?$/.test(value);
}

/** 解析并校验 DeepSeek `/user/balance` 响应；字段缺失 / 形状不符直接抛错（invalid-response）。 */
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
  return { kind: 'deepseek-balance', isAvailable: payload.is_available, balances, fetchedAt };
}

/**
 * 认领规则：apiKey 鉴权 + 某 runtime 的 baseUrl 与官方端点同域且路径匹配。
 * https 之外一律不认领（规则同 provider-route 的上游判定，不做子串包含）。
 * 智谱只认领 Coding Plan 接入路径，按量付费（/api/paas）同域也不认领。
 */
export function resolveProviderAccountUsage(
  providerId: string,
  agent?: AgentKind,
): ProviderAccountUsageResolution | null {
  const provider = providerReader(providerId);
  if (!provider || provider.auth.method !== 'apiKey') return null;
  // 指定 agent 时只认领该 runtime：同一供应商各引擎可用不同账户的独立密钥，
  // 会话查询必须对准当前会话实际路由的账户。
  const agents = agent ? [agent] : PROVIDER_ACCOUNT_USAGE_AGENTS;
  for (const agent of agents) {
    const upstream = provider.routing[agent]?.upstream;
    if (!upstream) continue;
    let url: URL;
    try {
      url = new URL(upstream);
    } catch {
      continue;
    }
    if (url.protocol !== 'https:') continue;
    const origin = url.origin;
    for (const [integrationId, integration] of Object.entries(INTEGRATIONS) as [
      ProviderAccountUsageIntegrationId,
      IntegrationView,
    ][]) {
      if (!integration.origins.includes(origin)) continue;
      if (
        integration.pathPrefixes
        && !integration.pathPrefixes.some((p) => url.pathname === p || url.pathname.startsWith(p))
      ) {
        continue;
      }
      const key = keyReader(providerId, agent)?.trim();
      if (!key) continue;
      const endpoint = integration.endpointFor
        ? integration.endpointFor(origin)
        : integration.endpoint!;
      return { integrationId, endpoint, agent, key };
    }
  }
  return null;
}

/** key 归属该 provider 的哪个 runtime 都不关键；额度对全账号生效，取任一可用 key。 */
export function providerAccountUsageSupported(providerId: string): boolean {
  const provider = providerReader(providerId);
  if (!provider || provider.auth.method !== 'apiKey') return false;
  return PROVIDER_ACCOUNT_USAGE_AGENTS.some((agent) => {
    const upstream = provider.routing[agent]?.upstream;
    if (!upstream) return false;
    return matchesAnyIntegration(upstream);
  });
}

function matchesAnyIntegration(upstream: string): boolean {
  let url: URL;
  try {
    url = new URL(upstream);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  return Object.values(INTEGRATIONS).some((integration) => {
    const view = integration as IntegrationView;
    if (!view.origins.includes(url.origin)) return false;
    if (view.pathPrefixes) {
      return view.pathPrefixes.some((p) => url.pathname === p || url.pathname.startsWith(p));
    }
    return true;
  });
}

function mapHttpStatusToError(status: number): ProviderAccountUsageError | null {
  if (status === 401 || status === 403) return 'auth';
  if (status === 429) return 'rate-limited';
  if (status >= 500) return 'server';
  return null;
}

/**
 * 解析智谱 /api/monitor/usage/quota/limit 响应。
 * 按量付费账户回 200 + 业务错误（success:false 且 msg 提到没有 coding plan）→ noPlan
 * 快照（不是故障）；其余业务错误 → invalid-response。
 */
export function parseZhipuCodingPlanQuota(
  value: unknown,
  fetchedAt: number,
): ZhipuCodingPlanQuotaSnapshot {
  const fail = (): never => {
    throw new Error('invalid Zhipu coding plan quota response');
  };
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  const body = value as Record<string, unknown>;
  if (body.success === false) {
    const msg = typeof body.msg === 'string' ? body.msg : '';
    const compact = msg.replace(/[\s_-]/g, '').toLowerCase();
    if (
      compact.includes('codingplan')
      && /不存在|没有|未开通|not exist|not found|not have|doesn't have|no coding plan|not subscribed/.test(msg)
    ) {
      return { kind: 'zhipu-coding-plan-quota', noPlan: true, level: null, fiveHour: null, weekly: null, fetchedAt };
    }
    return fail();
  }
  const data = body.data;
  if (!data || typeof data !== 'object' || Array.isArray(data)) return fail();
  const payload = data as Record<string, unknown>;
  const level = typeof payload.level === 'string' && payload.level.trim() ? payload.level.trim() : null;
  const limits = Array.isArray(payload.limits) ? payload.limits : [];
  let fiveHour: ZhipuCodingPlanQuotaSnapshot['fiveHour'] = null;
  let weekly: ZhipuCodingPlanQuotaSnapshot['weekly'] = null;
  const unclassified: { reset: number | null; percent: number }[] = [];
  for (const item of limits) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    const line = item as Record<string, unknown>;
    const type = typeof line.type === 'string' ? line.type.toUpperCase() : '';
    if (type !== 'TOKENS_LIMIT' && type !== 'CREDIT_LIMIT') continue;
    const percent = typeof line.percentage === 'number' && Number.isFinite(line.percentage)
      ? Math.max(0, Math.min(100, line.percentage))
      : null;
    if (percent === null) continue;
    const resetsAt =
      typeof line.nextResetTime === 'number' && Number.isFinite(line.nextResetTime) && line.nextResetTime > 0
        ? line.nextResetTime
        : null;
    const unit = typeof line.unit === 'number' ? line.unit : null;
    // unit 3 = 5 小时窗口、6 = 每周窗口（新套餐 unit 6 的 number 有 7 和 1 两种取值，
    // 只锚 unit）；缺失时兑底见下。
    if (unit === 3 && !fiveHour) fiveHour = { usedPercent: percent, resetsAt };
    else if (unit === 6 && !weekly) weekly = { usedPercent: percent, resetsAt };
    else if (unit == null) unclassified.push({ reset: resetsAt, percent });
  }
  // unit 缺失的兑底（与社区工具同口径）：无 nextResetTime 的条目优先归 5 小时
  // （0% 状态下 5 小时桶可能没有 reset），其余按 reset 升序依次填入空缺槽位——
  // 新套餐周末比 5 小时窗更早重置时，按数组顺序填会标反。
  unclassified.sort((a, b) => {
    const aHas = a.reset === null ? 0 : 1;
    const bHas = b.reset === null ? 0 : 1;
    if (aHas !== bHas) return aHas - bHas;
    return (a.reset ?? 0) - (b.reset ?? 0);
  });
  for (const entry of unclassified) {
    if (!fiveHour) fiveHour = { usedPercent: entry.percent, resetsAt: entry.reset };
    else if (!weekly) weekly = { usedPercent: entry.percent, resetsAt: entry.reset };
  }
  return { kind: 'zhipu-coding-plan-quota', noPlan: false, level, fiveHour, weekly, fetchedAt };
}

function parseRetryAfterMs(header: string | null, now: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
  return now + Math.min(seconds * 1000, MAX_RETRY_AFTER_MS);
}

async function fetchDeepSeekBalance(
  resolution: ProviderAccountUsageResolution,
): Promise<DeepSeekAccountUsageSnapshot> {
  return fetchAccountJson(resolution, `Bearer ${resolution.key}`, parseDeepSeekAccountUsage);
}

async function fetchZhipuCodingPlanQuota(
  resolution: ProviderAccountUsageResolution,
): Promise<ZhipuCodingPlanQuotaSnapshot> {
  // 智谱额度接口用裸 key（不带 Bearer），与 cc 实测一致（Bearer 亦可用，取裸 key 更稳）。
  return fetchAccountJson(resolution, resolution.key, parseZhipuCodingPlanQuota);
}

async function fetchAccountJson<T>(
  resolution: ProviderAccountUsageResolution,
  authorization: string,
  parse: (value: unknown, fetchedAt: number) => T,
): Promise<T> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { Authorization: authorization };
    if (resolution.integrationId === 'zhipu-coding-plan-quota-v1') {
      // 与社区工具（cc-switch）实测口径一致：要求 JSON + 英文文案，响应 msg 语言稳定。
      headers['Content-Type'] = 'application/json';
      headers['Accept-Language'] = 'en-US,en';
    }
    const response = await fetchImpl(resolution.endpoint, { headers, signal: controller.signal });
    const retryAfterMs = parseRetryAfterMs(response.headers.get('retry-after'), accountUsageNow());
    const mapped = mapHttpStatusToError(response.status);
    if (mapped) throw new AccountUsageRequestError(mapped, retryAfterMs);
    const text = await response.text();
    if (text.length > MAX_RESPONSE_BYTES) {
      throw new AccountUsageRequestError('invalid-response');
    }
    let payload: unknown;
    try {
      payload = JSON.parse(text);
    } catch {
      throw new AccountUsageRequestError('invalid-response');
    }
    try {
      return parse(payload, accountUsageNow());
    } catch {
      throw new AccountUsageRequestError('invalid-response');
    }
  } catch (err) {
    if (err instanceof AccountUsageRequestError) throw err;
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new AccountUsageRequestError('network');
    }
    throw new AccountUsageRequestError('network');
  } finally {
    clearTimeout(timer);
  }
}

/** 查询入口：unsupported / unavailable / ready 三态。网络失败时回落过期快照（stale）。 */
export async function readProviderAccountUsage(
  request: ProviderAccountUsageRequest,
): Promise<ProviderAccountUsageResult> {
  const ownerStamp = ownerStampReader();
  const resolution = resolveProviderAccountUsage(request.providerId, request.agent);
  if (!resolution) {
    // 没认领到官方端点，或 key 读不到。区分「本来就没有接口」与「有接口但 key 缺失」。
    if (providerAccountUsageSupported(request.providerId)) {
      return { status: 'unavailable', error: 'no-credentials' };
    }
    return { status: 'unsupported' };
  }
  const result = await readResolvedAccountUsage(request, resolution, ownerStamp);
  return { ...result, dashboardUrl: getProviderAccountUsageDashboardUrl(resolution.endpoint) };
}

async function readResolvedAccountUsage(
  request: ProviderAccountUsageRequest,
  resolution: ProviderAccountUsageResolution,
  ownerStamp: ReturnType<OwnerStampReader>,
): Promise<ProviderAccountUsageResult> {
  // 缓存键含凭证指纹：同一供应商下换 key（不同账户）后旧账户快照绝不复用。
  const keyFingerprint = createHash('sha256').update(resolution.key).digest('hex').slice(0, 12);
  const cacheKey = `${ownerStamp.dataOwnerId ?? 'local'}:${ownerStamp.generation}:${request.providerId}:${resolution.integrationId}:${resolution.endpoint}:${resolution.agent}:${keyFingerprint}`;
  const now = accountUsageNow();
  const record = cache.get(cacheKey);
  const manualRefreshBlocked =
    request.forceRefresh === true
    && record !== undefined
    && now - record.lastAttemptAt < MIN_MANUAL_REFRESH_INTERVAL_MS;
  // 限流窗口内不发起请求：有旧快照就回 stale，否则报 throttled（Retry-After 生效）。
  if (record?.retryAt && now < record.retryAt) {
    if (record.snapshot) {
      return {
        status: 'ready',
        snapshot: record.snapshot,
        stale: true,
        error: 'rate-limited',
        retryAt: record.retryAt,
        agent: resolution.agent,
      };
    }
    return { status: 'unavailable', error: 'throttled', retryAt: record.retryAt };
  }
  if (manualRefreshBlocked && record.snapshot && record.expiresAt > now) {
    return { status: 'ready', snapshot: record.snapshot, stale: false, agent: resolution.agent };
  }
  if (
    !request.forceRefresh
    && record?.snapshot
    && record.expiresAt > now
    && record.lastError === undefined
  ) {
    return { status: 'ready', snapshot: record.snapshot, stale: false, agent: resolution.agent };
  }
  try {
    const snapshot =
      resolution.integrationId === 'zhipu-coding-plan-quota-v1'
        ? await fetchZhipuCodingPlanQuota(resolution)
        : await fetchDeepSeekBalance(resolution);
    cache.set(cacheKey, {
      snapshot,
      expiresAt: accountUsageNow() + CACHE_TTL_MS,
      lastAttemptAt: accountUsageNow(),
      retryAt: 0,
    });
    return { status: 'ready', snapshot, stale: false, agent: resolution.agent };
  } catch (err) {
    const code = err instanceof AccountUsageRequestError ? err.code : 'unknown';
    log.warn(
      'provider account usage fetch failed',
      { providerId: request.providerId, integrationId: resolution.integrationId, code },
    );
    // 等待上游期间其它查询可能已更新同一账户；迟到失败不能覆盖该记录，
    // 也不能把新余额/TTL/限流状态回退到本次请求开始前的值。
    let latest = cache.get(cacheKey);
    const retryAt = Math.max(
      latest?.retryAt ?? 0,
      err instanceof AccountUsageRequestError ? err.retryAt ?? 0 : 0,
    );
    if (latest && latest !== record) {
      // 仅合并更长的上游等待时间；新余额、有效期与其它并行写入字段保持原值。
      if (retryAt > latest.retryAt) {
        latest = { ...latest, retryAt };
        cache.set(cacheKey, latest);
      }
      const waiting = retryAt > accountUsageNow();
      const error = waiting ? 'rate-limited' : latest.lastError;
      if (latest.snapshot) {
        return {
          status: 'ready', snapshot: latest.snapshot,
          stale: latest.expiresAt <= accountUsageNow() || error !== undefined,
          ...(error ? { error } : {}),
          ...(waiting ? { retryAt } : {}),
          agent: resolution.agent,
        };
      }
      return { status: 'unavailable', error: waiting ? 'throttled' : error ?? code, ...(waiting ? { retryAt } : {}) };
    }
    cache.set(cacheKey, {
      snapshot: record?.snapshot,
      expiresAt: record?.expiresAt ?? 0,
      lastAttemptAt: now,
      lastError: code,
      retryAt,
    });
    if (
      err instanceof AccountUsageRequestError
      && err.code === 'rate-limited'
      && request.forceRefresh
    ) {
      return { status: 'unavailable', error: 'throttled', retryAt: err.retryAt };
    }
    const fallback = record?.snapshot;
    if (fallback) {
      return { status: 'ready', snapshot: fallback, stale: true, error: code, agent: resolution.agent };
    }
    return { status: 'unavailable', error: code };
  }
}

/** 测试辅助：清空缓存与注入重置。 */
export function resetProviderAccountUsageForTest(): void {
  cache.clear();
  providerReader = () => undefined;
  keyReader = () => null;
  ownerStampReader = () => ({ dataOwnerId: null, generation: 0 });
  fetchImpl = globalThis.fetch;
  accountUsageNow = Date.now;
}
