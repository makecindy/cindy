/**
 * 供应商组替受邀者选电脑(docs/product-rules/provider-groups.md §4、§9)：本机是组所在电脑，受邀者用的是
 * 本机分享出去的供应商，而这个供应商建了组。受邀者连不到组内其他电脑，由本机选一台并中转
 * (中转本身在 remote-agent/host/runHost.ts)。
 *
 * 只选能接受受邀者的电脑：本机；分享来的电脑(那台本来就把本机当受邀者隔离)；同账号电脑要它声明
 * `guestRelay`(能按受邀者隔离)，否则受邀者在那台会拿到主人级权限。不支持的同账号电脑暂时不再给它分
 * 受邀者的任务，但不冷却它，本机自己的任务照常分过去。
 */
import type { AgentKind } from '@cindy/maker-core';

import type { ProviderGroupConfig } from '../../shared/providerGroup.js';
import type { GroupRelayMember, RemoteAgentGroupRelayDeps } from '../remote-agent/host/runHost.js';
import type { RemoteAgentInvoke, RemoteAgentPoller } from '../remote-agent/controller/runClient.js';
import type { ProviderGroupExternalLoad } from './externalLoad.js';
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupRouter,
} from './router.js';
import { classifyProviderGroupSwitchCause } from './switchCause.js';

/** 同账号电脑不支持接受受邀者任务时，多久内不再试它。 */
export const PROVIDER_GROUP_GUEST_INCAPABLE_MS = 10 * 60_000;

export interface ProviderGroupGuestRelayDeps {
  router: ProviderGroupRouter;
  readGroup(providerId: string): ProviderGroupConfig | null;
  externalLoad: ProviderGroupExternalLoad;
  connect(agentDeviceId: string): { invoke: RemoteAgentInvoke; poller: RemoteAgentPoller };
  now(): number;
  log: { warn(message: string, meta?: Record<string, unknown>): void };
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function createProviderGroupGuestRelay(deps: ProviderGroupGuestRelayDeps): RemoteAgentGroupRelayDeps {
  /** 不支持接受受邀者任务的同账号电脑 → 到何时前不再试。 */
  const incapable = new Map<string, number>();

  function isIncapable(agentDeviceId: string): boolean {
    const until = incapable.get(agentDeviceId);
    if (until === undefined) return false;
    if (until <= deps.now()) {
      incapable.delete(agentDeviceId);
      return false;
    }
    return true;
  }

  return {
    async plan({ kind, model, providerId, exclude }) {
      const config = deps.readGroup(providerId);
      if (!config) return null;
      const skip = new Set(exclude);
      for (const member of config.members) {
        if (member.kind === 'device' && member.agentDeviceId && isIncapable(member.agentDeviceId)) skip.add(member.key);
      }
      const pick = await deps.router.pick({ providerId, agentKind: kind as AgentKind, model, exclude: skip });
      if (pick.kind === 'none') return null;
      if (pick.kind === 'unavailable') return { kind: 'unavailable' };
      const { member } = pick;
      if (member.kind === 'local' || !member.agentDeviceId) return { kind: 'local' };
      return {
        kind: 'member',
        memberKey: member.key,
        agentDeviceId: member.agentDeviceId,
        providerId: member.providerId,
        sameAccount: member.kind === 'device',
      };
    },

    connect: (agentDeviceId) => deps.connect(agentDeviceId),

    noteStartFailure(providerId, member: GroupRelayMember, error) {
      const message = errorText(error);
      // 那台太旧、还不能按受邀者隔离：不冷却它(本机自己的任务照常分过去)，只是一阵子不再给它受邀者的任务。
      if (/REMOTE_AGENT_PEER_TOO_OLD|REMOTE_AGENT_UNSUPPORTED/.test(message)) {
        incapable.set(member.agentDeviceId, deps.now() + PROVIDER_GROUP_GUEST_INCAPABLE_MS);
        return;
      }
      const cause = classifyProviderGroupSwitchCause({ message });
      if (!cause) return;
      const now = deps.now();
      deps.router.markCooling(
        providerId,
        member.memberKey,
        now + (cause === 'usage-limit' ? PROVIDER_GROUP_DEFAULT_COOLDOWN_MS : PROVIDER_GROUP_FAILURE_COOLDOWN_MS),
      );
    },

    trackRun: (providerId, memberKey) => deps.externalLoad.trackRelay(providerId, memberKey),

    async forget(agentDeviceId, relay) {
      await deps.connect(agentDeviceId).invoke([{ op: 'forget', relay }]);
    },
  };
}
