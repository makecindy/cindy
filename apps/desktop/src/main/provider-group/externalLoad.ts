/**
 * 经本组分出去、但不在本机任务表里的运行中任务(docs/product-rules/provider-groups.md §5)：
 * 同账号其他电脑经组运行的任务由那台电脑直接连到组内电脑，组所在电脑看不到它们，只能靠那台电脑报告。
 *
 * - 报告(lease)：每台电脑整体上报它正在运行的经组任务，过期(电脑离开、崩溃)自动作废；`seq` 只增，
 *   乱序到达的旧报告丢弃，不会盖掉新的。
 * - 临时占用：刚选中、还没来得及报告的任务先记一会儿，同时开的几个任务不会全落到同一台。
 *
 * 只用于分摊负载(并发上限不因满载拒绝消息)，不落盘；重启后等各电脑重新报告。
 */
import type { ProviderGroupRemoteLease } from '../../shared/providerGroup.js';

/** 报告多久不刷新就作废(那台电脑每 60s 刷新一次)。 */
export const PROVIDER_GROUP_LEASE_TTL_MS = 150_000;
/** 选中后、报告到达前的临时占用时长。 */
export const PROVIDER_GROUP_PROVISIONAL_MS = 30_000;
/** 防止异常对端无限占内存的边界，远高于实际同账号电脑数。 */
const MAX_CONTROLLERS = 256;
const MAX_PROVISIONAL = 4096;

/** 计入某台组内电脑负载的一个任务(按它是否正在运行一轮)；任务结束时 release。 */
export interface ProviderGroupLoadHandle {
  setRunning(running: boolean): void;
  release(): void;
}

export interface ProviderGroupExternalLoad {
  /** 这台组内电脑上经本组运行、但不在本机任务表里的任务数。 */
  running(providerId: string, memberKey: string): number;
  /** 刚给某台电脑的某个任务选了组内电脑。 */
  recordPick(controller: string, sessionId: string, providerId: string, memberKey: string): void;
  /** 某台电脑的整份报告；返回 false = 比已有的旧，被丢弃。 */
  replaceLeases(controller: string, seq: number, entries: readonly ProviderGroupRemoteLease[]): boolean;
  /**
   * 本机替受邀者运行的任务(中转到这台组内电脑，或组选中本机这一台；本机能看到它是否在运行一轮)：
   * 任务结束时 release。
   */
  trackRelay(providerId: string, memberKey: string): ProviderGroupLoadHandle;
}

interface LeaseSet {
  seq: number;
  at: number;
  entries: readonly ProviderGroupRemoteLease[];
}

interface Provisional {
  controller: string;
  sessionId: string;
  providerId: string;
  memberKey: string;
  until: number;
}

export function createProviderGroupExternalLoad(deps: { now(): number }): ProviderGroupExternalLoad {
  const leases = new Map<string, LeaseSet>();
  const provisional = new Map<string, Provisional>();
  const relays = new Set<{ providerId: string; memberKey: string; running: boolean }>();
  const provisionalKey = (controller: string, sessionId: string) => `${controller}\u0000${sessionId}`;

  function liveLeases(controller: string): LeaseSet | null {
    const set = leases.get(controller);
    if (!set) return null;
    if (deps.now() - set.at > PROVIDER_GROUP_LEASE_TTL_MS) {
      // 过期的报告只作废内容，保留 seq：之后迟到的旧报告仍按序号丢弃。
      if (set.entries.length) leases.set(controller, { ...set, entries: [] });
      return null;
    }
    return set;
  }

  function sweepProvisional(now: number): void {
    for (const [key, entry] of provisional) {
      if (entry.until <= now) provisional.delete(key);
    }
  }

  return {
    running(providerId, memberKey) {
      const now = deps.now();
      sweepProvisional(now);
      let count = 0;
      const reported = new Set<string>();
      for (const controller of leases.keys()) {
        const set = liveLeases(controller);
        if (!set) continue;
        for (const lease of set.entries) {
          reported.add(provisionalKey(controller, lease.sessionId));
          if (lease.providerId === providerId && lease.memberKey === memberKey) count++;
        }
      }
      for (const [key, entry] of provisional) {
        // 已经报告过的任务以报告为准，不重复计数。
        if (reported.has(key)) continue;
        if (entry.providerId === providerId && entry.memberKey === memberKey) count++;
      }
      for (const relay of relays) {
        if (relay.running && relay.providerId === providerId && relay.memberKey === memberKey) count++;
      }
      return count;
    },

    trackRelay(providerId, memberKey) {
      // 刚交过去、还没报运行状态的先按在运行算(同时来的几个受邀者任务不会全落到同一台)。
      const entry = { providerId, memberKey, running: true };
      relays.add(entry);
      return {
        setRunning(running) {
          entry.running = running;
        },
        release() {
          relays.delete(entry);
        },
      };
    },

    recordPick(controller, sessionId, providerId, memberKey) {
      const now = deps.now();
      sweepProvisional(now);
      const key = provisionalKey(controller, sessionId);
      provisional.delete(key);
      if (provisional.size >= MAX_PROVISIONAL) {
        const oldest = provisional.keys().next().value;
        if (oldest !== undefined) provisional.delete(oldest);
      }
      provisional.set(key, { controller, sessionId, providerId, memberKey, until: now + PROVIDER_GROUP_PROVISIONAL_MS });
    },

    replaceLeases(controller, seq, entries) {
      const previous = leases.get(controller);
      if (previous && seq <= previous.seq) return false;
      if (!previous && leases.size >= MAX_CONTROLLERS) {
        // 淘汰最久没有报告的一台。
        let oldestKey: string | null = null;
        let oldestAt = Infinity;
        for (const [key, set] of leases) {
          if (set.at < oldestAt) {
            oldestAt = set.at;
            oldestKey = key;
          }
        }
        if (oldestKey !== null) leases.delete(oldestKey);
      }
      leases.set(controller, { seq, at: deps.now(), entries: [...entries] });
      // 报告里已有的任务不再需要临时占用。报告里还没有的保留到过期：这份报告可能早于那次选中。
      for (const [key, entry] of provisional) {
        if (entry.controller === controller && entries.some((lease) => lease.sessionId === entry.sessionId)) {
          provisional.delete(key);
        }
      }
      return true;
    },
  };
}
