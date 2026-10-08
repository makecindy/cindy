/**
 * 远程 Agent 的选择准入(本机主进程)。
 *
 * Agent 要在另一台电脑运行时，所选 (Agent, 来源, 模型) 必须出现在那台允许被远程调用的供应商
 * 目录里(readDeviceProviderViews 已只留授权供应商)。在用户选择的那一刻就拒绝，不留一个到发送时
 * 才在那台失败、且之后每次发送都会重试的意图。
 *
 * 这只是预检：真正的裁决仍由那台的 Agent 启动 / 切换时做。所以按目录元数据回查的宽松口径匹配
 * (`[1m]` 写法、桥接前缀)，宁可放过也不误拒。
 */
import type { AgentKind } from '@cindy/maker-core';
import { findCatalogModel, type ProviderView } from '@cindy/model-providers';

/** 那台电脑的目录里能否按这个 (Agent, 来源, 模型) 运行；providerId 为 null = 任一授权来源。 */
export function deviceOffersModel(
  views: readonly ProviderView[],
  agent: AgentKind,
  providerId: string | null,
  modelId: string,
): boolean {
  return views.some(
    (view) =>
      (providerId === null || view.id === providerId) &&
      findCatalogModel(view, modelId, agent) !== undefined,
  );
}

export type DeviceRouteRejection = 'unreachable' | 'not-offered';

/**
 * 读那台的目录并判定。目录读不到(离线、未授权远控、旧版本) = unreachable；
 * 读到了但没有这个模型 / 来源没开放 = not-offered；可用返回 null。
 */
export async function checkDeviceRoute(
  readViews: () => Promise<ProviderView[]>,
  agent: AgentKind,
  providerId: string | null,
  modelId: string,
): Promise<DeviceRouteRejection | null> {
  let views: ProviderView[];
  try {
    views = await readViews();
  } catch {
    return 'unreachable';
  }
  return deviceOffersModel(views, agent, providerId, modelId) ? null : 'not-offered';
}
