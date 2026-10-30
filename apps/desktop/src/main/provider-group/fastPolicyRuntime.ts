import { REMOTE_AGENT_CHANNEL, parseRemoteAgentCaps, providerShareGuestPeer } from '@cindy/device-link';
import type { RemoteAgentFastPolicy } from '@cindy/device-link';
import { supportsSubscriptionFastPolicy } from '@cindy/model-providers';
import { getSelfDeviceId, remoteBackgroundInvoke } from '../device-link/index.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { notifySubscriptionFastPolicyChanged } from '../maker-host/subscription-fast-policy.js';
import { captureProviderManagementScope } from './managementScope.js';
import { activeOwnerScopeKey } from '../appSessionState.js';
import { readProviderGroup, listProviderGroups } from './store.js';
import { groupFastPolicyStore } from './fastPolicyStore.js';
import { checkProviderShareDelegation } from '../device-link/providerShareApi.js';
import { hostSessionIdFor } from '../remote-agent/host/sessionIdentity.js';

const eligible = (group: string) =>
  supportsSubscriptionFastPolicy(getActiveCatalog().providers.find((p) => p.id === group));
const LOCAL_TARGET = '@local';
const targets = (group: string) => {
  const config = readProviderGroup(group);
  if (!config) return [];
  // A guest may already have been assigned here by another group. Local
  // enforcement is independent of membership, so its source must also receive
  // later prohibitions/releases when this group has only remote members.
  return [
    ...new Set([
      LOCAL_TARGET,
      ...config.members.flatMap((member) =>
        member.kind === 'local' ? [] : member.agentDeviceId ? [member.agentDeviceId] : [],
      ),
    ]),
  ];
};
const syncing = new Map<string, Promise<void>>();
const RETRY_INITIAL_MS = 5_000;
const RETRY_MAX_MS = 5 * 60_000;
interface TargetRetry {
  delayMs: number;
  retryAt: number;
}
let retryOwner: string | undefined;
const retries = new Map<string, { revision: number; targets: Map<string, TargetRetry> }>();

function retriesFor(group: string, revision: number): Map<string, TargetRetry> {
  const owner = activeOwnerScopeKey();
  if (retryOwner !== owner) {
    retries.clear();
    retryOwner = owner;
  }
  let state = retries.get(group);
  if (state?.revision !== revision) {
    state = { revision, targets: new Map() };
    retries.set(group, state);
  }
  return state.targets;
}

async function send(
  device: string,
  command: RemoteAgentFastPolicy,
  assertCurrent: () => void,
): Promise<void> {
  assertCurrent();
  const invoke = async (request: Record<string, unknown>) => {
    try {
      return await remoteBackgroundInvoke(device, REMOTE_AGENT_CHANNEL, [request]);
    } catch {
      // Transport failures can reject instead of returning an IPC error. Keep
      // them retryable without disguising an owner change as a link failure.
      assertCurrent();
      throw new Error(
        '[REMOTE_AGENT_UNAVAILABLE] Subscription Fast policy executor is unreachable',
      );
    }
  };
  const caps = await invoke({ op: 'caps' });
  assertCurrent();
  if (!caps.ok) {
    throw new Error('[REMOTE_AGENT_UNAVAILABLE] Subscription Fast policy executor is unreachable');
  }
  if (!parseRemoteAgentCaps(caps.result).subscriptionFastPolicy) {
    throw new Error(
      '[REMOTE_AGENT_PEER_TOO_OLD] Update this computer to enforce the subscription Fast policy',
    );
  }
  const result = await invoke({ op: 'fast-policy', ...command });
  assertCurrent();
  const ack = (result.ok ? result.result : undefined) as
    { revision?: number; allowFast?: boolean } | undefined;
  if (
    !result.ok ||
    !ack ||
    ack.revision !== command.revision ||
    ack.allowFast !== command.allowFast
  ) {
    throw new Error('[REMOTE_AGENT_UNAVAILABLE] Subscription Fast policy has not been confirmed');
  }
}

