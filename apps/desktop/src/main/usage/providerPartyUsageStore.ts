/**
 * 供应商「按使用方」的用量账本(provider-groups.md §7)：这台电脑自己能记到的三类使用方。
 *  - 本机(`local`)：这台电脑自己的任务。Agent 在本机用这个供应商运行，或任务归本机建的供应商组
 *    (Agent 在组里哪台电脑运行都算，记在组那个供应商上)；
 *  - 我的其他电脑(`device`)：同账号其他电脑自己的远程 Agent 任务在这台电脑上用这个供应商运行，按那台电脑分开；
 *  - 经其他电脑转来(`relay`)：同账号的组所在电脑替它的受邀者转过来的任务，按那台组所在电脑分开
 *    (本机看不到最终使用者)。
 * 每一行另记这一轮实际在哪台组内电脑运行(`memberKey`，组内电脑的稳定键；不经组、就在本机运行的为 `local`)，
 * 「用量」块据此按组内电脑展开。分享的人记在 device-link/providerShareUsageStore。
 *
 * 同账号其他电脑经本机的组、直接连到组里别的电脑运行的任务本机经手不到，由那台电脑报告(provider-group/usageReporter)：
 *  - 那台这边(`group`)：自己经另一台电脑的组、在组里别的电脑上运行的用量，按组所在电脑存着，供应商与组内电脑都用
 *    组所在电脑的坐标；只用来报告，不算进那台自己的供应商；
 *  - 组所在电脑这边(`reported`)：按报告来的电脑存，每次报告整体替换那台从某天起的行，查询时并进「我的其他电脑」那台。
 *
 * 供应商 id 在不同账号下会重复，所以按账号存放(owners/<账号>/ 下)；原子替换写入，保留 400 天；
 * 只含供应商 id、设备 id、组内电脑的键与模型名，不含对话或凭证。
 */
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

import { ownerScopedUserDataPath } from '../appSessionState.js';
import { providerShareUsageRangeStart } from '../device-link/providerShareUsageStore.js';
import type { GuestUsageSample } from '../remote-agent/host/guestUsage.js';
import type { ProviderShareUsageRange } from '../../shared/providerShare.js';

const FILE_NAME = 'provider-usage-by-party.json';
const FILE_VERSION = 1;
const RETAIN_DAYS = 400;
const MAX_ROWS = 20_000;
const FLUSH_DELAY_MS = 1_000;
const REPORT_DAY_CUSHION = 2;

/**
 * 谁用的：本机自己的任务，同账号另一台电脑自己的任务，同账号的组所在电脑替受邀者转来的任务，
 * 或本机经另一台电脑的组、在组里别的电脑上运行(`group`，deviceId 是组所在电脑，只用来报告给它)。
 */
export type ProviderUsageParty =
  | { kind: 'local' }
  | { kind: 'device'; deviceId: string }
  | { kind: 'relay'; deviceId: string }
  | { kind: 'group'; deviceId: string };

type PartyKind = ProviderUsageParty['kind'] | 'reported';

const PARTY_KINDS: readonly PartyKind[] = ['local', 'device', 'relay', 'group', 'reported'];

/** 一行报告：组所在电脑坐标下的供应商与组内电脑，按天、Agent、模型聚合。 */
export interface ProviderGroupUsageReportRow {
  day: string;
  providerId: string;
  memberKey: string;
  kind: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sdkCostUsd: number;
  lastAt: number;
}

interface PartyUsageRow {
  day: string;
  providerId: string;
  party: PartyKind;
  /** null = 本机。 */
  deviceId: string | null;
  /** 这一轮在哪台组内电脑运行(组内电脑的稳定键)；最早记的行没有区分，为 null。 */
  memberKey: string | null;
  kind: string;
  model: string;
  turns: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheCreateTokens: number;
  sdkCostUsd: number;
  lastAt: number;
}

export interface ProviderPartyUsage {
  /** null = 本机。 */
  deviceId: string | null;
  lastUsedAt: number;
  models: Array<Omit<PartyUsageRow, 'day' | 'providerId' | 'party' | 'deviceId' | 'lastAt'>>;
}

