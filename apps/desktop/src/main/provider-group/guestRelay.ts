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
import type { RelayRunFailure } from '../remote-agent/host/groupRelay.js';
import type { GroupRelayLoad, GroupRelayMember, RemoteAgentGroupRelayDeps } from '../remote-agent/host/runHost.js';
import type { RemoteAgentInvoke, RemoteAgentPoller } from '../remote-agent/controller/runClient.js';
import { PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS } from './remoteHandler.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_FAILURE_COOLDOWN_MS } from './router.js';
import type { ProviderGroupOwnerScope } from './runtime.js';
import { classifyProviderGroupSwitchCause } from './switchCause.js';

/** 同账号电脑不支持接受受邀者任务时，多久内不再试它。 */
export const PROVIDER_GROUP_GUEST_INCAPABLE_MS = 10 * 60_000;

export interface ProviderGroupGuestRelayDeps {
  /** 当前账号的分配器与负载(每次选电脑开头取一次)。 */
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  connect(agentDeviceId: string): { invoke: RemoteAgentInvoke; poller: RemoteAgentPoller };
  /** 组内电脑报错里的用量重置时刻(unix ms)；不提供时用量上限一律按默认时长冷却。 */
  readResetAt?(failure: RelayRunFailure): number | null;
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
    async plan({ kind, model, providerId, exclude, reserve }) {
      const config = deps.readGroup(providerId);
      if (!config) return null;
      const skip = new Set(exclude);
      for (const member of config.members) {
        if (member.kind === 'device' && member.agentDeviceId && isIncapable(member.agentDeviceId)) skip.add(member.key);
      }
      const scope = deps.scope();
      let load: GroupRelayLoad | undefined;
      const pick = await scope.router.pick({
        providerId,
        agentKind: kind as AgentKind,
        model,
        exclude: skip,
        // 选中的同一步就计入那台的负载：同时来的几个受邀者任务不会读到同一份负载、全落到同一台。
        ...(reserve ? { onPicked: (memberKey: string) => { load = scope.externalLoad.trackRelay(providerId, memberKey); } } : {}),
      });
      // 选电脑期间换了账号：这是上一个账号的组，不再交给它的电脑。
      if (!scope.isCurrent()) {
        load?.release();
        return { kind: 'unavailable' };
      }
      if (pick.kind === 'none') return null;
      if (pick.kind === 'unavailable') return { kind: 'unavailable' };
      const { member } = pick;
      if (member.kind === 'local' || !member.agentDeviceId) return { kind: 'local', ...(load ? { load } : {}) };
      return {
        kind: 'member',
        memberKey: member.key,
        agentDeviceId: member.agentDeviceId,
        providerId: member.providerId,
        sameAccount: member.kind === 'device',
        ...(load ? { load } : {}),
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
      deps.scope().router.markCooling(
        providerId,
        member.memberKey,
        now + (cause === 'usage-limit' ? PROVIDER_GROUP_DEFAULT_COOLDOWN_MS : PROVIDER_GROUP_FAILURE_COOLDOWN_MS),
      );
    },

    noteRunFailure(providerId, member: GroupRelayMember, failure) {
      // 没有组，或那台已被移出组：已经在它上面的任务成为普通的远程 Agent 任务，不再自动换电脑(§9 #4)。
      const config = deps.readGroup(providerId);
      if (!config?.members.some((m) => m.key === member.memberKey)) return false;
      const cause = classifyProviderGroupSwitchCause(failure);
      if (!cause) return false;
      const now = deps.now();
      // 组内电脑报来的重置时刻按那台的口径取(readResetAt 不采用不带时区的钟点)，最多信 8 天。
      const resetAt = cause === 'usage-limit' ? deps.readResetAt?.(failure) ?? null : null;
      const until = cause === 'usage-limit'
        ? (resetAt !== null && resetAt > now
            ? Math.min(resetAt, now + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS)
            : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS)
        : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
      deps.scope().router.markCooling(providerId, member.memberKey, until);
      // 冷却照常(之后的新任务避开它)；组设置里关掉了自动换电脑时不发凭证，受邀者照现有方式看到错误(§6.1)。
      return config.autoSwitch;
    },

    trackRun: (providerId, memberKey) => deps.scope().externalLoad.trackRelay(providerId, memberKey),

    async forget(agentDeviceId, relay) {
      await deps.connect(agentDeviceId).invoke([{ op: 'forget', relay }]);
    },
  };
}