export async function receiveGroupFastPolicy(
  origin: string,
  command: RemoteAgentFastPolicy,
): Promise<unknown> {
  const assertCurrent = captureProviderManagementScope();
  const delegated = command.binding?.providerShareGuest;
  let directTask: string | undefined;
  if (delegated && command.binding) {
    const guest = providerShareGuestPeer(delegated.shareId, delegated.memberId, delegated.guestDeviceId);
    const self = getSelfDeviceId();
    if (!self) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Computer identity is not ready');
    // Prebind before M grants an executable task lease. Only the server-approved
    // O may name this guest's task; an unrelated same-account device is not O.
    const approved = await checkProviderShareDelegation({ ...delegated, executorDeviceId: self });
    assertCurrent();
    if (getSelfDeviceId() !== self || !approved.active || approved.ownerDeviceId !== origin
      || !approved.expiresAt || approved.expiresAt <= Date.now()) {
      throw new Error('[REMOTE_AGENT_INVALID] Provider-share Fast binding requires an active owner delegation');
    }
    directTask = hostSessionIdFor(guest, command.binding.sessionId);
  }
  const result = await groupFastPolicyStore.receive(
    origin,
    command,
    getSelfDeviceId(),
    assertCurrent,
    directTask,
  );
  await notifySubscriptionFastPolicyChanged();
  assertCurrent();
  return result;
}

export async function bindLocalHostedGroupFastPolicy(
  group: string,
  hostSessionId: string,
): Promise<void> {
  if (!eligible(group)) return;
  const assertCurrent = captureProviderManagementScope();
  const state = await groupFastPolicyStore.prepare(
    group,
    readProviderGroup(group)?.allowFast !== false,
    [],
    assertCurrent,
  );
  const self = getSelfDeviceId();
  if (!self) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Computer identity is not ready');
  await groupFastPolicyStore.receive(
    self,
    { group, ...state, binding: { sessionId: hostSessionId } },
    self,
    assertCurrent,
    hostSessionId,
  );
  await notifySubscriptionFastPolicyChanged();
}

/** Registration is authenticated from group owner to executor, before returning a route to the consumer. */
export async function bindGroupFastPolicy(input: {
  group: string;
  deviceId?: string | null;
  sessionId: string;
  controllerDeviceId?: string;
  relay?: string;
  providerShareGuest?: { shareId: string; memberId: string; guestDeviceId: string };
}): Promise<void> {
  if (!eligible(input.group)) return;
  const assertCurrent = captureProviderManagementScope();
  const config = readProviderGroup(input.group);
  const state = await groupFastPolicyStore.prepare(
    input.group,
    config?.allowFast !== false,
    input.deviceId ? [input.deviceId] : [],
    assertCurrent,
  );
  const command: RemoteAgentFastPolicy = {
    group: input.group,
    revision: state.revision,
    allowFast: state.allowFast,
    binding: {
      sessionId: input.sessionId,
      ...(input.controllerDeviceId ? { controllerDeviceId: input.controllerDeviceId } : {}),
      ...(input.relay ? { relay: input.relay } : {}),
      ...(input.providerShareGuest ? { providerShareGuest: input.providerShareGuest } : {}),
    },
  };
  if (input.deviceId) {
    try {
      await send(input.deviceId, command, assertCurrent);
      await groupFastPolicyStore.acknowledge(
        input.group,
        input.deviceId,
        state.revision,
        assertCurrent,
      );
    } catch (error) {
      assertCurrent();
      // A delegated direct task needs a durable per-task binding even while
      // Fast is allowed, so a later group prohibition can reach this task.
      // Legacy same-account relays retain allowed-by-default compatibility.
      if (!state.allowFast || input.providerShareGuest) throw error;
    }
  } else {
    const self = getSelfDeviceId();
    if (!self) throw new Error('[REMOTE_AGENT_UNAVAILABLE] Computer identity is not ready');
    await receiveGroupFastPolicy(self, command);
  }
}

