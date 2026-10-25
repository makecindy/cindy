/**
 * 供应商组的转分享(组所在电脑这一边；docs/product-rules/provider-sharing.md §4.3)。
 *
 * 组里有别人分享来的电脑，而组所在的这个供应商又分享给了别人：别人的任务要经组跑到那台电脑上，必须先由那台的
 * 主人逐人同意。这里按本机的组设置与本机分享出去的人，算出每台分享来的电脑该报上哪些人，经远程 Agent 的
 * op `reshare` 整体报给那台(本机是那台的受邀者)，记下每个人此刻的结果；给受邀者选电脑时只选同意过这个人的那台。
 *
 * 结果只在内存里，以那台电脑为准：组或分享的人变化后马上报一次；还有人等着、或那台读不到时每分钟再问一次，
 * 其余每 10 分钟核对一次；那台拒绝了某个人的任务时马上重问。没问到之前一律当作没同意(不分给那台)。
 * 本机分享出去的人还没读到时不报：整体替换会把那台上已有的同意清掉。
 * 移出全部组的清理与组设置一起持久保存，空名单确认后才删除；离线每分钟重试，重启与重新加入都先完成清理。
 */
import { randomUUID } from 'node:crypto';

import {
  REMOTE_AGENT_MAX_RESHARE_ENTRIES,
  parseRemoteAgentReshareResult,
  type ProviderShareOwned,
  type RemoteAgentCaps,
  type RemoteAgentReshareBatch,
  type RemoteAgentReshareEntry,
  type RemoteAgentReshareState,
} from '@cindy/device-link';

import type { ProviderGroupConfig, ProviderGroupReshareGuest, ProviderGroupReshareSummary } from '../shared/providerGroup.js';
import { reshareKeyFor } from '../host/groupRelay.js';

/** 还有人等着同意、或那台读不到时，多久再问一次。 */
export const PROVIDER_GROUP_RESHARE_PENDING_POLL_MS = 60_000;
/** 都有结果时多久核对一次(主人可能撤回)。 */
export const PROVIDER_GROUP_RESHARE_IDLE_POLL_MS = 10 * 60_000;
/** 变化后合并成一次报告的等待。 */
export const PROVIDER_GROUP_RESHARE_DEBOUNCE_MS = 1_000;
/** 设置页打开时，上次核对超过这么久就再问一次。 */
export const PROVIDER_GROUP_RESHARE_VIEW_REFRESH_MS = 15_000;

export interface ProviderGroupReshareDeps {
  listGroups(): Record<string, ProviderGroupConfig>;
  /** 本机分享出去的供应商与其成员；还没读到(或读不到)时为 null。 */
  ownedShares(): readonly ProviderShareOwned[] | null;
  /** 与移出组一起持久保存的清理代次；重新加入也须先清空旧同意。 */
  pendingCleanups(): Readonly<Record<string, string>>;
  completeCleanup(agentDeviceId: string, token: string): Promise<void>;
  readCaps(agentDeviceId: string): Promise<RemoteAgentCaps>;
  /** 经远程 Agent 通道发给那台电脑(本机是那台的受邀者)，返回回包；失败抛错。 */
  invoke(agentDeviceId: string, request: unknown): Promise<unknown>;
  /** 结果有变化(设置页重读)。 */
  changed?(): void;
  now(): number;
  log: { info?(message: string, meta?: Record<string, unknown>): void; warn(message: string, meta?: Record<string, unknown>): void };
}

type DeviceSupport = 'supported' | 'needs-update' | 'unknown';

interface DeviceState {
  support: DeviceSupport;
  states: Map<string, ProviderGroupReshareGuest['state']>;
  /** 上次成功报上去的内容；变了才需要立即再报。 */
  sentSignature: string | null;
  checkedAt: number;
  failed: boolean;
  cleanupToken?: string;
}

interface DesiredGuest {
  memberId: string;
  displayName: string;
  avatarUrl: string | null;
  entry: RemoteAgentReshareEntry;
}

export interface ProviderGroupReshare {
  /** 分享来的那台电脑的主人是否同意过这个受邀者。 */
  allows(agentDeviceId: string, reshareKey: string | undefined): boolean;
  /** 那台给不出同意(版本太旧)。 */
  needsUpdate(agentDeviceId: string): boolean;
  /** 设置页：这个供应商的组里这台分享来的电脑对本机分享的每个人的结果；本机没分享给任何人时为 null。 */
  summary(providerId: string, agentDeviceId: string): ProviderGroupReshareSummary | null;
  /** 组或分享的人变了：合并后报一次。 */
  kick(reason: string): void;
  /** 设置页打开：上次核对较久时再问一次。 */
  refreshIfStale(): void;
  /** 那台拒绝了这个人的任务：先当作没同意，马上重问。 */
  noteDenied(agentDeviceId: string, reshareKey: string): void;
  /** 立即报一次(测试与调用方需要等结果时)。force：每台都现问。 */
  sync(reason: string, options?: { force?: boolean }): Promise<void>;
  stop(): void;
}

