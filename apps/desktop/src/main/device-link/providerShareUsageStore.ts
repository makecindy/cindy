/**
 * 供应商分享的用量账本(分享者电脑上)：按(日期、分享、受邀者、Agent、供应商、模型)聚合 token 与轮次。
 *
 * 每行另带 `byMember`：这一行里各台组内电脑分别用了多少(组内电脑的稳定键，本机是 `local`，转给组内电脑的是
 * 那台的键)。行的键与合计仍是原来那套，旧版本读到时照常累计合计、原样带着 `byMember` 写回，降级不丢用量；
 * 合计比各台之和多出来的部分(加这个字段之前记的、降级期间旧版本记的，或单行分布超容量的)读出来算没区分电脑(null)。
 *
 * Agent 在分享者电脑上运行时本机直接记录；委托组内电脑直连时，由执行电脑发送带去重 ID 的用量回执。
 * 文件放在 userData/remote-agent 下，
 * 原子替换写入；分享与成员 id 由服务端生成、全局唯一，查询时只返回当前账号拥有的分享。
 * 删除成员后记录保留(管理页不再显示)；同一人重新加入时服务端沿用原成员 id，用量接续。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

import type { GuestUsageSample } from '../remote-agent/host/guestUsage';

const FILE_VERSION = 1;
const RETAIN_DAYS = 400;
const MAX_ROWS = 20_000;
const MAX_RECENT_USAGE_IDS = 20_000;
const MAX_DIRECT_RECEIPT_ROUTES = 20_000;
const MAX_DIRECT_TASK_LOCATIONS = 20_000;
const MAX_DIRECT_CLEANUP_TARGETS = 20_000;
const DIRECT_RECEIPT_GRACE_MS = 30 * 60_000;
const USAGE_RETRY_DEDUP_MS = DIRECT_RECEIPT_GRACE_MS + 2 * 60_000;
const FLUSH_DELAY_MS = 1_000;
const MEMBER_KEY = /^[A-Za-z0-9_.:-]{1,300}$/;
/** 一行里最多分几台组内电脑(防止损坏的文件无限膨胀)。 */
const MAX_MEMBERS_PER_ROW = 512;

const COUNTERS = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'sdkCostUsd'] as const;
type Counters = Record<(typeof COUNTERS)[number], number>;

export interface ProviderShareUsageRow extends Counters {
  day: string;
  shareId: string;
  memberId: string;
  kind: string;
  providerId: string | null;
  model: string;
  lastAt: number;
  /** 各台组内电脑分别用了多少；没有这个字段的旧行全部算没区分电脑。 */
  byMember?: Record<string, Counters>;
}

/** Minimal O-issued assignment proof for a delayed, content-free executor receipt. */
export interface ProviderShareDirectReceiptRoute {
  ownerScope: string;
  ownerDeviceId: string;
  shareId: string;
  memberId: string;
  guestDeviceId: string;
  sessionId: string;
  executorDeviceId: string;
  executorProviderId: string;
  agentKind: string;
  providerId: string;
  memberKey: string;
  model: string;
  generation: string;
  expiresAt: number;
  /** Written before M receives the grant; only committed routes accept usage. */
  createdAt?: number;
  committedAt?: number;
  revokedAt?: number;
  /** Exact server membership incarnation, never compared with a local clock. */
  memberJoinedAt?: string;
}

export interface ProviderShareMemberGeneration {
  ownerScope: string;
  ownerDeviceId: string;
  shareId: string;
  memberId: string;
  joinedAt: string;
  present: boolean;
  pendingCleanup: boolean;
  /** Retryable local/legacy relay scopes, saved before runHost may remove its index. */
  cleanupScopes?: Array<{ controller: string; relay?: string }>;
}

export type ProviderShareDirectTaskIdentity = Pick<ProviderShareDirectReceiptRoute,
  'ownerScope' | 'ownerDeviceId' | 'shareId' | 'memberId' | 'guestDeviceId' | 'sessionId'>;

/**
 * Durable native-session whereabouts, NOT an execution grant. O must issue a new
 * short-lived delegation and M must validate it before this location can be used.
 * generation is only a compare-and-clear fence against late fallback/renewal notices.
 */
export interface ProviderShareDirectTaskLocation extends Omit<ProviderShareDirectReceiptRoute,
  'expiresAt' | 'createdAt' | 'committedAt' | 'revokedAt'> {
  committedAt: number;
}

/** O keeps every M that may retain this guest's history until deletion is acknowledged. */
export interface ProviderShareDirectCleanupTarget {
  ownerScope: string;
  shareId: string;
  memberId: string;
  guestDeviceId: string;
  executorDeviceId: string;
  /** Monotonic for this guest/executor; an old forget cannot erase a newer grant. */
  cleanupEpoch: number;
  pendingId?: string;
  cleaned?: boolean;
}

export interface ProviderShareDirectReceipt {
  shareId: string;
  memberId: string;
  guestDeviceId: string;
  sessionId: string;
  generation: string;
  agentKind: string;
  usageId: string;
  samples: readonly GuestUsageSample[];
}

export type ProviderShareUsageRange = '7d' | 'month' | 'all';

export interface ProviderShareModelUsage extends Counters {
  kind: string;
  providerId: string | null;
  /** 在哪台组内电脑运行；null = 没区分电脑。 */
  memberKey: string | null;
  model: string;
}

export interface ProviderShareMemberUsage {
  shareId: string;
  memberId: string;
  lastUsedAt: number | null;
  models: ProviderShareModelUsage[];
}

/** 一个受邀者按天的用量：每天按(Agent、供应商、模型、组内电脑)分行。 */
export interface ProviderShareMemberDailyUsage {
  shareId: string;
  memberId: string;
  lastUsedAt: number | null;
  days: Array<ProviderShareModelUsage & { day: string }>;
}

export interface ProviderShareUsageHistoryOptions {
  /**
   * 最多展开多少条按电脑拆分后的明细。按日期从新到旧遍历原始行，
   * 防止一个长期账本在生成回包前膨胀成数百万条中间对象。
   */
  maxRows?: number;
  /** 仅展开仍在当前分享里的成员；JSON 编码的 [shareId, memberId]。 */
  memberKeys?: ReadonlySet<string>;
}

