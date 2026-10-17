/**
 * 供应商分享的用量账本(分享者电脑上)：按(日期、分享、受邀者、Agent、供应商、模型)聚合 token 与轮次。
 *
 * 每行另带 `byMember`：这一行里各台组内电脑分别用了多少(组内电脑的稳定键，本机是 `local`，转给组内电脑的是
 * 那台的键)。行的键与合计仍是原来那套，旧版本读到时照常累计合计、原样带着 `byMember` 写回，降级不丢用量；
 * 合计比各台之和多出来的部分(加这个字段之前记的、降级期间旧版本记的，或单行分布超容量的)读出来算没区分电脑(null)。
 *
 * Agent 在分享者电脑上运行，这里的数据最准，也不经过服务端。文件放在 userData/remote-agent 下，
 * 原子替换写入；分享与成员 id 由服务端生成、全局唯一，查询时只返回当前账号拥有的分享。
 * 删除成员后记录保留(管理页不再显示)；同一人重新加入时服务端沿用原成员 id，用量接续。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import type { GuestUsageSample } from '../remote-agent/host/guestUsage';

const FILE_VERSION = 1;
const RETAIN_DAYS = 400;
const MAX_ROWS = 20_000;
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

export function createProviderShareUsageStore(filePath: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let rows: Map<string, ProviderShareUsageRow> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const keyOf = (row: Pick<ProviderShareUsageRow, 'day' | 'shareId' | 'memberId' | 'kind' | 'providerId' | 'model'>) =>
    JSON.stringify([row.day, row.shareId, row.memberId, row.kind, row.providerId, row.model]);

  function load(): Map<string, ProviderShareUsageRow> {
    if (rows) return rows;
    rows = new Map();
    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8')) as { version?: unknown; rows?: unknown };
      if (parsed.version === FILE_VERSION && Array.isArray(parsed.rows)) {
        for (const raw of parsed.rows) {
          const row = parseRow(raw);
          if (row) rows.set(keyOf(row), row);
        }
      }
    } catch {
      // 没有文件或文件损坏：从空账本开始。
    }
    return rows;
  }

  function prune(map: Map<string, ProviderShareUsageRow>): void {
    const cutoff = localDay(now() - RETAIN_DAYS * 86_400_000);
    for (const [key, row] of map) if (row.day < cutoff) map.delete(key);
    if (map.size <= MAX_ROWS) return;
    const oldest = [...map.entries()].sort((a, b) => a[1].lastAt - b[1].lastAt);
    for (const [key] of oldest.slice(0, map.size - MAX_ROWS)) map.delete(key);
  }

  async function writeNow(): Promise<void> {
    const map = load();
    prune(map);
    const body = JSON.stringify({ version: FILE_VERSION, rows: [...map.values()] });
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    try {
      await fsp.writeFile(tmp, body, { encoding: 'utf8', mode: 0o600 });
      await fsp.rename(tmp, filePath);
    } finally {
      await fsp.rm(tmp, { force: true }).catch(() => undefined);
    }
  }

  function scheduleFlush(): void {
    if (timer) return;
    timer = setTimeout(() => {
      timer = null;
      writing = writing.then(writeNow).catch(() => undefined);
    }, FLUSH_DELAY_MS);
    (timer as { unref?: () => void }).unref?.();
  }

  return {
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
      if (timer) {
        clearTimeout(timer);
        timer = null;
        writing = writing.then(writeNow).catch(() => undefined);
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
