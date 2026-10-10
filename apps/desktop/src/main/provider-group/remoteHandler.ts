/**
 * 组所在电脑处理同账号其他电脑的 `provider-group:remote` 请求(docs/product-rules/provider-groups.md §4–§6)。
 *
 * 那台电脑上的任务选了本机的这个供应商：先来问该用组里哪台，再自己直接连过去运行；出问题时报告
 * 需要冷却的电脑，运行期间报告正在跑的任务，让本机的分配看到全组真实的负载。
 *
 * 只服务同账号电脑(dispatch 已拒绝受邀者与共享任务访客)，且只对仍「允许被远程调用」的供应商提供组：
 * 没开放的供应商对其他电脑本来就不可见。
 */
import {
  parseProviderGroupRemoteRequest,
  providerGroupSummaryForWire,
  type ProviderGroupConfig,
  type ProviderGroupRemotePick,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import type { ProviderGroupExternalLoad } from './externalLoad.js';
import {
  PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
  PROVIDER_GROUP_FAILURE_COOLDOWN_MS,
  type ProviderGroupRouter,
} from './router.js';

/** 报告来的重置时刻最多信多远(账号用量上限最长按周重置)，避免一台电脑被异常时刻长期冷却。 */
export const PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS = 8 * 24 * 60 * 60_000;

export interface ProviderGroupRemoteHandlerDeps {
  router: ProviderGroupRouter;
  externalLoad: ProviderGroupExternalLoad;
  readGroup(providerId: string): ProviderGroupConfig | null;
  /** 这个供应商仍对其他电脑开放(「允许被远程调用」)。 */
  isRemoteAllowed(providerId: string): boolean;
  now(): number;
}

/**
 * 给同账号电脑的 `maker:provider:list` 补组摘要：只加在仍允许被远程调用、且建了组的供应商上。
 * 结果里已有的 `group` 一律先去掉，只有本机设置能产生它。
 */
export function decorateProviderListWithGroups(
  result: unknown,
  readGroup: (providerId: string) => ProviderGroupConfig | null,
): unknown {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return result;
  const value = result as { providers?: unknown };
  if (!Array.isArray(value.providers)) return result;
  return {
    ...value,
    providers: value.providers.map((provider: unknown) => {
      if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return provider;
      const entry = { ...(provider as Record<string, unknown>) };
      delete entry.group;
      const config = entry.remoteInvocationEnabled === true && typeof entry.id === 'string' ? readGroup(entry.id) : null;
      if (config) entry.group = providerGroupSummaryForWire(config);
      return entry;
    }),
  };
}

export async function handleProviderGroupRemote(
  deps: ProviderGroupRemoteHandlerDeps,
  controller: string,
  raw: unknown,
): Promise<ProviderGroupRemotePick | ProviderGroupView | Record<string, never>> {
  const request = parseProviderGroupRemoteRequest(raw);
  switch (request.action) {
    case 'pick': {
      const { providerId } = request;
      if (!deps.isRemoteAllowed(providerId) || !deps.readGroup(providerId)) return { kind: 'none' };
      const pick = await deps.router.pick({
        providerId,
        agentKind: request.agentKind,
        model: request.model,
        exclude: new Set(request.exclude),
      });
      if (pick.kind === 'none') return { kind: 'none' };
      if (pick.kind === 'unavailable') return { kind: 'unavailable' };
      deps.externalLoad.recordPick(controller, request.sessionId, providerId, pick.member.key);
      const { key, kind, agentDeviceId, providerId: memberProviderId } = pick.member;
      return { kind: 'member', member: { key, kind, agentDeviceId, providerId: memberProviderId }, label: pick.label };
    }
    case 'cool': {
      const config = deps.readGroup(request.providerId);
      if (!config || !config.members.some((m) => m.key === request.memberKey)) return {};
      const now = deps.now();
      const until = request.cause === 'usage-limit'
        ? Math.min(
          request.resetAt !== undefined && request.resetAt > now ? request.resetAt : now + PROVIDER_GROUP_DEFAULT_COOLDOWN_MS,
          now + PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS,
        )
        : now + PROVIDER_GROUP_FAILURE_COOLDOWN_MS;
      deps.router.markCooling(request.providerId, request.memberKey, until);
      return {};
    }
    case 'leases':
      deps.externalLoad.replaceLeases(controller, request.seq, request.entries);
      return {};
    case 'view': {
      if (!deps.isRemoteAllowed(request.providerId)) return { providerId: request.providerId, config: null, members: [] };
      return deps.router.view(request.providerId);
    }
  }
}