/** 账本用的本地日期(YYYY-MM-DD)。 */
export function providerUsageLocalDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

const localDay = providerUsageLocalDay;

/** 时间段的起始日期(含)；all 返回 null。 */
export function providerShareUsageRangeStart(range: ProviderShareUsageRange, now = Date.now()): string | null {
  if (range === 'all') return null;
  const date = new Date(now);
  if (range === 'month') return localDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime());
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 6).getTime());
}

const isCount = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;

function emptyCounters(): Counters {
  return { turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0 };
}

function addCounters(target: Counters, source: Counters): void {
  for (const key of COUNTERS) target[key] += source[key];
}

/** 读盘时校验 `byMember`；超出容量时保留前面的分布，其余算没区分电脑，合计不受影响。 */
function parseByMember(value: unknown): Record<string, Counters> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined;
  const entries = Object.entries(value as Record<string, unknown>);
  const out: Record<string, Counters> = Object.create(null);
  for (const [key, counters] of entries.slice(0, MAX_MEMBERS_PER_ROW)) {
    if (!MEMBER_KEY.test(key) || !counters || typeof counters !== 'object') return undefined;
    const record = counters as Record<string, unknown>;
    if (!COUNTERS.every((field) => isCount(record[field]))) return undefined;
    out[key] = Object.fromEntries(COUNTERS.map((field) => [field, record[field] as number])) as Counters;
  }
  return out;
}

/**
 * 一行按组内电脑拆开：各台的部分，加上合计比各台之和多出来、记为没区分电脑(null)的部分。各台之和不超过合计
 * (降级期间旧版本只加合计；防止损坏的文件让某台超过合计)。没有用量的部分不返回。
 */
function splitByMember(row: ProviderShareUsageRow): Array<[string | null, Counters]> {
  const parts: Array<[string | null, Counters]> = [];
  const rest: Counters = Object.fromEntries(COUNTERS.map((field) => [field, row[field]])) as Counters;
  for (const [key, counters] of Object.entries(row.byMember ?? {})) {
    const capped = Object.fromEntries(
      COUNTERS.map((field) => [field, Math.min(counters[field], rest[field])]),
    ) as Counters;
    for (const field of COUNTERS) rest[field] -= capped[field];
    parts.push([key, capped]);
  }
  parts.push([null, rest]);
  // 金额相减会留下浮点零头：只有轮次、token 或像样的金额才算有用量。
  return parts.filter(([, counters]) =>
    COUNTERS.some((field) => (field === 'sdkCostUsd' ? counters[field] > 1e-9 : counters[field] > 0)));
}

function parseRow(value: unknown): ProviderShareUsageRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const valid = typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
    && typeof row.shareId === 'string' && typeof row.memberId === 'string'
    && typeof row.kind === 'string' && typeof row.model === 'string'
    && (row.providerId === null || typeof row.providerId === 'string')
    && [...COUNTERS, 'lastAt'].every((key) => isCount(row[key]));
  if (!valid) return null;
  const byMember = parseByMember(row.byMember);
  const { byMember: storedByMember, ...rest } = row as unknown as ProviderShareUsageRow;
  // 先丢掉文件里的原始值，再写回经过校验的版本；旧行没有该字段。
  void storedByMember;
  return byMember ? { ...rest, byMember } : rest;
}

function parseDirectReceiptRoute(value: unknown): ProviderShareDirectReceiptRoute | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const route = value as Record<string, unknown>;
  const bounded = (key: string, max: number) => typeof route[key] === 'string'
    && (route[key] as string).length > 0 && (route[key] as string).length <= max;
  if (!bounded('ownerScope', 512) || !bounded('ownerDeviceId', 128)
    || !bounded('shareId', 128) || !bounded('memberId', 128)
    || !bounded('guestDeviceId', 128) || !bounded('sessionId', 128)
    || !bounded('executorDeviceId', 128) || !bounded('executorProviderId', 256)
    || !bounded('agentKind', 64) || !bounded('providerId', 256) || !bounded('model', 512)
    || typeof route.memberKey !== 'string' || !MEMBER_KEY.test(route.memberKey)
    || typeof route.generation !== 'string' || !/^[0-9a-f-]{36}$/.test(route.generation)
    || !Number.isSafeInteger(route.expiresAt) || (route.expiresAt as number) <= 0
    || (route.createdAt !== undefined && (!Number.isSafeInteger(route.createdAt)
      || (route.createdAt as number) <= 0))
    || (route.committedAt !== undefined && (!Number.isSafeInteger(route.committedAt)
      || (route.committedAt as number) <= 0))
    || (route.revokedAt !== undefined && (!Number.isSafeInteger(route.revokedAt)
      || (route.revokedAt as number) <= 0))
    || (route.memberJoinedAt !== undefined && !bounded('memberJoinedAt', 128))) return null;
  return {
    ownerScope: route.ownerScope as string, ownerDeviceId: route.ownerDeviceId as string,
    shareId: route.shareId as string, memberId: route.memberId as string,
    guestDeviceId: route.guestDeviceId as string, sessionId: route.sessionId as string,
    executorDeviceId: route.executorDeviceId as string, executorProviderId: route.executorProviderId as string,
    agentKind: route.agentKind as string, providerId: route.providerId as string,
    memberKey: route.memberKey as string, model: route.model as string,
    generation: route.generation as string, expiresAt: route.expiresAt as number,
    ...(route.createdAt !== undefined ? { createdAt: route.createdAt as number } : {}),
    ...(route.committedAt !== undefined ? { committedAt: route.committedAt as number } : {}),
    ...(route.revokedAt !== undefined ? { revokedAt: route.revokedAt as number } : {}),
    ...(route.memberJoinedAt !== undefined ? { memberJoinedAt: route.memberJoinedAt as string } : {}),
  };
}

const memberGenerationKey = (member: Pick<ProviderShareMemberGeneration,
  'ownerScope' | 'ownerDeviceId' | 'shareId' | 'memberId'>) => JSON.stringify([
  member.ownerScope, member.ownerDeviceId, member.shareId, member.memberId,
]);

