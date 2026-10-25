/**
 * 「允许被远程调用」(供应商级授权)的来源解析：Agent 在本机替另一台电脑运行时，只能用本机
 * 开放了的供应商。授权本身存在 maker-host/remote-provider-access-store(默认关)。
 */
import {
  actualSourceIdForModel,
  effectiveSourceIdForModel,
  type AgentKind,
  type ProviderView,
} from '@cindy/model-providers';
import { isProviderSharePeer } from '@cindy/device-link';
import type { RemoteAgentHostDeps } from './runHost.js';

/** Shared users and same-account group relays both need a guest-isolated proxy binding. */
export function createGuestProviderRouteBinder(deps: {
  registerRoute(sessionId: string, providerId: string, allowsModel: (model: string) => Promise<boolean>, restricted: () => boolean): { token: string; release(): void };
  modelAllowed(providerId: string, model: string, sessionId: string): Promise<boolean>;
  readProviders(): Promise<readonly ProviderView[]>;
  guestAccess(controller: string): { providerId: string; memberId: string } | null;
  ownerAllowed(controller: string): boolean;
  providerAllowed(providerId: string): boolean;
  modelAccess: {
    allows(providerId: string, model: string, memberId?: string): boolean;
    read(providerId: string, memberId?: string): { models: readonly string[] | null; providerModels: readonly string[] | null };
  };
}): NonNullable<RemoteAgentHostDeps['bindGuestProviderRoute']> {
  return async ({ kind, hostSessionId, providerId, controller, isCurrent, relayModelAccess }) => {
    const views = await deps.readProviders();
    // An obsolete asynchronous launch must never replace the current binding.
    if (!isCurrent()) return null;
    // A same-account group relay is isolated as a guest, but the group owner is
    // not a direct-share member of this computer. Intersect this computer's
    // provider grants with the original member's live grant at the coordinator.
    const sharedPeer = isProviderSharePeer(controller);
    const memberId = sharedPeer ? deps.guestAccess(controller)?.memberId : undefined;
    const providerAllowed = (): boolean => {
      const access = sharedPeer ? deps.guestAccess(controller) : null;
      return (sharedPeer
        ? !!access && access.memberId === memberId && access.providerId === providerId
        : deps.ownerAllowed(controller)) && deps.providerAllowed(providerId);
    };
    if (!providerAllowed()) return null;
    const localAllows = (model: string) => isCurrent() && providerAllowed() && deps.modelAccess.allows(providerId, model, memberId);
    const allowsModel = async (model: string) => localAllows(model)
      && (!relayModelAccess || await relayModelAccess.allows(model)) && localAllows(model);
    const modelIds = guestProviderModelIds(views, providerId, kind)
      .filter(model => localAllows(model) && (!relayModelAccess || relayModelAccess.models.includes(model)));
    if (!isCurrent()) return null;
    const binding = deps.registerRoute(hostSessionId, providerId, allowsModel, () => {
      if (relayModelAccess) return true;
      try {
        const rule = deps.modelAccess.read(providerId, memberId);
        return rule.models !== null || rule.providerModels !== null;
      } catch { return true; }
    });
    return {
      routeToken: binding.token,
      modelIds,
      allowsModel: model => deps.modelAllowed(providerId, model, hostSessionId),
      release: binding.release,
    };
  };
}

/**
 * 对方指定了来源时只核对它是否开放；没指定时按本机默认规则在开放的供应商里挑(新路由口径
 * 优先，找不到再按实际路由口径，恢复仍在用已下架模型的任务时不被误拦)。
 * 返回 null = 没有开放的供应商可用。
 */
export function resolveSharedProviderId(
  views: readonly ProviderView[],
  isAllowed: (providerId: string) => boolean,
  kind: AgentKind,
  model: string,
  providerId: string | null | undefined,
): string | null {
  if (providerId) {
    return isAllowed(providerId) && views.some((view) => view.id === providerId) ? providerId : null;
  }
  const shared = views.filter((view) => isAllowed(view.id));
  return effectiveSourceIdForModel(shared, null, model, kind)
    ?? actualSourceIdForModel(shared, null, model, kind);
}

/**
 * 供应商分享的受邀者：来源只能是分享给它的那个供应商(没指定时也落到它上面)，而且这个供应商
 * 要为本 Agent 提供所选模型(口径同上：新路由优先，再按实际路由)。只看分享的这一个供应商，
 * 不会因为本机别的供应商有同名模型而放行。返回 null = 不允许。
 */
export function resolveGuestProviderId(
  views: readonly ProviderView[],
  sharedProviderId: string | null | undefined,
  isAllowed: (providerId: string) => boolean,
  kind: AgentKind,
  model: string,
  providerId: string | null | undefined,
): string | null {
  if (!sharedProviderId || !isAllowed(sharedProviderId)) return null;
  if (providerId && providerId !== sharedProviderId) return null;
  if (!model) return null;
  const shared = views.filter((view) => view.id === sharedProviderId);
  return effectiveSourceIdForModel(shared, sharedProviderId, model, kind)
    ?? actualSourceIdForModel(shared, sharedProviderId, model, kind);
}

/** 分享的供应商为本 Agent 提供的模型(受邀者 Claude Code 的可选模型只列这些)。 */
export function guestProviderModelIds(
  views: readonly ProviderView[],
  providerId: string,
  kind: AgentKind,
): string[] {
  const view = views.find((candidate) => candidate.id === providerId);
  return (view?.models[kind] ?? []).filter((model) => model.disabled !== true).map((model) => model.id);
}
