/**
 * hook-control/modelProviderName.ts
 * ---------------------------------------------------------------------------
 * IM 模型选择卡上每个模型旁边写的供应商名(query.response 的 models[].provider)。
 *
 * IM 侧选中后只回传模型 id, 不带来源; 执行时未另行指定来源的会话走
 * `effectiveSourceIdForModel(providers, null, model, agent)` 选出的那一家。这里用
 * 同一条规则取名, 卡片上写的就是默认会走的供应商 —— 而不是拍平清单里碰巧先出现的
 * 那一家。解析不出(没有已连接且可用的来源)时不给名字, 服务端只显示模型名。
 *
 * 只用于展示: 项目另行指定了来源时, 实际路由以那份设置为准。
 */

import { effectiveSourceIdForModel, type AgentKind, type ProviderView } from '@cindy/model-providers';

import { displayProviderName } from '../utility-model/textOneshotPinOptions.js';

export function hookModelProviderName(
  providers: ProviderView[],
  agentKind: AgentKind,
  modelId: string,
): string | undefined {
  const sourceId = effectiveSourceIdForModel(providers, null, modelId, agentKind);
  const source = sourceId === null ? undefined : providers.find((provider) => provider.id === sourceId);
  const name = source === undefined ? '' : displayProviderName(source).trim();
  return name === '' ? undefined : name;
}