function parseMemberGeneration(value: unknown): ProviderShareMemberGeneration | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const bounded = (key: string, max: number) => typeof row[key] === 'string'
    && (row[key] as string).length > 0 && (row[key] as string).length <= max;
  if (!bounded('ownerScope', 512) || !bounded('ownerDeviceId', 128) || !bounded('shareId', 128)
    || !bounded('memberId', 128) || !bounded('joinedAt', 128)
    || typeof row.present !== 'boolean' || typeof row.pendingCleanup !== 'boolean') return null;
  const scopes: NonNullable<ProviderShareMemberGeneration['cleanupScopes']> = [];
  if (row.cleanupScopes !== undefined) {
    if (!Array.isArray(row.cleanupScopes)) return null;
    for (const scope of row.cleanupScopes) {
      if (!scope || typeof scope.controller !== 'string' || !scope.controller || scope.controller.length > 2048
        || (scope.relay !== undefined && (typeof scope.relay !== 'string' || !scope.relay || scope.relay.length > 2048))) return null;
      scopes.push({ controller: scope.controller, ...(scope.relay ? { relay: scope.relay } : {}) });
    }
  }
  return { ownerScope: row.ownerScope as string, ownerDeviceId: row.ownerDeviceId as string,
    shareId: row.shareId as string, memberId: row.memberId as string, joinedAt: row.joinedAt as string,
    present: row.present, pendingCleanup: row.pendingCleanup,
    ...(scopes.length ? { cleanupScopes: scopes } : {}) };
}

const directReceiptRouteKey = (route: ProviderShareDirectReceiptRoute) => JSON.stringify([
  route.ownerScope, route.ownerDeviceId, route.shareId, route.memberId, route.guestDeviceId,
  route.sessionId, route.executorDeviceId, route.executorProviderId,
  route.agentKind, route.providerId, route.memberKey,
  route.model, route.generation,
]);

const directTaskLocationKey = (task: ProviderShareDirectTaskIdentity) => JSON.stringify([
  task.ownerScope, task.ownerDeviceId, task.shareId, task.memberId, task.guestDeviceId, task.sessionId,
]);

function parseDirectTaskLocation(value: unknown): ProviderShareDirectTaskLocation | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  // Reuse the bounded identity parser without keeping a lease or revocation state.
  const route = parseDirectReceiptRoute({ ...value, expiresAt: 1, createdAt: undefined, revokedAt: undefined });
  if (!route || route.committedAt === undefined) return null;
  const { expiresAt, createdAt, revokedAt, ...location } = route;
  void expiresAt; void createdAt; void revokedAt;
  return { ...location, committedAt: route.committedAt };
}

const directCleanupKey = (target: ProviderShareDirectCleanupTarget) => JSON.stringify([
  target.ownerScope, target.shareId, target.memberId, target.guestDeviceId, target.executorDeviceId,
]);

function parseDirectCleanupTarget(value: unknown): ProviderShareDirectCleanupTarget | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  const valid = (key: string, max: number) => typeof row[key] === 'string'
    && (row[key] as string).length > 0 && (row[key] as string).length <= max;
  if (!valid('ownerScope', 512) || !valid('shareId', 128) || !valid('memberId', 128)
    || !valid('guestDeviceId', 128) || !valid('executorDeviceId', 128)
    || (row.cleanupEpoch !== undefined && (!Number.isSafeInteger(row.cleanupEpoch)
      || (row.cleanupEpoch as number) < 0))
    || (row.cleaned !== undefined && typeof row.cleaned !== 'boolean')
    || (row.pendingId !== undefined && (typeof row.pendingId !== 'string'
      || !/^[0-9a-f-]{36}$/.test(row.pendingId)))) return null;
  return { ownerScope: row.ownerScope as string, shareId: row.shareId as string,
    memberId: row.memberId as string, guestDeviceId: row.guestDeviceId as string,
    executorDeviceId: row.executorDeviceId as string, cleanupEpoch: row.cleanupEpoch as number ?? 0,
    ...(row.cleaned === true ? { cleaned: true } : {}),
    ...(typeof row.pendingId === 'string' ? { pendingId: row.pendingId } : {}) };
}