function signatureOf(entries: readonly RemoteAgentReshareEntry[]): string {
  return JSON.stringify([...entries].sort((a, b) => a.key.localeCompare(b.key)).map((e) => [e.key, e.name, e.avatar ?? null]));
}

export function createProviderGroupReshare(deps: ProviderGroupReshareDeps): ProviderGroupReshare {
  const devices = new Map<string, DeviceState>();
  /** 下一次定时核对。 */
  let timer: ReturnType<typeof setTimeout> | null = null;
  /** 变化后合并成一次报告(与定时核对分开：报告结束时重排定时核对不能吞掉刚来的变化)。 */
  let kickTimer: ReturnType<typeof setTimeout> | null = null;
  let running: Promise<void> | null = null;
  let again = false;
  let againForce = false;
  let stopped = false;

  /** 每台分享来的电脑该报上的人(按转分享键去重)；本机分享出去的人还没读到时为 null。 */
  function desired(): Map<string, Map<string, DesiredGuest>> | null {
    const owned = deps.ownedShares();
    if (!owned) return null;
    const out = new Map<string, Map<string, DesiredGuest>>();
    for (const [providerId, config] of Object.entries(deps.listGroups())) {
      const shareMembers = config.members.filter((m) => m.kind === 'share' && m.agentDeviceId);
      if (shareMembers.length === 0) continue;
      const guests: DesiredGuest[] = owned
        .filter((share) => share.providerId === providerId)
        .flatMap((share) => share.members.map((member) => ({
          memberId: member.memberId,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          entry: {
            key: reshareKeyFor(share.shareId, member.memberId),
            name: member.displayName,
            ...(member.avatarUrl ? { avatar: member.avatarUrl } : {}),
          },
        })));
      for (const member of shareMembers) {
        const list = out.get(member.agentDeviceId!) ?? new Map<string, DesiredGuest>();
        for (const guest of guests) list.set(guest.entry.key, guest);
        out.set(member.agentDeviceId!, list);
      }
    }
    return out;
  }

  async function syncDevice(agentDeviceId: string, entries: RemoteAgentReshareEntry[], cleanupToken?: string): Promise<boolean> {
    const state: DeviceState = devices.get(agentDeviceId) ?? {
      support: 'unknown', states: new Map(), sentSignature: null, checkedAt: 0, failed: false,
    } satisfies DeviceState;
    devices.set(agentDeviceId, state);
    const before = JSON.stringify([state.support, [...state.states]]);
    const signature = signatureOf(entries);
    if (cleanupToken) {
      state.cleanupToken = cleanupToken;
      state.states.clear();
      state.sentSignature = null;
    }
    try {
      const caps = await deps.readCaps(agentDeviceId);
      if (stopped) return false;
      if (!cleanupToken && deps.pendingCleanups()[agentDeviceId]) return false;
      if (caps.reshareConsent !== true || (entries.length > REMOTE_AGENT_MAX_RESHARE_ENTRIES && caps.reshareBatch !== true)) {
        // 旧版本给不出同意：这台不分给受邀者，设置页提示那台需要更新。
        state.support = 'needs-update';
        state.states = new Map();
        // 降级的电脑不能确认已清空；保留清理，升级或恢复后再报。
        if (cleanupToken) throw new Error('The shared computer cannot confirm reshare cleanup yet');
      } else {
        const batchId = entries.length > REMOTE_AGENT_MAX_RESHARE_ENTRIES ? randomUUID() : null;
        const batches: Array<{ entries: RemoteAgentReshareEntry[]; batch?: RemoteAgentReshareBatch }> = [];
        if (!batchId) batches.push({ entries });
        else {
          for (let index = 0; index < entries.length; index += REMOTE_AGENT_MAX_RESHARE_ENTRIES) {
            batches.push({
              entries: entries.slice(index, index + REMOTE_AGENT_MAX_RESHARE_ENTRIES),
              batch: { id: batchId, index: batches.length, count: Math.ceil(entries.length / REMOTE_AGENT_MAX_RESHARE_ENTRIES) },
            });
          }
        }
        const states = new Map<string, RemoteAgentReshareState>();
        for (const current of batches) {
          const request = { op: 'reshare', entries: current.entries, ...(current.batch ? { batch: current.batch } : {}) };
          const result = parseRemoteAgentReshareResult(
            await deps.invoke(agentDeviceId, request),
            current.batch && current.batch.index === current.batch.count - 1
              ? new Set(entries.map((entry) => entry.key))
              : new Set(current.entries.map((entry) => entry.key)),
          );
          if (current.batch) {
            if (!result.batch || result.batch.id !== current.batch.id || result.batch.index !== current.batch.index || result.batch.count !== current.batch.count) {
              throw new Error('Invalid reshare batch response');
            }
            // 重试已完成批次时，接收端会对任意重复片段回 complete=true；只要求最后一片
            // 的正常回包必须表示已整体替换，不能把幂等重试误判成协议错误。
            if (current.batch.index === current.batch.count - 1 && !result.batch.complete) {
              throw new Error('Incomplete reshare batch response');
            }
          }
          for (const entry of result.entries) states.set(entry.key, entry.state);
        }
        const result = { entries: [...states].map(([key, state]) => ({ key, state })) };
        if (stopped) return false;
        if (cleanupToken) {
          await deps.completeCleanup(agentDeviceId, cleanupToken);
          if (stopped) return false;
          devices.delete(agentDeviceId);
          return true;
        }
        if (deps.pendingCleanups()[agentDeviceId]) {
          state.states.clear();
          return true;
        }
        state.support = 'supported';
        state.states = new Map(result.entries.map((entry) => [entry.key, entry.state]));
      }
      state.sentSignature = signature;
      state.failed = false;
    } catch (error) {
      // 读不到(离线、分享暂停等)：保留上次的结果(那台本来也选不上)，稍后再问。
      state.failed = true;
      deps.log.info?.('provider group: reshare sync failed', {
        device: agentDeviceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    state.checkedAt = deps.now();
    if (!devices.has(agentDeviceId)) return false;
    return JSON.stringify([state.support, [...state.states]]) !== before;
  }

  /** 这台多久再问一次：还有人等着、或上次读不到时每分钟，其余每 10 分钟。 */
  function intervalFor(agentDeviceId: string, guests: ReadonlyMap<string, DesiredGuest>): number {
    const state = devices.get(agentDeviceId);
    if (!state || state.failed) return PROVIDER_GROUP_RESHARE_PENDING_POLL_MS;
    if (state.support === 'supported') {
      for (const key of guests.keys()) {
        const value = state.states.get(key);
        if (value === undefined || value === 'pending') return PROVIDER_GROUP_RESHARE_PENDING_POLL_MS;
      }
    }
    return PROVIDER_GROUP_RESHARE_IDLE_POLL_MS;
  }

  function nextDelay(want: Map<string, Map<string, DesiredGuest>> | null): number | null {
    let delay: number | null = want ? null : PROVIDER_GROUP_RESHARE_PENDING_POLL_MS;
    const cleanups = deps.pendingCleanups();
    for (const [agentDeviceId, token] of Object.entries(cleanups)) {
      const state = devices.get(agentDeviceId);
      const elapsed = state?.cleanupToken === token ? deps.now() - state.checkedAt : Infinity;
      const remaining = Math.max(0, PROVIDER_GROUP_RESHARE_PENDING_POLL_MS - elapsed);
      delay = delay === null ? remaining : Math.min(delay, remaining);
    }
    for (const [agentDeviceId, guests] of want ?? []) {
      if (cleanups[agentDeviceId]) continue;
      const state = devices.get(agentDeviceId);
      // 空名单已确认后无须轮询；失败的空名单仍按一分钟重试。
      if (guests.size === 0 && state?.sentSignature === signatureOf([]) && !state.failed) continue;
      const elapsed = state ? deps.now() - state.checkedAt : Infinity;
      const remaining = Math.max(0, intervalFor(agentDeviceId, guests) - elapsed);
      delay = delay === null ? remaining : Math.min(delay, remaining);
    }
    return delay;
  }

  function schedule(delay: number | null): void {
    if (timer) clearTimeout(timer);
    timer = null;
    if (stopped || delay === null) return;
    timer = setTimeout(() => {
      timer = null;
      void sync('poll');
    }, delay);
    (timer as { unref?: () => void }).unref?.();
  }

  /** force：每台都现问(设置页打开、那台刚拒绝了人)；否则只问报上的人变了的、或到了核对时间的。 */
  async function runOnce(force: boolean): Promise<void> {
    let changed = false;
    // 清理先于重新报人；即使分享名单尚未读到，也能继续已持久保存的清理。
    const cleanups = Object.entries(deps.pendingCleanups());
    if (cleanups.length > 0) {
      await Promise.all(cleanups.map(async ([agentDeviceId, token]) => {
        const state = devices.get(agentDeviceId);
        if (!force && state?.cleanupToken === token
          && deps.now() - state.checkedAt < PROVIDER_GROUP_RESHARE_PENDING_POLL_MS) return;
        if (await syncDevice(agentDeviceId, [], token)) changed = true;
      }));
    }
    if (stopped) return;
    const want = desired();
    if (!want) {
      if (changed) deps.changed?.();
      schedule(nextDelay(null));
      return;
    }
    // 待清理的电脑必须继续留在调度里；其余已移出的缓存不再保留。
    for (const agentDeviceId of devices.keys()) {
      if (want.has(agentDeviceId) || deps.pendingCleanups()[agentDeviceId]) continue;
      devices.delete(agentDeviceId);
      changed = true;
    }
    await Promise.all([...want].map(async ([agentDeviceId, guests]) => {
      if (deps.pendingCleanups()[agentDeviceId]) return;
      const entries = [...guests.values()].map((guest) => guest.entry);
      const state = devices.get(agentDeviceId);
      const signature = signatureOf(entries);
      // 没有分享给任何人、空名单也已报过：没有要问的。
      if (!force && entries.length === 0 && state?.sentSignature === signature && !state.failed) return;
      const due = force || !state || state.sentSignature !== signature
        || deps.now() - state.checkedAt >= intervalFor(agentDeviceId, guests);
      if (!due) return;
      if (await syncDevice(agentDeviceId, entries)) changed = true;
    }));
    if (stopped) return;
    if (changed) deps.changed?.();
    schedule(nextDelay(desired()));
  }

  async function sync(reason: string, options: { force?: boolean } = {}): Promise<void> {
    if (stopped) return;
    if (running) {
      again = true;
      againForce ||= options.force === true;
      return running;
    }
    let force = options.force === true;
    running = (async () => {
      try {
        do {
          again = false;
          againForce = false;
          await runOnce(force);
          force = againForce;
        } while (again && !stopped);
      } catch (error) {
        deps.log.warn('provider group: reshare sync crashed', { reason, error: error instanceof Error ? error.message : String(error) });
        schedule(PROVIDER_GROUP_RESHARE_PENDING_POLL_MS);
      } finally {
        running = null;
      }
    })();
    return running;
  }

  return {
    allows(agentDeviceId, reshareKey) {
      if (!reshareKey || deps.pendingCleanups()[agentDeviceId]) return false;
      return devices.get(agentDeviceId)?.states.get(reshareKey) === 'approved';
    },
    needsUpdate(agentDeviceId) {
      return devices.get(agentDeviceId)?.support === 'needs-update';
    },
    summary(providerId, agentDeviceId) {
      const owned = deps.ownedShares();
      if (!owned) return null;
      const shares = owned.filter((share) => share.providerId === providerId);
      const people = shares.flatMap((share) => share.members.map((member) => ({ share, member })));
      if (people.length === 0) return null;
      const state = deps.pendingCleanups()[agentDeviceId] ? undefined : devices.get(agentDeviceId);
      return {
        support: state?.support ?? 'unknown',
        guests: people.map(({ share, member }): ProviderGroupReshareGuest => ({
          memberId: member.memberId,
          displayName: member.displayName,
          avatarUrl: member.avatarUrl,
          state: state?.support === 'supported'
            ? state.states.get(reshareKeyFor(share.shareId, member.memberId)) ?? 'unknown'
            : 'unknown',
        })),
      };
    },
    kick(reason) {
      if (stopped) return;
      if (kickTimer) clearTimeout(kickTimer);
      kickTimer = setTimeout(() => {
        kickTimer = null;
        void sync(reason);
      }, PROVIDER_GROUP_RESHARE_DEBOUNCE_MS);
      (kickTimer as { unref?: () => void }).unref?.();
    },
    refreshIfStale() {
      const now = deps.now();
      const stale = [...devices.values()].some((state) => now - state.checkedAt >= PROVIDER_GROUP_RESHARE_VIEW_REFRESH_MS);
      if (stale) void sync('view', { force: true });
      else if (devices.size === 0) void sync('view');
    },
    noteDenied(agentDeviceId, reshareKey) {
      const state = devices.get(agentDeviceId);
      if (state?.states.get(reshareKey) === 'approved') {
        state.states.delete(reshareKey);
        deps.changed?.();
      }
      void sync('denied', { force: true });
    },
    sync,
    stop() {
      stopped = true;
      if (timer) clearTimeout(timer);
      if (kickTimer) clearTimeout(kickTimer);
      timer = null;
      kickTimer = null;
      devices.clear();
    },
  };
}
