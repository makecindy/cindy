/**
 * 供应商分享的用量账本(分享者电脑上)：按(日期、分享、受邀者、Agent、供应商、模型)聚合 token 与轮次。
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

export interface ProviderShareUsageRow {
  day: string;
  shareId: string;
  memberId: string;
  kind: string;
  providerId: string | null;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sdkCostUsd: number;
  lastAt: number;
}

export type ProviderShareUsageRange = '7d' | 'month' | 'all';

export interface ProviderShareMemberUsage {
  shareId: string;
  memberId: string;
  lastUsedAt: number | null;
  models: Array<Omit<ProviderShareUsageRow, 'day' | 'shareId' | 'memberId' | 'lastAt'>>;
}

function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 时间段的起始日期(含)；all 返回 null。 */
export function providerShareUsageRangeStart(range: ProviderShareUsageRange, now = Date.now()): string | null {
  if (range === 'all') return null;
  const date = new Date(now);
  if (range === 'month') return localDay(new Date(date.getFullYear(), date.getMonth(), 1).getTime());
  return localDay(new Date(date.getFullYear(), date.getMonth(), date.getDate() - 6).getTime());
}

function isRow(value: unknown): value is ProviderShareUsageRow {
  if (!value || typeof value !== 'object') return false;
  const row = value as Record<string, unknown>;
  const numbers = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'sdkCostUsd', 'lastAt'];
  return typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
    && typeof row.shareId === 'string' && typeof row.memberId === 'string'
    && typeof row.kind === 'string' && typeof row.model === 'string'
    && (row.providerId === null || typeof row.providerId === 'string')
    && numbers.every((key) => typeof row[key] === 'number' && Number.isFinite(row[key] as number) && (row[key] as number) >= 0);
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
        for (const row of parsed.rows) if (isRow(row)) rows.set(keyOf(row), { ...row });
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
    record(shareId: string, memberId: string, usage: { kind: string; providerId: string | null; samples: readonly GuestUsageSample[] }): void {
      const map = load();
      const at = now();
      const day = localDay(at);
      for (const sample of usage.samples) {
        const identity = { day, shareId, memberId, kind: usage.kind, providerId: usage.providerId, model: sample.model };
        const key = keyOf(identity);
        const row = map.get(key) ?? {
          ...identity, turns: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheCreateTokens: 0, sdkCostUsd: 0, lastAt: at,
        };
        row.turns += sample.turns;
        row.inputTokens += sample.inputTokens;
        row.outputTokens += sample.outputTokens;
        row.cacheReadTokens += sample.cacheReadTokens;
        row.cacheCreateTokens += sample.cacheCreateTokens;
        row.sdkCostUsd += sample.sdkCostUsd;
        row.lastAt = at;
        map.set(key, row);
      }
      scheduleFlush();
    },

    /** 按受邀者汇总(只含 shareIds 里的分享)。最近使用时间不受时间段限制。 */
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
        const model = member.models.find((item) => item.model === row.model && item.kind === row.kind && item.providerId === row.providerId);
        if (model) {
          model.turns += row.turns;
          model.inputTokens += row.inputTokens;
          model.outputTokens += row.outputTokens;
          model.cacheReadTokens += row.cacheReadTokens;
          model.cacheCreateTokens += row.cacheCreateTokens;
          model.sdkCostUsd += row.sdkCostUsd;
        } else {
          member.models.push({
            kind: row.kind,
            providerId: row.providerId,
            model: row.model,
            turns: row.turns,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheCreateTokens: row.cacheCreateTokens,
            sdkCostUsd: row.sdkCostUsd,
          });
        }
      }
      for (const member of members.values()) member.models.sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
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
