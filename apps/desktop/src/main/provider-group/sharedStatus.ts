/**
 * 受邀者可见的组状态：白名单投影，不携带组员身份和用量，也不分配任务或改变冷却。
 * 按电脑而不是按账号列(provider-groups.md §10，2026-10-15)：同一台电脑上的几个账号合成一项，受邀者看不出有几个账号。
 */
import type { ProviderShareGroupState, RemoteAgentCaps } from '@cindy/device-link';

import {
  providerGroupPhysicalDeviceKey,
  type ProviderGroupConfig,
  type ProviderGroupGuestSupport,
  type ProviderGroupMember,
} from '../../shared/providerGroup.js';
import type { ProviderGroupOwnerScope } from './runtime.js';

export const SHARED_GROUP_STATUS_TIMEOUT_MS = 3_000;
export const SHARED_GROUP_STATUS_CAPS_CONCURRENCY = 4;
export const SHARED_GROUP_STATUS_CAPS_CACHE_MS = 15_000;

export interface SharedGroupStatusDeps {
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  readCaps(member: ProviderGroupMember): Promise<RemoteAgentCaps>;
  isIncapable(agentDeviceId: string): boolean;
  /**
   * 转分享(provider-sharing.md §4.3)：分享来的电脑的主人没同意过读状态的这个受邀者时，他看到的状态
   * (暂不可用，或那台需要更新才能同意)；同意过或不是分享来的电脑返回 null。
   */
  reshareState?(member: ProviderGroupMember): ProviderShareGroupState | null;
}

async function readWithin<T>(read: () => Promise<T>): Promise<T | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(read).catch(() => null),
      new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), SHARED_GROUP_STATUS_TIMEOUT_MS); }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

const sharedSupportReaders = new WeakMap<ProviderGroupOwnerScope['router'], ReturnType<typeof createGuestSupportReader>>();

/** 按电脑合并有界能力探测，保留物理在途槽与短缓存；沿用真正接收分享任务时的能力条件。 */
export function createGuestSupportReader(readCaps: SharedGroupStatusDeps['readCaps']) {
  const caps = new Map<string, { promise: Promise<RemoteAgentCaps | null>; expiresAt: number }>();
  const queued = new Set<() => void>();
  let active = 0;
  function drain() {
    for (const start of queued) {
      if (active >= SHARED_GROUP_STATUS_CAPS_CONCURRENCY) break;
      start();
    }
  }
  return async (member: ProviderGroupMember): Promise<ProviderGroupGuestSupport> => {
    if (!member.agentDeviceId) return 'supported';
    const deviceKey = providerGroupPhysicalDeviceKey(member);
    const now = Date.now();
    for (const [key, entry] of caps) {
      if (entry.expiresAt <= now) caps.delete(key);
    }
    let pending = caps.get(deviceKey);
    if (!pending) {
      const promise = new Promise<RemoteAgentCaps | null>((resolve) => {
        const cancel = () => {
          queued.delete(start);
          clearTimeout(timer);
          caps.delete(deviceKey);
          resolve(null);
        };
        const start = () => {
          if (Date.now() >= now + SHARED_GROUP_STATUS_TIMEOUT_MS) {
            cancel();
            return;
          }
          queued.delete(start);
          clearTimeout(timer);
          active += 1;
          void Promise.resolve().then(() => readCaps(member)).catch(() => null).then(resolve).finally(() => {
            active -= 1;
            drain();
          });
        };
        const timer = setTimeout(cancel, SHARED_GROUP_STATUS_TIMEOUT_MS);
        queued.add(start);
        drain();
      });
      const entry = { promise, expiresAt: Infinity };
      void promise.then(() => { entry.expiresAt = Date.now() + SHARED_GROUP_STATUS_CAPS_CACHE_MS; });
      pending = entry;
      caps.set(deviceKey, pending);
    }
    const promise = pending.promise;
    const capability = await readWithin(() => promise);
    if (!capability) return 'unknown';
    return capability.virtualWorkspace === true
      && (member.kind === 'device'
        ? capability.guestRelay === true
        : member.kind !== 'share' || capability.reshareConsent === true)
      ? 'supported' : 'needs-update';
  };
}

export async function readSharedGroupStatus(deps: SharedGroupStatusDeps, providerId: string): Promise<ProviderShareGroupState[] | null> {
  const scope = deps.scope();
  const config = deps.readGroup(providerId);
  if (!config) return null;
  const view = await readWithin(() => scope.router.view(providerId));
  if (!scope.isCurrent()) return null;
  const readSupport = sharedSupportReaders.get(scope.router) ?? createGuestSupportReader(async (member) => {
    if (!scope.isCurrent()) throw new Error('The account changed');
    return deps.readCaps(member);
  });
  sharedSupportReaders.set(scope.router, readSupport);
  const states = await Promise.all(config.members.map(async (member): Promise<ProviderShareGroupState> => {
    if (member.paused) return 'paused';
    const status = view?.members.find((item) => item.key === member.key);
    if (!status) return 'unknown';
    if (status.state !== 'available' && status.state !== 'full') return status.state;
    // 与实际分配一致：主人没同意过这个人的分享来的电脑不会分给他。
    const reshare = deps.reshareState?.(member) ?? null;
    if (reshare) return reshare;
    if (member.agentDeviceId) {
      // 与实际接任务的条件一致；旧版同账号组员可能主人能用，受邀者却不能用。
      if (member.kind === 'device' && deps.isIncapable(member.agentDeviceId)) return 'needs-update';
      const support = await readSupport(member);
      if (support !== 'supported') return support;
    }
    // 满载仍能接任务；只报粗略忙闲，绝不返回任务数和上限。
    return status.running > 0 || status.state === 'full' ? 'busy' : 'available';
  }));
  // 读取期间换账号或编辑组时丢弃快照，避免将旧组状态贴到新组序号上。
  const latest = deps.readGroup(providerId);
  return scope.isCurrent() && JSON.stringify(latest) === JSON.stringify(config)
    ? sharedGroupComputerStates(config.members, states)
    : null;
}

/**
 * 一台电脑有几个账号时取最能接任务的那个状态：有一个能接就能接；都不能接时，还没确认的优先(不能断言不可用)，
 * 其次是需要那台更新或会自己恢复的原因，最后才是暂停、不可用与离线。
 */
const COMPUTER_STATE_ORDER: readonly ProviderShareGroupState[] = [
  'available', 'busy', 'unknown', 'needs-update', 'cooling', 'paused', 'unavailable', 'offline',
];

/** 按电脑合并账号状态，顺序是每台电脑第一个账号在组里的位置；项数与给受邀者的台数(`sharedProviderGroupSize`)一致。 */
export function sharedGroupComputerStates(
  members: readonly ProviderGroupMember[],
  states: readonly ProviderShareGroupState[],
): ProviderShareGroupState[] {
  const computers = new Map<string, ProviderShareGroupState>();
  members.forEach((member, index) => {
    const key = providerGroupPhysicalDeviceKey(member);
    const state = states[index] ?? 'unknown';
    const current = computers.get(key);
    if (current === undefined || COMPUTER_STATE_ORDER.indexOf(state) < COMPUTER_STATE_ORDER.indexOf(current)) {
      computers.set(key, state);
    }
  });
  return [...computers.values()];
}