export interface ProviderPartyUsageQuery {
  local: ProviderPartyUsage | null;
  devices: ProviderPartyUsage[];
  relays: ProviderPartyUsage[];
}

/** 按天的明细：每天按(Agent、模型、组内电脑)分行，新的日子在前。 */
export interface ProviderPartyDailyUsage {
  lastUsedAt: number | null;
  days: Array<ProviderPartyUsage['models'][number] & { day: string }>;
}

export interface ProviderPartyUsageHistory {
  /** 你自己：本机、我的其他电脑与它们报告来的合成一份。 */
  self: ProviderPartyDailyUsage;
  /** 经其他电脑转来的，每台组所在电脑一项。 */
  relays: Array<ProviderPartyDailyUsage & { deviceId: string }>;
}

function localDay(at: number): string {
  const date = new Date(at);
  const pad = (value: number) => String(value).padStart(2, '0');
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function shiftDay(day: string, delta: number): string {
  return localDay(new Date(`${day}T12:00:00`).getTime() + delta * 86_400_000);
}

/**
 * 读盘时校验并补齐一行。最早的行没有 `party` 与 `memberKey`：按 deviceId 推出本机 / 我的其他电脑，
 * 组内电脑记为没区分(null)。
 */
function parseRow(value: unknown): PartyUsageRow | null {
  if (!value || typeof value !== 'object') return null;
  const row = value as Record<string, unknown>;
  const numbers = ['turns', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheCreateTokens', 'sdkCostUsd', 'lastAt'];
  const valid = typeof row.day === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(row.day)
    && typeof row.providerId === 'string' && row.providerId.length > 0
    && (row.deviceId === null || (typeof row.deviceId === 'string' && row.deviceId.length > 0))
    && (row.memberKey === undefined || row.memberKey === null || (typeof row.memberKey === 'string' && row.memberKey.length > 0))
    && typeof row.kind === 'string' && typeof row.model === 'string'
    && numbers.every((key) => typeof row[key] === 'number' && Number.isFinite(row[key] as number) && (row[key] as number) >= 0);
  if (!valid) return null;
  const party = row.party === undefined ? (row.deviceId === null ? 'local' : 'device') : row.party;
  if (!PARTY_KINDS.includes(party as PartyKind) || (party === 'local') !== (row.deviceId === null)) return null;
  return {
    ...(row as unknown as PartyUsageRow),
    party: party as PartyKind,
    memberKey: (row.memberKey as string | null | undefined) ?? null,
  };
}

export function createProviderPartyUsageStore(filePath: string, options: { now?: () => number } = {}) {
  const now = options.now ?? Date.now;
  let rows: Map<string, PartyUsageRow> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let writing: Promise<void> = Promise.resolve();

  const keyOf = (row: Pick<PartyUsageRow, 'day' | 'providerId' | 'party' | 'deviceId' | 'memberKey' | 'kind' | 'model'>) =>
    JSON.stringify([row.day, row.providerId, row.party, row.deviceId, row.memberKey, row.kind, row.model]);

  function load(): Map<string, PartyUsageRow> {
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

  function prune(map: Map<string, PartyUsageRow>): void {
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
    /** 记一轮；返回记在哪一天(本地日期)，没记返回 null。 */
    record(
      party: ProviderUsageParty,
      usage: { kind: string; providerId: string; memberKey: string; samples: readonly GuestUsageSample[] },
    ): string | null {
      if (!usage.providerId || !usage.memberKey || usage.samples.length === 0) return null;
      const deviceId = party.kind === 'local' ? null : party.deviceId;
      if (deviceId === '') return null;
      const map = load();
      const at = now();
      const day = localDay(at);
      for (const sample of usage.samples) {
        const identity = {
          day,
          providerId: usage.providerId,
          party: party.kind,
          deviceId,
          memberKey: usage.memberKey,
          kind: usage.kind,
          model: sample.model,
        };
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
      return day;
    },

    /** 本机经另一台电脑的组运行、要报告给它的用量：有这类用量的组所在电脑。 */
    groupOwners(): string[] {
      const owners = new Set<string>();
      for (const row of load().values()) if (row.party === 'group' && row.deviceId) owners.add(row.deviceId);
      return [...owners];
    },

    /** 要报告给某台组所在电脑的行(sinceDay 起，含当天；null = 全部)。 */
    groupReport(ownerDeviceId: string, sinceDay: string | null): ProviderGroupUsageReportRow[] {
      const out: ProviderGroupUsageReportRow[] = [];
      // 报告端与组所在电脑可能跨时区；多带两天，由接收端按 lastAt 的本地日期归一。
      const reportSinceDay = sinceDay ? shiftDay(sinceDay, -REPORT_DAY_CUSHION) : null;
      for (const row of load().values()) {
        if (row.party !== 'group' || row.deviceId !== ownerDeviceId || !row.memberKey) continue;
        if (reportSinceDay && row.day < reportSinceDay) continue;
        const { party, deviceId, memberKey, ...rest } = row;
        // 报告格式不携带来源方和设备字段；这里只保留按组内电脑的成员键。
        void party;
        void deviceId;
        out.push({ ...rest, memberKey });
      }
      return out.sort((a, b) => (a.day < b.day ? 1 : a.day > b.day ? -1 : 0));
    },

    /** 收到另一台电脑的报告：整体替换它从 sinceDay 起(null = 全部)的行。 */
    replaceReported(deviceId: string, sinceDay: string | null, incoming: readonly ProviderGroupUsageReportRow[]): void {
      if (!deviceId) return;
      const map = load();
      const replaceSinceDay = sinceDay ? shiftDay(sinceDay, -REPORT_DAY_CUSHION) : null;
      for (const [key, row] of map) {
        if (row.party === 'reported' && row.deviceId === deviceId && (!replaceSinceDay || row.day >= replaceSinceDay)) map.delete(key);
      }
      for (const item of incoming) {
        // day 是报告端的本地日期；lastAt 是共享协议里的 unix ms，以接收端时区为准重算。
        const day = item.lastAt > 0 ? localDay(item.lastAt) : item.day;
        if (replaceSinceDay && day < replaceSinceDay) continue;
        const row: PartyUsageRow = { ...item, day, party: 'reported', deviceId };
        const key = keyOf(row);
        const existing = map.get(key);
        if (existing) {
          existing.turns += row.turns;
          existing.inputTokens += row.inputTokens;
          existing.outputTokens += row.outputTokens;
          existing.cacheReadTokens += row.cacheReadTokens;
          existing.cacheCreateTokens += row.cacheCreateTokens;
          existing.sdkCostUsd += row.sdkCostUsd;
          existing.lastAt = Math.max(existing.lastAt, row.lastAt);
        } else {
          map.set(key, row);
        }
      }
      scheduleFlush();
    },

    /**
     * 某个供应商按使用方汇总：本机一项(没用过时为 null)，我的其他电脑与经其他电脑转来的每台一项；每项按
     * (Agent、模型、组内电脑)分行。其他电脑报告来的并进那台；本机要报告出去的不算。最近使用时间不受时间段限制。
     */
    query(providerId: string, range: ProviderShareUsageRange): ProviderPartyUsageQuery {
      const start = providerShareUsageRangeStart(range, now());
      const parties = new Map<string, ProviderPartyUsage & { party: PartyKind }>();
      for (const row of load().values()) {
        if (row.providerId !== providerId || row.party === 'group') continue;
        const bucket: PartyKind = row.party === 'reported' ? 'device' : row.party;
        const partyKey = JSON.stringify([bucket, row.deviceId]);
        const party = parties.get(partyKey) ?? { party: bucket, deviceId: row.deviceId, lastUsedAt: 0, models: [] };
        parties.set(partyKey, party);
        party.lastUsedAt = Math.max(party.lastUsedAt, row.lastAt);
        if (start && row.day < start) continue;
        const model = party.models.find(
          (item) => item.model === row.model && item.kind === row.kind && item.memberKey === row.memberKey,
        );
        if (model) {
          model.turns += row.turns;
          model.inputTokens += row.inputTokens;
          model.outputTokens += row.outputTokens;
          model.cacheReadTokens += row.cacheReadTokens;
          model.cacheCreateTokens += row.cacheCreateTokens;
          model.sdkCostUsd += row.sdkCostUsd;
        } else {
          party.models.push({
            kind: row.kind,
            model: row.model,
            memberKey: row.memberKey,
            turns: row.turns,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheCreateTokens: row.cacheCreateTokens,
            sdkCostUsd: row.sdkCostUsd,
          });
        }
      }
      const local: ProviderPartyUsage[] = [];
      const devices: ProviderPartyUsage[] = [];
      const relays: ProviderPartyUsage[] = [];
      for (const { party, ...usage } of parties.values()) {
        usage.models.sort((a, b) => b.turns - a.turns || a.model.localeCompare(b.model));
        (party === 'local' ? local : party === 'device' ? devices : relays).push(usage);
      }
      const recent = (a: ProviderPartyUsage, b: ProviderPartyUsage) => b.lastUsedAt - a.lastUsedAt;
      return { local: local[0] ?? null, devices: devices.sort(recent), relays: relays.sort(recent) };
    },

    /**
     * 某个供应商按天的明细(「用量」块在界面上按时间段、组内电脑筛选)：你自己(本机与我的其他电脑，
     * 含报告来的)合成一份，经其他电脑转来的按那台分开。本机要报告出去的不算，与 query 同口径。
     */
    history(providerId: string): ProviderPartyUsageHistory {
      const self: ProviderPartyDailyUsage = { lastUsedAt: null, days: [] };
      const relays = new Map<string, ProviderPartyDailyUsage & { deviceId: string }>();
      const selfDays = new Map<string, ProviderPartyDailyUsage['days'][number]>();
      for (const row of load().values()) {
        if (row.providerId !== providerId || row.party === 'group') continue;
        const day = {
          day: row.day,
          kind: row.kind,
          model: row.model,
          memberKey: row.memberKey,
          turns: row.turns,
          inputTokens: row.inputTokens,
          outputTokens: row.outputTokens,
          cacheReadTokens: row.cacheReadTokens,
          cacheCreateTokens: row.cacheCreateTokens,
          sdkCostUsd: row.sdkCostUsd,
        };
        if (row.party === 'relay' && row.deviceId) {
          const relay = relays.get(row.deviceId) ?? { deviceId: row.deviceId, lastUsedAt: null, days: [] };
          relays.set(row.deviceId, relay);
          relay.lastUsedAt = Math.max(relay.lastUsedAt ?? 0, row.lastAt);
          relay.days.push(day);
          continue;
        }
        self.lastUsedAt = Math.max(self.lastUsedAt ?? 0, row.lastAt);
        // 本机与我的其他电脑同一天、同一模型、同一台组内电脑的合成一行。
        const key = JSON.stringify([row.day, row.kind, row.model, row.memberKey]);
        const existing = selfDays.get(key);
        if (!existing) {
          selfDays.set(key, day);
          continue;
        }
        existing.turns += day.turns;
        existing.inputTokens += day.inputTokens;
        existing.outputTokens += day.outputTokens;
        existing.cacheReadTokens += day.cacheReadTokens;
        existing.cacheCreateTokens += day.cacheCreateTokens;
        existing.sdkCostUsd += day.sdkCostUsd;
      }
      const newestFirst = (a: { day: string; turns: number }, b: { day: string; turns: number }) =>
        a.day < b.day ? 1 : a.day > b.day ? -1 : b.turns - a.turns;
      self.days = [...selfDays.values()].sort(newestFirst);
      for (const relay of relays.values()) relay.days.sort(newestFirst);
      return {
        self,
        relays: [...relays.values()].sort((a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0)),
      };
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

export type ProviderPartyUsageStore = ReturnType<typeof createProviderPartyUsageStore>;

const stores = new Map<string, ProviderPartyUsageStore>();

/** 当前账号的账本；登录前是进程临时目录里的空账本(不读写任何账号的数据)。 */
export function currentProviderPartyUsageStore(): ProviderPartyUsageStore {
  const filePath = ownerScopedUserDataPath(FILE_NAME);
  let store = stores.get(filePath);
  if (!store) {
    store = createProviderPartyUsageStore(filePath);
    stores.set(filePath, store);
  }
  return store;
}

/** 退出前把各账号还没写盘的用量写完。 */
export async function flushProviderPartyUsage(): Promise<void> {
  await Promise.all([...stores.values()].map((store) => store.flush()));
}
