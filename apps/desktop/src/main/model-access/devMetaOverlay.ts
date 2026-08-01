/**
 * Dev-only projection of the local public ModelRegistry onto the XD Gateway's
 * live model list.
 *
 * Availability and prices remain Gateway-authoritative: registry entries only
 * enrich ids that the server already returned. A retired XD route removes the
 * curated metadata and lets downstream deterministic defaults apply. Packaged
 * builds never call this function.
 */

import type {
  ModelRegistry,
  ModelRegistryEntry,
  ModelRegistryRoute,
} from '@cindy/model-providers';

import type {
  ModelAccessAgentOverride,
  ModelAccessGatewayModel,
} from '../../shared/modelAccess.js';

/** 覆盖日志回调(生产接统一 logger;测试可缺省)。 */
export interface OverlayLog {
  warn(msg: string, meta?: Record<string, unknown>): void;
  info(msg: string, meta?: Record<string, unknown>): void;
}

/**
 * 去掉可由 registry 覆盖的展示、归属和能力字段，保留 token 上限和全部
 * Gateway 价格。这样本地 overlay 或 retired 路由都不会把同快照里的价格静默丢掉。
 */
function gatewayFields(m: ModelAccessGatewayModel): ModelAccessGatewayModel {
  const fields = { ...m };
  delete fields.agents;
  delete fields.name;
  delete fields.group;
  delete fields.description;
  delete fields.efforts;
  delete fields.defaultEffort;
  delete fields.sortOrder;
  delete fields.supportsFastMode;
  delete fields.defaultEnabled;
  delete fields.perAgent;
  return fields;
}

function findXdRoute(
  registry: ModelRegistry,
  modelId: string,
): { entry: ModelRegistryEntry; route: ModelRegistryRoute } | undefined {
  for (const entry of registry.models) {
    const route = entry.routes.find(
      (candidate) => candidate.providerId === 'xd' && candidate.modelId === modelId,
    );
    if (route) return { entry, route };
  }
  return undefined;
}

/** 以 registry 条目重建服务端下发条目(Gateway 权威字段保留,策展元数据整体替换)。 */
function rebuildModel(
  model: ModelAccessGatewayModel,
  entry: ModelRegistryEntry,
  route: ModelRegistryRoute,
): ModelAccessGatewayModel {
  return {
    ...gatewayFields(model),
    // Gateway 上报的 token 上限权威;registry 仅在服务端条目缺失时兜底。
    ...(model.contextWindow === undefined && entry.contextWindow !== undefined
      ? { contextWindow: entry.contextWindow }
      : {}),
    ...(model.maxOutputTokens === undefined && entry.maxOutputTokens !== undefined
      ? { maxOutputTokens: entry.maxOutputTokens }
      : {}),
    agents: route.agents,
    name: entry.name,
    ...(entry.group ? { group: entry.group } : {}),
    ...(entry.description ? { description: entry.description } : {}),
    ...(entry.efforts ? { efforts: entry.efforts } : {}),
    ...(entry.defaultEffort !== undefined ? { defaultEffort: entry.defaultEffort } : {}),
    ...(entry.sortOrder !== undefined ? { sortOrder: entry.sortOrder } : {}),
    ...(entry.supportsFastMode !== undefined ? { supportsFastMode: entry.supportsFastMode } : {}),
    ...(entry.defaultEnabled !== undefined ? { defaultEnabled: entry.defaultEnabled } : {}),
    ...(entry.perAgent
      ? {
          perAgent: entry.perAgent as Partial<
            Record<'claude-code' | 'codex', ModelAccessAgentOverride>
          >,
        }
      : {}),
  };
}

/**
 * 用本地 ModelRegistry 的 XD 路由覆盖服务端下发的网关模型清单(纯函数)。
 * 本地无 registry / 无匹配路由 → 原样返回；不会凭 registry 增加可用模型。
 */
export function overlayModelRegistryMeta(
  models: ModelAccessGatewayModel[],
  registry: ModelRegistry | undefined,
  log?: OverlayLog,
): ModelAccessGatewayModel[] {
  if (!registry) return models;
  let overridden = 0;
  let retired = 0;
  const out = models.map((model) => {
    const matched = findXdRoute(registry, model.id);
    if (!matched) return model;
    if (matched.entry.status === 'retired') {
      retired += 1;
      return gatewayFields(model);
    }
    overridden += 1;
    return rebuildModel(model, matched.entry, matched.route);
  });
  if (overridden > 0 || retired > 0) {
    log?.info('dev modelRegistry overlay applied', {
      overridden,
      retired,
      total: models.length,
    });
  }
  return out;
}