export function createProviderShareUsageStore(filePath: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let rows: Map<string, ProviderShareUsageRow> | null = null;
  const recentUsageIds = new Map<string, number>();
  const directReceiptRoutes = new Map<string, ProviderShareDirectReceiptRoute>();
  const directTaskLocations = new Map<string, ProviderShareDirectTaskLocation>();
  const memberGenerations = new Map<string, ProviderShareMemberGeneration>();
  const directCleanupTargets = new Map<string, ProviderShareDirectCleanupTarget>();
  let cleanupPersistenceFailed = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  // Missing data on/before this local date can affect a rolling snapshot until it ages out.
  let incompleteThroughDay: string | null = null;
  let writing: Promise<void> = Promise.resolve();

  const keyOf = (row: Pick<ProviderShareUsageRow, 'day' | 'shareId' | 'memberId' | 'kind' | 'providerId' | 'model'>) =>
    JSON.stringify([row.day, row.shareId, row.memberId, row.kind, row.providerId, row.model]);

  function markIncomplete(day?: unknown, persist = true): void {
    const today = localDay(now());
    let through = today;
    if (typeof day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(day) && day <= today) {
      const [year, month, date] = day.split('-').map(Number);
      if (localDay(new Date(year!, month! - 1, date!).getTime()) === day) through = day;
    }
    if (!incompleteThroughDay || through > incompleteThroughDay) {
      incompleteThroughDay = through;
      // Persist detection even without a new usage receipt; reopening must not move the boundary.
      if (persist || through !== day) scheduleFlush();
    }
  }

  function load(): Map<string, ProviderShareUsageRow> {
    if (rows) return rows;
    // Publish no cache until the entire safety ledger has been read and checked.
    // A transient read error must remain retryable, never become a new baseline.
    let parsed: Record<string, unknown>;
    try {
      const value: unknown = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!value || typeof value !== 'object' || Array.isArray(value)
        || (value as Record<string, unknown>).version !== FILE_VERSION
        || !Array.isArray((value as Record<string, unknown>).rows)) {
        throw new Error('Invalid provider share usage ledger');
      }
      parsed = value as Record<string, unknown>;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        rows = new Map();
        return rows;
      }
      throw new Error('Provider share usage ledger is unavailable', { cause: error });
    }
    const loadedRows = new Map<string, ProviderShareUsageRow>();
    const readSafetyMap = <T>(field: string, parse: (raw: unknown) => T | null,
      keyOfValue: (value: T) => string): Map<string, T> => {
      const values = parsed[field];
      // Optional fields were absent in earlier valid v1 files. Present but
      // malformed fields/entries are unreadable safety state, not empty state.
      if (values === undefined) return new Map();
      if (!Array.isArray(values)) throw new Error(`Invalid provider share usage ledger: ${field}`);
      const result = new Map<string, T>();
      for (const raw of values) {
        const value = parse(raw);
        if (!value) throw new Error(`Invalid provider share usage ledger: ${field}`);
        const key = keyOfValue(value);
        if (result.has(key)) throw new Error(`Duplicate provider share usage ledger entry: ${field}`);
        result.set(key, value);
      }
      return result;
    };
    const loadedMembers = readSafetyMap('memberGenerations', parseMemberGeneration, memberGenerationKey);
    const loadedUsageIds = readSafetyMap<[string, number]>('recentUsageIds', (raw) => {
      if (!Array.isArray(raw) || raw.length !== 2 || typeof raw[0] !== 'string'
        || !/^[0-9a-f-]{36}$/.test(raw[0]) || !Number.isSafeInteger(raw[1]) || raw[1] < 0) return null;
      return [raw[0], raw[1] as number];
    }, (entry) => entry[0]);
    const loadedRoutes = readSafetyMap('directReceiptRoutes', parseDirectReceiptRoute, directReceiptRouteKey);
    const loadedTargets = readSafetyMap('directCleanupTargets', parseDirectCleanupTarget, directCleanupKey);
    const loadedLocations = readSafetyMap('directTaskLocations', parseDirectTaskLocation, directTaskLocationKey);
    // Read oversized valid images in full. Admission limits reject new entries;
    // slicing here could discard a pending forget or the only old M destination.
    const legacyRoutes = [...loadedRoutes.values()];
    for (const source of [...legacyRoutes, ...loadedLocations.values()]) {
      const target = parseDirectCleanupTarget(source)!;
      const key = directCleanupKey(target);
      if (!loadedTargets.has(key)) loadedTargets.set(key, target);
    }
    const migrateLocations = parsed.directTaskLocations === undefined;
    if (migrateLocations) {
      for (const route of legacyRoutes) {
        if (route.committedAt === undefined || route.revokedAt !== undefined) continue;
        const location = parseDirectTaskLocation(route)!;
        const key = directTaskLocationKey(location);
        const previous = loadedLocations.get(key);
        if (!previous || previous.committedAt <= location.committedAt) loadedLocations.set(key, location);
      }
    }
    for (const [key, location] of loadedLocations) {
      const cleanup = loadedTargets.get(directCleanupKey({ ...location, cleanupEpoch: 0 }));
      if (cleanup?.pendingId || cleanup?.cleaned) loadedLocations.delete(key);
    }
    for (const raw of parsed.rows as unknown[]) {
      const row = parseRow(raw);
      if (row) loadedRows.set(keyOf(row), row);
      else markIncomplete((raw as { day?: unknown } | null)?.day);
    }
    if (parsed.incompleteThroughDay !== undefined) markIncomplete(parsed.incompleteThroughDay, false);
    else if (parsed.incomplete === true) markIncomplete();
    // All parsing/migration succeeded; publish the complete snapshot together.
    for (const [key, member] of loadedMembers) memberGenerations.set(key, member);
    for (const [key, entry] of loadedUsageIds) recentUsageIds.set(key, entry[1]);
    for (const [key, route] of loadedRoutes) {
      if (route.expiresAt + DIRECT_RECEIPT_GRACE_MS > now()) directReceiptRoutes.set(key, route);
    }
    for (const [key, target] of loadedTargets) directCleanupTargets.set(key, target);
    for (const [key, location] of loadedLocations) directTaskLocations.set(key, location);
    rows = loadedRows;
    // Explicit emptiness prevents a cleared location from being remigrated.
    if (migrateLocations) scheduleFlush();
    return rows;
  }

  function prune(map: Map<string, ProviderShareUsageRow>): void {
    const cutoff = localDay(now() - RETAIN_DAYS * 86_400_000);
    for (const [key, row] of map) if (row.day < cutoff) map.delete(key);
    if (map.size <= MAX_ROWS) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [key] of oldest.slice(0, map.size - MAX_ROWS)) map.delete(key);
  }

  async function writeNow(commit?: { route: ProviderShareDirectReceiptRoute; location: ProviderShareDirectTaskLocation }): Promise<void> {
    const map = load();
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    prune(map);
    if (incompleteThroughDay && incompleteThroughDay < providerShareUsageRangeStart('7d', now())!) incompleteThroughDay = null;
    for (const [id, at] of recentUsageIds) if (at < now() - USAGE_RETRY_DEDUP_MS) recentUsageIds.delete(id);
    for (const [key, route] of directReceiptRoutes) {
      if (route.expiresAt + DIRECT_RECEIPT_GRACE_MS <= now()) directReceiptRoutes.delete(key);
    }
    // A committing location is staged only in the disk image. Synchronous lookups
    // and receipts cannot observe it until the atomic replacement has succeeded.
    const receiptRoutes = commit
      ? new Map(directReceiptRoutes).set(directReceiptRouteKey(commit.route), commit.route) : directReceiptRoutes;
    const taskLocations = commit
      ? new Map(directTaskLocations).set(directTaskLocationKey(commit.location), commit.location) : directTaskLocations;
    const body = JSON.stringify({ version: FILE_VERSION, rows: [...map.values()], recentUsageIds: [...recentUsageIds],
      directReceiptRoutes: [...receiptRoutes.values()], directCleanupTargets: [...directCleanupTargets.values()],
      directTaskLocations: [...taskLocations.values()], memberGenerations: [...memberGenerations.values()],
      ...(incompleteThroughDay ? { incomplete: true, incompleteThroughDay } : {}) });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, filePath);
      cleanupPersistenceFailed = false;
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(() => writeNow()).catch(() => undefined);
    }, FLUSH_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  /** Receipt ACKs and route publication require the same durable ledger image. */
  async function persistNow(): Promise<void> {
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
    const pending = writing.then(() => writeNow());
    writing = pending.catch(() => undefined);
    await pending;
  }

  /** Include mutation AND rollback in the write queue, so another write cannot
   * persist a failed commit's tentative route/location before rollback runs. */
  function serializeMutation<T>(operation: () => Promise<T>): Promise<T> {
    const pending = writing.then(operation);
    writing = pending.then(() => undefined, () => undefined);
    return pending;
  }

  function clearDirectTaskLocation(task: ProviderShareDirectTaskIdentity, expectedGeneration: string): Promise<boolean> {
    return serializeMutation(async () => {
      load();
      const key = directTaskLocationKey(task);
      const previous = directTaskLocations.get(key);
      if (!previous || previous.generation !== expectedGeneration) return false;
      directTaskLocations.delete(key);
      try { await writeNow(); }
      catch (error) { directTaskLocations.set(key, previous); throw error; }
      return true;
    });
  }

  function findDirectTaskLocation(task: ProviderShareDirectTaskIdentity): ProviderShareDirectTaskLocation | null {
    load();
    if (!memberGenerationReady(task)) return null;
    const location = directTaskLocations.get(directTaskLocationKey(task));
    return location ? { ...location } : null;
  }

  function memberGenerationReady(member: Pick<ProviderShareMemberGeneration,
    'ownerScope' | 'ownerDeviceId' | 'shareId' | 'memberId'>, joinedAt?: string): boolean {
    load();
    const saved = memberGenerations.get(memberGenerationKey(member));
    // Older files have no membership baseline. First authoritative snapshot adopts
    // it; it cannot reconstruct a deletion that predates this feature's first observation.
    if (!saved) return joinedAt === undefined;
    if (!saved.present || saved.pendingCleanup || (joinedAt !== undefined && saved.joinedAt !== joinedAt)) return false;
    return ![...directCleanupTargets.values()].some((target) => target.ownerScope === member.ownerScope
      && target.shareId === member.shareId && target.memberId === member.memberId && target.pendingId);
  }

  function markDirectCleanup(ownerScope: string, match: (target: ProviderShareDirectCleanupTarget) => boolean): boolean {
    let changed = false;
    const matched = new Set<string>();
    for (const [key, target] of directCleanupTargets) {
      if (target.ownerScope !== ownerScope || !match(target)) continue;
      matched.add(key);
      if (target.pendingId || target.cleaned) continue;
      directCleanupTargets.set(key, { ...target, pendingId: randomUUID() });
      changed = true;
    }
    for (const [key, location] of directTaskLocations) {
      if (!matched.has(directCleanupKey({ ...location, cleanupEpoch: 0 }))) continue;
      directTaskLocations.delete(key);
      changed = true;
    }
    for (const [key, route] of directReceiptRoutes) {
      if (route.revokedAt !== undefined || !matched.has(directCleanupKey({ ...route, cleanupEpoch: 0 }))) continue;
      directReceiptRoutes.set(key, { ...route, revokedAt: now() });
      changed = true;
    }
    return changed;
  }

  return {
    /** Same member/provider only, today's local calendar date plus six preceding dates. */
    memberTokenSnapshot(shareIds: ReadonlySet<string>, providerId: string, memberId: string, at = now()) {
      const start = providerShareUsageRangeStart('7d', at)!;
      const end = localDay(at);
      const date = new Date(at);
      const totals = new Map<string, number>();
      let loaded: Map<string, ProviderShareUsageRow>;
      try { loaded = load(); }
      catch {
        // Usage remains unavailable, and unreadable cleanup/authorization state
        // must never be replaced with an empty ledger just to recover metering.
        return { available: false, windowStart: start, windowEnd: end,
          nextWindowAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(), models: [] };
      }
      for (const row of loaded.values()) {
        if (!shareIds.has(row.shareId) || row.memberId !== memberId || row.providerId !== providerId
          || row.day < start || row.day > end) continue;
        totals.set(row.model, (totals.get(row.model) ?? 0) + row.inputTokens + row.outputTokens);
      }
      return { available: !incompleteThroughDay || incompleteThroughDay < start, windowStart: start, windowEnd: end,
        nextWindowAt: new Date(date.getFullYear(), date.getMonth(), date.getDate() + 1).getTime(),
        models: [...totals].map(([model, tokens]) => ({ model, tokens })) };
    },
    memberGenerationReady,
    /** Persist every observed member, including relay-only members, before admission.
     * Removal/reapproval is equality of server joinedAt, not client clock ordering. */
    async reconcileMemberGenerations(ownerScope: string, ownerDeviceId: string,
      shares: readonly { shareId: string; members: readonly { memberId: string; joinedAt: string }[] }[]): Promise<ProviderShareMemberGeneration[]> {
      return serializeMutation(async () => {
        load();
        const next = new Map<string, ProviderShareMemberGeneration>();
        for (const share of shares) for (const member of share.members) {
          const parsed = parseMemberGeneration({ ownerScope, ownerDeviceId, shareId: share.shareId,
            memberId: member.memberId, joinedAt: member.joinedAt, present: true, pendingCleanup: false });
          if (!parsed) throw new Error('Invalid provider share membership generation');
          next.set(memberGenerationKey(parsed), parsed);
        }
        const added = [...next.keys()].filter((key) => !memberGenerations.has(key)).length;
        if (added > 0 && memberGenerations.size + added > MAX_DIRECT_TASK_LOCATIONS) {
          throw new Error('Provider share membership ledger is full');
        }
        let changed = false;
        for (const [key, previous] of memberGenerations) {
          if (previous.ownerScope !== ownerScope || previous.ownerDeviceId !== ownerDeviceId) continue;
          const incoming = next.get(key);
          if ((!incoming && previous.present) || (incoming && (!previous.present || previous.joinedAt !== incoming.joinedAt))) {
            memberGenerations.set(key, { ...previous, ...(incoming ? { joinedAt: incoming.joinedAt } : {}),
              present: !!incoming, pendingCleanup: true });
            markDirectCleanup(ownerScope, (target) => target.shareId === previous.shareId && target.memberId === previous.memberId);
            changed = true;
          }
          next.delete(key);
        }
        for (const [key, member] of next) { memberGenerations.set(key, member); changed = true; }
        if (changed || cleanupPersistenceFailed) {
          try { await writeNow(); }
          catch (error) { cleanupPersistenceFailed = true; throw error; }
        }
        return this.listPendingMemberCleanup(ownerScope, ownerDeviceId);
      });
    },
    listPendingMemberCleanup(ownerScope: string, ownerDeviceId: string): ProviderShareMemberGeneration[] {
      load();
      return [...memberGenerations.values()].filter((member) => member.ownerScope === ownerScope
        && member.ownerDeviceId === ownerDeviceId && member.pendingCleanup)
        .map((member) => ({ ...member, ...(member.cleanupScopes ? { cleanupScopes: member.cleanupScopes.map((scope) => ({ ...scope })) } : {}) }));
    },
    async rememberMemberCleanupScopes(member: ProviderShareMemberGeneration,
      scopes: NonNullable<ProviderShareMemberGeneration['cleanupScopes']>): Promise<void> {
      return serializeMutation(async () => {
        load();
        const key = memberGenerationKey(member);
        const current = memberGenerations.get(key);
        if (!current?.pendingCleanup || current.joinedAt !== member.joinedAt || current.present !== member.present) {
          throw new Error('Provider share membership changed during cleanup');
        }
        const combined = [...new Map([...(current.cleanupScopes ?? []), ...scopes].map((scope) =>
          [JSON.stringify([scope.controller, scope.relay]), scope])).values()];
        const updated = parseMemberGeneration({ ...current, cleanupScopes: combined });
        if (!updated) throw new Error('Invalid provider share cleanup scope');
        memberGenerations.set(key, updated);
        try { await writeNow(); }
        catch (error) { cleanupPersistenceFailed = true; throw error; }
      });
    },
    async acknowledgeMemberCleanup(member: ProviderShareMemberGeneration): Promise<void> {
      return serializeMutation(async () => {
        load();
        const key = memberGenerationKey(member);
        const current = memberGenerations.get(key);
        if (!current?.pendingCleanup || current.joinedAt !== member.joinedAt || current.present !== member.present) return;
        const updated = { ...current, pendingCleanup: false, cleanupScopes: undefined };
        memberGenerations.set(key, updated);
        try { await writeNow(); }
        catch (error) { memberGenerations.set(key, current); throw error; }
      });
    },
    /** Exact scoped lookup; returning a location never authorizes resume/fork/image access. */
    getDirectTaskLocation(ownerScope: string, ownerDeviceId: string, shareId: string,
      memberId: string, guestDeviceId: string, sessionId: string): ProviderShareDirectTaskLocation | null {
      return findDirectTaskLocation({ ownerScope, ownerDeviceId, shareId, memberId, guestDeviceId, sessionId });
    },
    /** Object-identity form of getDirectTaskLocation for callers already holding the complete scope. */
    findDirectTaskLocation,
    /** Explicit task removal; stale generations cannot erase a newer assignment. */
    clearDirectTaskLocation,
    /** Call after accepting a move to the legacy relay path, not when merely revoking a lease. */
    markDirectTaskRelayed: clearDirectTaskLocation,
    /** Mark deleted members durably before attempting O→M cleanup. Repeats keep the same pending ID. */
    async enqueueDirectCleanup(ownerScope: string,
      match: (target: ProviderShareDirectCleanupTarget) => boolean): Promise<void> {
      return serializeMutation(async () => {
        load();
        const changed = markDirectCleanup(ownerScope, match);
        if (changed || cleanupPersistenceFailed) {
          try { await writeNow(); }
          catch (error) { cleanupPersistenceFailed = true; throw error; }
        }
      });
    },
    pendingDirectCleanupFor(ownerScope: string, target: Pick<ProviderShareDirectCleanupTarget,
      'shareId' | 'memberId' | 'guestDeviceId' | 'executorDeviceId'>):
      (ProviderShareDirectCleanupTarget & { pendingId: string }) | null {
      load();
      const row = directCleanupTargets.get(directCleanupKey({ ...target, ownerScope, cleanupEpoch: 0 }));
      return row?.pendingId ? { ...row, pendingId: row.pendingId } : null;
    },
    listPendingDirectCleanup(ownerScope: string, limit = 32, offset = 0): ProviderShareDirectCleanupTarget[] {
      load();
      const pending = [...directCleanupTargets.values()]
        .filter((target) => target.ownerScope === ownerScope && target.pendingId);
      return Array.from({ length: Math.min(pending.length, Math.max(0, Math.min(32, limit))) }, (_, index) =>
        ({ ...pending[(offset + index) % pending.length]! }));
    },
    async acknowledgeDirectCleanup(target: ProviderShareDirectCleanupTarget): Promise<void> {
      return serializeMutation(async () => {
        load();
        const key = directCleanupKey(target);
        const current = directCleanupTargets.get(key);
        if (!current?.pendingId || current.pendingId !== target.pendingId) return;
        const updated = { ...current, pendingId: undefined, cleaned: true };
        directCleanupTargets.set(key, updated);
        try { await writeNow(); }
        catch (error) {
          if (directCleanupTargets.get(key) === updated) directCleanupTargets.set(key, current);
          throw error;
        }
      });
    },
    /** Active assignments only; delayed receipt acceptance uses the independent grace window. */
    listActiveDirectReceiptRoutes(ownerScope: string): ProviderShareDirectReceiptRoute[] {
      load();
      return [...directReceiptRoutes.values()]
        .filter((route) => route.ownerScope === ownerScope && route.expiresAt > now()
          && route.revokedAt === undefined)
        .map((route) => ({ ...route }));
    },
    async markDirectReceiptRouteRevoked(input: ProviderShareDirectReceiptRoute): Promise<void> {
      return serializeMutation(async () => {
        load();
        const route = directReceiptRoutes.get(directReceiptRouteKey(input));
        if (!route || route.revokedAt !== undefined) return;
        const key = directReceiptRouteKey(route);
        const updated = { ...route, revokedAt: now() };
        directReceiptRoutes.set(key, updated);
        try { await writeNow(); }
        catch (error) {
          if (directReceiptRoutes.get(key) === updated) directReceiptRoutes.set(key, route);
          throw error;
        }
      });
    },
    async registerDirectReceiptRoute(input: ProviderShareDirectReceiptRoute): Promise<number> {
      return serializeMutation(async () => {
        const route = parseDirectReceiptRoute(input);
        if (!route || route.expiresAt <= now()) throw new Error('Invalid direct receipt route');
        load();
        if (!memberGenerationReady(route, route.memberJoinedAt)) throw new Error('Provider share member cleanup is pending');
        if (!directTaskLocations.has(directTaskLocationKey(route)) && directTaskLocations.size >= MAX_DIRECT_TASK_LOCATIONS) {
          throw new Error('Direct task location ledger is full');
        }
        for (const [key, saved] of directReceiptRoutes) {
          if (saved.expiresAt + DIRECT_RECEIPT_GRACE_MS <= now()) directReceiptRoutes.delete(key);
        }
        const key = directReceiptRouteKey(route);
        if (directReceiptRoutes.get(key)?.revokedAt !== undefined) {
          throw new Error('Direct receipt route was revoked');
        }
        if (!directReceiptRoutes.has(key) && directReceiptRoutes.size >= MAX_DIRECT_RECEIPT_ROUTES) {
          throw new Error('Direct receipt route ledger is full');
        }
        const cleanupTarget = parseDirectCleanupTarget(route)!;
        const cleanupKey = directCleanupKey(cleanupTarget);
        const previousTarget = directCleanupTargets.get(cleanupKey);
        if (!previousTarget && directCleanupTargets.size >= MAX_DIRECT_CLEANUP_TARGETS) {
          throw new Error('Direct guest cleanup ledger is full');
        }
        if (previousTarget?.pendingId) throw new Error('Direct guest cleanup is still pending');
        if (cleanupPersistenceFailed) await writeNow();
        const previousRoute = directReceiptRoutes.get(key);
        const cleanupEpoch = (previousTarget?.cleanupEpoch ?? 0) + 1;
        const nextRoute = { ...route, createdAt: previousRoute?.createdAt ?? now(), committedAt: previousRoute?.committedAt };
        const nextTarget = { ...cleanupTarget, cleanupEpoch };
        directReceiptRoutes.set(key, nextRoute);
        directCleanupTargets.set(cleanupKey, nextTarget);
        try { await writeNow(); }
        catch (error) {
          if (directReceiptRoutes.get(key) === nextRoute) {
            if (previousRoute) directReceiptRoutes.set(key, previousRoute);
            else directReceiptRoutes.delete(key);
          }
          if (directCleanupTargets.get(cleanupKey) === nextTarget) {
            if (previousTarget) directCleanupTargets.set(cleanupKey, previousTarget);
            else directCleanupTargets.delete(cleanupKey);
          }
          throw error;
        }
        return cleanupEpoch;
      });
    },
    async commitDirectReceiptRoute(input: ProviderShareDirectReceiptRoute): Promise<void> {
      return serializeMutation(async () => {
        load();
        const key = directReceiptRouteKey(input);
        const route = directReceiptRoutes.get(key);
        if (!route || route.revokedAt !== undefined || route.expiresAt <= now()) {
          throw new Error('Direct receipt route cannot be committed');
        }
        if (!memberGenerationReady(route, route.memberJoinedAt)) throw new Error('Provider share member cleanup is pending');
        // Retried commits cannot overwrite a newer model, or resurrect a location
        // explicitly cleared when G moved to the relay path.
        if (route.committedAt !== undefined) return;
        const locationKey = directTaskLocationKey(route);
        const previousLocation = directTaskLocations.get(locationKey);
        if (!previousLocation && directTaskLocations.size >= MAX_DIRECT_TASK_LOCATIONS) {
          throw new Error('Direct task location ledger is full');
        }
        const updated = { ...route, committedAt: now() };
        const location = parseDirectTaskLocation(updated)!;
        await writeNow({ route: updated, location });
        directReceiptRoutes.set(key, updated);
        directTaskLocations.set(locationKey, location);
      });
    },
    async recordDirectReceipt(ownerScope: string, ownerDeviceId: string, executorDeviceId: string,
      receipt: ProviderShareDirectReceipt): Promise<boolean> {
      load();
      const route = [...directReceiptRoutes.values()].find((saved) => saved.ownerScope === ownerScope
        && saved.ownerDeviceId === ownerDeviceId && saved.executorDeviceId === executorDeviceId
        && saved.shareId === receipt.shareId && saved.memberId === receipt.memberId
        && saved.guestDeviceId === receipt.guestDeviceId && saved.sessionId === receipt.sessionId
        && saved.generation === receipt.generation
        && saved.agentKind === receipt.agentKind
        && saved.committedAt !== undefined
        && saved.expiresAt + DIRECT_RECEIPT_GRACE_MS > now());
      if (!route || !/^[0-9a-f-]{36}$/.test(receipt.usageId)
        || receipt.samples.length === 0 || receipt.samples.length > 64
        || receipt.samples.some((sample) => !sample.model || sample.model.length > 512
          || COUNTERS.some((field) => !isCount(sample[field]) || sample[field] > 1e15))) {
        throw new Error('REMOTE_AGENT_INVALID');
      }
      const recorded = this.recordOnce(receipt.usageId, route.shareId, route.memberId, {
        kind: route.agentKind, providerId: route.providerId, memberKey: route.memberKey,
        samples: receipt.samples,
      });
      await persistNow();
      return recorded;
    },
    /** Idempotent report from an assigned executor; IDs survive a host restart. */
    recordOnce(usageId: string, shareId: string, memberId: string,
      usage: { kind: string; providerId: string | null; memberKey: string; samples: readonly GuestUsageSample[] }): boolean {
      load();
      if (recentUsageIds.has(usageId)) return false;
      for (const [id, at] of recentUsageIds) if (at < now() - USAGE_RETRY_DEDUP_MS) recentUsageIds.delete(id);
      // Never evict an ID that M can still retry: reject new receipts until
      // space returns, rather than silently counting a replay twice.
      if (recentUsageIds.size >= MAX_RECENT_USAGE_IDS) throw new Error('REMOTE_AGENT_BUSY');
      this.record(shareId, memberId, usage);
      recentUsageIds.set(usageId, now());
      return true;
    },
    /** memberKey：这一轮在哪台组内电脑运行(本机为 `local`)。 */
    record(
      shareId: string,
      memberId: string,
      usage: { kind: string; providerId: string | null; memberKey: string; samples: readonly GuestUsageSample[] },
    ): void {
      const map = load();
      const at = now();
      const day = localDay(at);
      const memberKey = MEMBER_KEY.test(usage.memberKey) ? usage.memberKey : null;
      for (const sample of usage.samples) {
        const identity = { day, shareId, memberId, kind: usage.kind, providerId: usage.providerId, model: sample.model };
        const key = keyOf(identity);
        const row = map.get(key) ?? { ...identity, ...emptyCounters(), lastAt: at };
        const counters: Counters = {
          turns: sample.turns,
          inputTokens: sample.inputTokens,
          outputTokens: sample.outputTokens,
          cacheReadTokens: sample.cacheReadTokens,
          cacheCreateTokens: sample.cacheCreateTokens,
          sdkCostUsd: sample.sdkCostUsd,
        };
        addCounters(row, counters);
        if (memberKey) {
          row.byMember ??= Object.create(null) as Record<string, Counters>;
          const member = row.byMember[memberKey];
          if (member) addCounters(member, counters);
          else if (Object.keys(row.byMember).length < MAX_MEMBERS_PER_ROW) {
            row.byMember[memberKey] = { ...counters };
          }
          // 已有电脑继续累计；容量满时新电脑只加行合计，查询按没区分电脑返回，不挤掉已存的分布。
        }
        row.lastAt = at;
        map.set(key, row);
      }
      scheduleFlush();
    },

    /**
     * 按受邀者汇总(只含 shareIds 里的分享)，每人按(Agent、供应商、模型、组内电脑)分行；合计比各台之和多出来的
     * 部分记为没区分电脑。最近使用时间不受时间段限制。
     */
    query(shareIds: ReadonlySet<string>, range: ProviderShareUsageRange): ProviderShareMemberUsage[] {
      const start = providerShareUsageRangeStart(range, now());
      const members = new Map<string, ProviderShareMemberUsage>();
      for (const row of load().values()) {
        if (!shareIds.has(row.shareId)) continue;
        const memberKey = JSON.stringify([row.shareId, row.memberId]);
        const member = members.get(memberKey) ?? { shareId: row.shareId, memberId: row.memberId, lastUsedAt: null, models: [] };
        members.set(memberKey, member);
        member.lastUsedAt = Math.max(member.lastUsedAt ?? 0, row.lastAt);
        if (start && row.day < start) continue;
        for (const [key, counters] of splitByMember(row)) {
          const model = member.models.find(
            (item) => item.model === row.model && item.kind === row.kind && item.providerId === row.providerId
              && item.memberKey === key,
          );
          if (model) addCounters(model, counters);
          else member.models.push({ kind: row.kind, providerId: row.providerId, memberKey: key, model: row.model, ...counters });
        }
      }
      for (const member of members.values()) member.models.sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
      return [...members.values()];
    },

    /**
     * 按受邀者、按天的明细(只含 shareIds 里的分享)：「用量」块在界面上按时间段、组内电脑筛选。
     * 每天按(Agent、供应商、模型、组内电脑)分行，组内电脑的拆法与 query 相同；新的日子在前。
     */
    history(shareIds: ReadonlySet<string>, options: ProviderShareUsageHistoryOptions = {}): ProviderShareMemberDailyUsage[] {
      const members = new Map<string, ProviderShareMemberDailyUsage>();
      const maxRows = options.maxRows === undefined
        ? Number.POSITIVE_INFINITY
        : Number.isFinite(options.maxRows) ? Math.max(0, Math.floor(options.maxRows)) : 0;
      let expandedRows = 0;
      const sourceRows = [...load().values()]
        .filter((row) => shareIds.has(row.shareId)
          && (!options.memberKeys || options.memberKeys.has(JSON.stringify([row.shareId, row.memberId]))))
        .sort((a, b) => b.day.localeCompare(a.day) || b.lastAt - a.lastAt);
      const lastUsedAt = new Map<string, number>();
      for (const row of sourceRows) {
        const key = JSON.stringify([row.shareId, row.memberId]);
        lastUsedAt.set(key, Math.max(lastUsedAt.get(key) ?? 0, row.lastAt));
      }
      for (const row of sourceRows) {
        if (expandedRows >= maxRows) break;
        const memberKey = JSON.stringify([row.shareId, row.memberId]);
        const member = members.get(memberKey) ?? {
          shareId: row.shareId,
          memberId: row.memberId,
          lastUsedAt: lastUsedAt.get(memberKey) ?? null,
          days: [],
        };
        members.set(memberKey, member);
        const parts = splitByMember(row);
        for (const [key, counters] of parts) {
          if (expandedRows >= maxRows) break;
          member.days.push({ day: row.day, kind: row.kind, providerId: row.providerId, memberKey: key, model: row.model, ...counters });
          expandedRows++;
        }
      }
      // 保留只有较早记录、因预算未展开到的成员，供管理页显示其最近使用时间。
      for (const [memberKey, latest] of lastUsedAt) {
        if (members.has(memberKey)) continue;
        const [shareId, memberId] = JSON.parse(memberKey) as [string, string];
        members.set(memberKey, { shareId, memberId, lastUsedAt: latest, days: [] });
      }
      for (const member of members.values()) {
        member.days.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : b.turns - a.turns));
      }
      return [...members.values()];
    },

    async flush(): Promise<void> {
      load();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        writing = writing.then(() => writeNow()).catch(() => undefined);
      }
      await writing;
    },
  };
}

export type ProviderShareUsageStore = ReturnType<typeof createProviderShareUsageStore>;

let store: ProviderShareUsageStore | null = null;

export function installProviderShareUsageStore(userDataDir: string): ProviderShareUsageStore {
  store ??= createProviderShareUsageStore(path.join(userDataDir, 'remote-agent', 'provider-share-usage.json'));
  return store;
}

export function getProviderShareUsageStore(): ProviderShareUsageStore | null {
  return store;
}