export function groupFastPolicyPending(group: string): boolean {
  if (!eligible(group)) return false;
  const state = groupFastPolicyStore.outgoing()[group];
  if (!state) return readProviderGroup(group)?.allowFast === false;
  return (
    state.allowFast !== (readProviderGroup(group)?.allowFast !== false) ||
    Object.values(state.targets).some((ack) => ack !== state.revision) ||
    targets(group).some((device) => state.targets[device] !== state.revision)
  );
}

export function syncGroupFastPolicy(group: string): Promise<void> {
  if (!eligible(group) && !groupFastPolicyStore.outgoing()[group]) return Promise.resolve();
  const key = `${activeOwnerScopeKey()}\0${group}`;
  const current = syncing.get(key);
  if (current) {
    const assertCurrent = captureProviderManagementScope();
    return current.then(() => {
      assertCurrent();
      const state = groupFastPolicyStore.outgoing()[group];
      // Share an in-flight retry instead of queuing another full retry for
      // every poll. A genuine settings change still waits for its own revision.
      if (
        !state ||
        state.allowFast !== (!eligible(group) || readProviderGroup(group)?.allowFast !== false) ||
        JSON.stringify(state.members) !== JSON.stringify([...new Set(targets(group))].sort())
      ) {
        return syncGroupFastPolicy(group);
      }
    });
  }
  const work = (async () => {
    const assertCurrent = captureProviderManagementScope();
    const config = readProviderGroup(group);
    const destinations = targets(group);
    const state = await groupFastPolicyStore.prepare(
      group,
      !eligible(group) || config?.allowFast !== false,
      destinations,
      assertCurrent,
      true,
    );
    assertCurrent();
    const active = new Set(destinations);
    const retryTargets = retriesFor(group, state.revision);
    for (const device of retryTargets.keys()) {
      if (state.targets[device] === undefined || state.targets[device] === state.revision) {
        retryTargets.delete(device);
      }
    }
    await Promise.allSettled(
      Object.entries(state.targets)
        .filter(([, ack]) => ack !== state.revision)
        .map(async ([device]) => {
          const retry = retryTargets.get(device);
          if (retry && performance.now() < retry.retryAt) return;
          const command = {
            group,
            revision: state.revision,
            allowFast: active.has(device) ? state.allowFast : true,
          };
          try {
            if (device === LOCAL_TARGET) {
              const self = getSelfDeviceId();
              if (!self)
                throw new Error('[REMOTE_AGENT_UNAVAILABLE] Computer identity is not ready');
              await receiveGroupFastPolicy(self, command);
            } else await send(device, command, assertCurrent);
            await groupFastPolicyStore.acknowledge(group, device, state.revision, assertCurrent);
            retryTargets.delete(device);
          } catch (error) {
            assertCurrent();
            const delayMs = retry ? Math.min(retry.delayMs * 2, RETRY_MAX_MS) : RETRY_INITIAL_MS;
            retryTargets.set(device, { delayMs, retryAt: performance.now() + delayMs });
            throw error;
          }
        }),
    );
    assertCurrent();
    await notifySubscriptionFastPolicyChanged();
  })().finally(() => {
    if (syncing.get(key) === work) syncing.delete(key);
  });
  syncing.set(key, work);
  return work;
}

/** Poll pending revisions; each failed target backs off without resetting shared links. */
export function startGroupFastPolicySync(): () => void {
  const sync = () => {
    const outgoing = groupFastPolicyStore.outgoing();
    const groups = listProviderGroups();
    for (const group of new Set([...Object.keys(outgoing), ...Object.keys(groups)])) {
      if (!eligible(group) && !outgoing[group]) continue;
      if (syncing.has(`${activeOwnerScopeKey()}\0${group}`)) continue;
      const state = outgoing[group];
      if (
        !state ||
        state.allowFast !== (!eligible(group) || groups[group]?.allowFast !== false) ||
        JSON.stringify(state.members) !== JSON.stringify([...new Set(targets(group))].sort()) ||
        Object.values(state.targets).some((ack) => ack !== state.revision)
      ) {
        void syncGroupFastPolicy(group).catch(() => undefined);
      }
    }
  };
  const timer = setInterval(sync, 5_000);
  timer.unref?.();
  return () => {
    clearInterval(timer);
    retries.clear();
  };
}
