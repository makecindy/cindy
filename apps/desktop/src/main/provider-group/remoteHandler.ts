/**
 * 组所在电脑处理同账号其他电脑的 `provider-group:remote` 请求(docs/product-rules/provider-groups.md §4–§6)。
 *
 * 那台电脑上的任务选了本机的这个供应商：先来问该用组里哪台，再自己直接连过去运行；出问题时报告
 * 需要冷却的电脑，运行期间报告正在跑的任务，让本机的分配看到全组真实的负载。
 *
 * 只服务同账号电脑(dispatch 已拒绝受邀者与共享任务访客)，且只对仍「允许被远程调用」的供应商提供组：
 * 没开放的供应商对其他电脑本来就不可见。
 */
import { PROVIDER_RUNNING_TURNS_FIELD } from '@cindy/device-link';

import {
  parseProviderGroupRemoteRequest,
  providerGroupSummaryForWire,
  type ProviderGroupConfig,
  type ProviderGroupRemotePick,
  type ProviderGroupView,
} from '../../shared/providerGroup.js';
import { PROVIDER_GROUP_DEFAULT_COOLDOWN_MS, PROVIDER_GROUP_FAILURE_COOLDOWN_MS } from './router.js';
import type { ProviderGroupOwnerScope } from './runtime.js';

/** 报告来的重置时刻最多信多远(账号用量上限最长按周重置)，避免一台电脑被异常时刻长期冷却。 */
export const PROVIDER_GROUP_MAX_REMOTE_COOLDOWN_MS = 8 * 24 * 60 * 60_000;

export interface ProviderGroupRemoteHandlerDeps {
  /** 当前账号的分配器与负载(每个请求开头取一次，整个请求都用这一份)。 */
  scope(): ProviderGroupOwnerScope;
  readGroup(providerId: string): ProviderGroupConfig | null;
  /** 这个供应商仍对其他电脑开放(「允许被远程调用」)。 */
  isRemoteAllowed(providerId: string): boolean;
  now(): number;
}

/**
 * 给同账号电脑的 `maker:provider:list` 补组摘要与运行数，都只加在仍允许被远程调用的供应商上：
 * 建了组的带 `group`；`running`(这台电脑上每个供应商正在运行一轮的任务数，localLoad.ts)给出时每个都带
 * `runningTurns`，没在跑的为 0，读不到(null)时不带。结果里已有的这两个字段一律先去掉，只有本机能产生它们。
 */
export function decorateProviderListWithGroups(
  result: unknown,
  readGroup: (providerId: string) => ProviderGroupConfig | null,
  running: ReadonlyMap<string, number> | null = null,
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
      delete entry[PROVIDER_RUNNING_TURNS_FIELD];
      if (entry.remoteInvocationEnabled !== true || typeof entry.id !== 'string') return entry;
      const config = readGroup(entry.id);
      if (config) entry.group = providerGroupSummaryForWire(config);
      if (running) entry[PROVIDER_RUNNING_TURNS_FIELD] = running.get(entry.id) ?? 0;
      return entry;
    }),
  };
}

/**
 * 分享出去的供应商建了组时，受邀者只看到组里有几台电脑(provider-groups.md §8)：不给名单、不给状态。
 * 供应商不再允许被远程调用时分享本身就不可用，不报台数。
 */
export function sharedProviderGroupSize(
  deps: Pick<ProviderGroupRemoteHandlerDeps, 'readGroup' | 'isRemoteAllowed'>,
  providerId: string,
): number | null {
  if (!deps.isRemoteAllowed(providerId)) return null;
  const count = deps.readGroup(providerId)?.members.length ?? 0;
  return count > 0 ? count : null;
}

export async function handleProviderGroupRemote(
  deps: ProviderGroupRemoteHandlerDeps,
  controller: string,
  raw: unknown,
): Promise<ProviderGroupRemotePick | ProviderGroupView | Record<string, never>> {
  const request = parseProviderGroupRemoteRequest(raw);
  const scope = deps.scope();
  switch (request.action) {
    case 'pick': {
      const { providerId } = request;
      if (!deps.isRemoteAllowed(providerId) || !deps.readGroup(providerId)) return { kind: 'none' };
      const pick = await scope.router.pick({
        providerId,
        agentKind: request.agentKind,
        model: request.model,
        exclude: new Set(request.exclude),
        // 选中的同一步记上临时占用：同时来的几个请求不会读到同一份负载、全落到同一台。
        onPicked: (memberKey) => scope.externalLoad.recordPick(controller, request.sessionId, providerId, memberKey),
      });
      // 等目录期间换了账号：这是上一个账号的组(占用也记在上一个账号那份里，随它作废)，不作数。
      if (!scope.isCurrent() || pick.kind === 'none') return { kind: 'none' };
      if (pick.kind === 'unavailable') return { kind: 'unavailable' };
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
      scope.router.markCooling(request.providerId, request.memberKey, until);
      return {};
    }
    case 'leases':
      scope.externalLoad.replaceLeases(controller, request.seq, request.entries);
      return {};
    case 'view': {
      if (!deps.isRemoteAllowed(request.providerId)) return { providerId: request.providerId, config: null, members: [] };
      return scope.router.view(request.providerId);
    }
  }
}
