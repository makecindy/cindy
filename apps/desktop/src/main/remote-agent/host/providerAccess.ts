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
