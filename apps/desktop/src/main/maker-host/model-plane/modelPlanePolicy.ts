/**
 * modelPlanePolicy —— 内置供应商模型平面的**表驱动 policy**(纯逻辑,零 IO)。
 *
 * 三件事严格分离(2026-08-02 架构收敛定案,协议侧契约见本仓
 * modelRegistryCanonical.ts 的「Presence, entitlement, and sale availability」):
 *  - roots:该供应商的 canonical 实体列表落在哪些 agent。实体化 / discovery /
 *    本地 override 只作用于 root;派生端(bridge / Pi)永远重算,禁止直写。
 *  - membership:registry route.agents 声明「允许出现在哪些消费端」,不是 root
 *    清单——root ∩ membership 决定实体化落点,非 root 的 membership 只授权投影
 *    可达(如 anthropic route 含 codex = 允许进 codex bridge)。
 *  - transforms:投影期的 ID/能力变换(chatgpt/ 前缀、effort 封顶、fast=false),
 *    硬约束最后收口。共享变换与拓扑都集中在本模块,目录装配和续跑描述符不得各写一套。
 *
 * Pi 不在 wire enum(protocol MODEL_ACCESS_AGENTS 只有 claude-code/codex),
 * 恒定由客户端投影派生,route 永远无法点名 pi:
 *  - openai:  codex root → claude-code bridge(membership 门控) + pi bridge(恒定);
 *  - anthropic: claude-code root → codex bridge(membership 门控,fast=false) + pi 镜像(恒定);
 *  - xai:    claude-code/codex 双 root(perAgent 各自应用),pi 镜像 claude-code root(恒定);
 *  - xd:     roots=∅ —— 存在性/元数据只来自 Gateway /models,registry 与本地
 *            override 永远不能凭空制造 XD 可售模型。
 */

import {
  findModelRegistryRoute,
  type AgentKind,
  type CatalogModel,
  type ModelRegistry,
  type ModelRegistryEntry,
} from '@cindy/model-providers';

import { CHATGPT_MODEL_PREFIX } from '../../../shared/subscriptionModels.js';

/** registry 路由与本地 override 可作用的 root agent(wire enum 子集,不含 pi)。 */
export type RootAgentKind = 'claude-code' | 'codex';

export interface BuiltinModelPlanePolicy {
  /** canonical 实体列表所在 agent。 */
  roots: readonly RootAgentKind[];
  /** Pi 恒定投影使用的 canonical root;Pi 不进入 wire membership。 */
  piRoot: RootAgentKind;
  /**
   * membership 门控的派生端:root 模型是否进入该 bridge 由 registry route.agents
   * 是否包含该 agent 决定;registry 没登记的模型(纯 discovery)不受门控,维持
   * 「全量投影」的历史行为。
   */
  membershipGatedBridges: readonly RootAgentKind[];
}

/** 实体化 allowlist:只有这三家允许由 registry presence 长出可选实体。 */
export const MODEL_PLANE_POLICIES: ReadonlyMap<string, BuiltinModelPlanePolicy> = new Map([
  ['openai', { roots: ['codex'], piRoot: 'codex', membershipGatedBridges: ['claude-code'] }],
  ['anthropic', { roots: ['claude-code'], piRoot: 'claude-code', membershipGatedBridges: ['codex'] }],
  ['xai', { roots: ['claude-code', 'codex'], piRoot: 'claude-code', membershipGatedBridges: [] }],
  // xd 有意不在表内:Gateway 独占存在性(见文件头)。
]);

/**
 * Registry tombstone lookup for a concrete client consumer. This mirrors the same root/bridge
 * graph used by materialization without requiring a CatalogModel entity: retired routes are
 * intentionally absent from the assembled provider list, but legacy controllers may still name
 * one explicitly. Pi maps to its canonical source root because it is client-projected and never
 * appears in the wire agent enum.
 */
export function isRegistryTombstoneForConsumer(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  modelId: string,
  agent: AgentKind,
): boolean {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!registry || !policy) return false;

  let registryAgent: RootAgentKind | null;
  if (agent === 'pi') {
    registryAgent = providerId === 'openai' ? 'codex' : 'claude-code';
  } else if (policy.roots.includes(agent) || policy.membershipGatedBridges.includes(agent)) {
    registryAgent = agent;
  } else {
    registryAgent = null;
  }
  if (!registryAgent) return false;

  return (
    findModelRegistryRoute(registry, providerId, modelId, registryAgent)?.entry.status === 'retired'
  );
}

const VALID_EFFORTS: ReadonlySet<string> = new Set([
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
  'ultra',
]);
type Effort = CatalogModel['efforts'][number];

/** Claude/Pi 的 OpenAI bridge 默认收起的旧型号;与既有目录行为保持一致。 */
const BRIDGE_DEFAULT_HIDDEN_SLUGS: ReadonlySet<string> = new Set(['gpt-5.4', 'gpt-5.4-mini']);

/** anthropic-responses bridge 不会兑现的 GPT 思考档,投影时必须在客户端硬封顶。 */
const CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS: ReadonlySet<Effort> = new Set(['max', 'ultra']);

/** OpenAI Codex root → Claude/Pi bridge;目录装配与 retired 续跑共同复用。 */
export function toChatgptBridgeModel(model: CatalogModel): CatalogModel {
  const bridgeEfforts = model.efforts.filter((effort) => !CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS.has(effort));
  const cappedDefault: Effort | null =
    model.defaultEffort && CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS.has(model.defaultEffort)
      ? bridgeEfforts.includes('xhigh')
        ? 'xhigh'
        : (bridgeEfforts[bridgeEfforts.length - 1] ?? null)
      : model.defaultEffort;
  return {
    ...model,
    id: `${CHATGPT_MODEL_PREFIX}${model.id}`,
    ...(bridgeEfforts.length !== model.efforts.length
      ? { efforts: bridgeEfforts, defaultEffort: cappedDefault }
      : {}),
    ...(BRIDGE_DEFAULT_HIDDEN_SLUGS.has(model.id) ? { defaultEnabled: false } : {}),
  };
}

/** canonical root → Pi;Pi 始终从 policy 指定 root 派生,永不读取 wire agent membership。 */
export function projectRootModelToPi(
  providerId: string,
  rootAgent: RootAgentKind,
  model: CatalogModel,
): CatalogModel | null {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!policy || policy.piRoot !== rootAgent) return null;
  return providerId === 'openai' ? toChatgptBridgeModel(model) : model;
}

/** 单 root 的 registry 消费计划:先算好,合并期零决策。 */
export interface RootRegistryPlan {
  /** 已存在条目(按 model id)的 registry 显式字段 overlay(registry > discovery)。 */
  overlays: Map<string, Partial<CatalogModel>>;
  /** registry 宣告、清单尚无、能力自洽完整的新实体。 */
  additions: CatalogModel[];
  /** 远端 retired 的 model id:禁止实体化,并把 discovery 回补的同名条目标记 retired。 */
  retired: Set<string>;
  /** membership 门控 bridge 需要排除的 model id(route.agents 不含该 bridge agent)。 */
  bridgeExcluded: Set<string>;
}

export interface ModelPlaneWarning {
  source: 'registry' | 'local';
  providerId: string;
  agent: RootAgentKind;
  modelId: string;
  reason: string;
}

export interface ModelPlaneRegistryPlan {
  /** key = `${providerId}:${rootAgent}`。 */
  roots: Map<string, RootRegistryPlan>;
  /** key = `${providerId}:${bridgeAgent}`；目标消费端的 perAgent overlay。 */
  consumers: Map<string, Map<string, Partial<CatalogModel>>>;
  warnings: ModelPlaneWarning[];
}

export function rootPlanKey(providerId: string, agent: RootAgentKind): string {
  return `${providerId}:${agent}`;
}

export function consumerPlanKey(providerId: string, agent: RootAgentKind): string {
  return `${providerId}:${agent}`;
}

function emptyRootPlan(): RootRegistryPlan {
  return { overlays: new Map(), additions: [], retired: new Set(), bridgeExcluded: new Set() };
}

type MaterializedStatus = 'active' | 'alpha' | 'deprecated';

/** registry status → 客户端 CatalogModel.status(实体化目标);retired/缺失返回 null。 */
function materializableStatus(status: string | undefined): MaterializedStatus | null {
  switch (status) {
    case 'active':
      return 'active';
    case 'preview':
      return 'alpha';
    case 'deprecated':
      return 'deprecated';
    default:
      return null;
  }
}

interface EffectiveRouteFields {
  name: string;
  group?: string;
  description?: string;
  sortOrder?: number;
  contextWindow?: number;
  maxOutput?: number;
  efforts?: Effort[];
  defaultEffort?: Effort | null;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  /** 运行时防御：typed caller 绕过 protocol parser 时也不能静默修复坏档位。 */
  validationError?: string;
}

/** entry 基线 + perAgent[agent] 覆盖后的有效字段(仅 wire enum agent 有 perAgent)。 */
function effectiveRouteFields(
  entry: ModelRegistryEntry,
  agent: RootAgentKind,
): EffectiveRouteFields {
  const override = entry.perAgent?.[agent];
  const efforts = override?.efforts ?? entry.efforts;
  const candidateDefaultEffort = override?.defaultEffort ?? entry.defaultEffort;
  const hasInvalidEffort =
    efforts !== undefined &&
    (!Array.isArray(efforts) || efforts.some((effort) => !VALID_EFFORTS.has(effort)));
  const validatedEfforts =
    efforts !== undefined && !hasInvalidEffort ? ([...efforts] as Effort[]) : undefined;
  const defaultEffort: Effort | null | undefined =
    validatedEfforts === undefined
      ? candidateDefaultEffort !== undefined && VALID_EFFORTS.has(candidateDefaultEffort)
        ? (candidateDefaultEffort as Effort)
        : undefined
      : validatedEfforts.length === 0
        ? null
        : candidateDefaultEffort !== undefined &&
            VALID_EFFORTS.has(candidateDefaultEffort) &&
            validatedEfforts.includes(candidateDefaultEffort as Effort)
          ? (candidateDefaultEffort as Effort)
          : undefined;
  return {
    name: entry.name,
    ...(entry.group !== undefined ? { group: entry.group } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.sortOrder !== undefined ? { sortOrder: entry.sortOrder } : {}),
    ...(override?.contextWindow !== undefined || entry.contextWindow !== undefined
      ? { contextWindow: override?.contextWindow ?? entry.contextWindow }
      : {}),
    ...(entry.maxOutputTokens !== undefined ? { maxOutput: entry.maxOutputTokens } : {}),
    ...(validatedEfforts !== undefined ? { efforts: validatedEfforts } : {}),
    ...(defaultEffort !== undefined ? { defaultEffort } : {}),
    ...(override?.supportsFastMode !== undefined || entry.supportsFastMode !== undefined
      ? { supportsFastMode: override?.supportsFastMode ?? entry.supportsFastMode }
      : {}),
    ...(override?.defaultEnabled !== undefined || entry.defaultEnabled !== undefined
      ? { defaultEnabled: override?.defaultEnabled ?? entry.defaultEnabled }
      : {}),
    ...(hasInvalidEffort ? { validationError: 'route has invalid effort token' } : {}),
  };
}

/**
 * 把 registry 消费成 per-root 计划。
 *
 * 实体化门禁(protocol MODEL_REGISTRY.md 的 policy-based materialization 契约):
 *  - providerId ∈ allowlist,agent ∈ roots ∩ route.agents;
 *  - status 显式 ∈ {active, preview, deprecated}(缺失 = metadata-only,永不长实体);
 *  - 能力自洽完整:contextWindow>0、efforts 显式在场;efforts=[] ⇒ defaultEffort:=null
 *    (确定性推导);非空 efforts ⇒ effective default 必须显式在场且 ∈ efforts,不准猜。
 *  - 不满足 ⇒ 该 route 单独跳过 + warning,不拖垮其余(隔离)。
 *
 * overlay(registry 显式字段 > discovery 显式值)对**已存在**条目始终适用(含
 * status 缺失的 metadata-only 条目);deprecated 实体化强制 defaultEnabled=false。
 */
export function planRegistryRoots(registry: ModelRegistry | undefined): ModelPlaneRegistryPlan {
  const plan: ModelPlaneRegistryPlan = { roots: new Map(), consumers: new Map(), warnings: [] };
  if (!registry) return plan;
  const claimedRootRoutes = new Set<string>();
  for (const entry of registry.models) {
    const status = materializableStatus(entry.status);
    for (const route of entry.routes) {
      const policy = MODEL_PLANE_POLICIES.get(route.providerId);
      if (!policy) continue;
      const routeAgents = route.agents as readonly RootAgentKind[];
      const memberRoots = policy.roots.filter((agent) => routeAgents.includes(agent));
      // 有 lifecycle presence、却没有 canonical root 的 route 无法产生任何实体或
      // 投影源。把它当作者错误隔离，而不是留下一个看似授权 bridge、实际永远不生效
      // 的幽灵配置。metadata-only 旧条目不升级为 presence，因此保持静默兼容。
      if (entry.status !== undefined && memberRoots.length === 0) {
        plan.warnings.push({
          source: 'registry',
          providerId: route.providerId,
          agent: policy.roots[0]!,
          modelId: route.modelId,
          reason: 'route has no canonical root agent membership',
        });
        continue;
      }
      let acceptedRoot = false;
      for (const agent of memberRoots) {
        const claimKey = `${route.providerId}\u0000${agent}\u0000${route.modelId}`;
        if (claimedRootRoutes.has(claimKey)) {
          plan.warnings.push({
            source: 'registry',
            providerId: route.providerId,
            agent,
            modelId: route.modelId,
            reason: 'multiple registry entries claim the same provider root route',
          });
          continue;
        }
        claimedRootRoutes.add(claimKey);
        acceptedRoot = true;
        const key = rootPlanKey(route.providerId, agent);
        let rootPlan = plan.roots.get(key);
        if (!rootPlan) {
          rootPlan = emptyRootPlan();
          plan.roots.set(key, rootPlan);
        }
        if (entry.status === 'retired') {
          rootPlan.retired.add(route.modelId);
          continue;
        }
        const fields = effectiveRouteFields(entry, agent);
        if (fields.validationError) {
          plan.warnings.push({
            source: 'registry',
            providerId: route.providerId,
            agent,
            modelId: route.modelId,
            reason: fields.validationError,
          });
          continue;
        }
        const overlay = toOverlay(fields, status);
        if (Object.keys(overlay).length > 0) rootPlan.overlays.set(route.modelId, overlay);
        if (status === null) continue; // metadata-only:overlay 已登记,不长实体。
        const materialized = toMaterializedModel(route.modelId, fields, status);
        if (typeof materialized === 'string') {
          plan.warnings.push({
            source: 'registry',
            providerId: route.providerId,
            agent,
            modelId: route.modelId,
            reason: materialized,
          });
          continue;
        }
        rootPlan.additions.push(materialized);
      }
      if (!acceptedRoot) continue;
      // 目标 bridge 的 effective fields = entry base + perAgent[bridge]。metadata-only
      // 仍可 overlay 已存在的 discovery bridge，但不能在下面改变投影拓扑。
      for (const bridgeAgent of policy.membershipGatedBridges) {
        if (!routeAgents.includes(bridgeAgent)) continue;
        const fields = effectiveRouteFields(entry, bridgeAgent);
        if (fields.validationError) {
          plan.warnings.push({
            source: 'registry',
            providerId: route.providerId,
            agent: bridgeAgent,
            modelId: route.modelId,
            reason: fields.validationError,
          });
          continue;
        }
        if (
          fields.efforts !== undefined &&
          fields.efforts.length > 0 &&
          (fields.defaultEffort == null || !fields.efforts.includes(fields.defaultEffort))
        ) {
          plan.warnings.push({
            source: 'registry',
            providerId: route.providerId,
            agent: bridgeAgent,
            modelId: route.modelId,
            reason: 'bridge consumer has efforts but no self-consistent defaultEffort',
          });
          continue;
        }
        const key = consumerPlanKey(route.providerId, bridgeAgent);
        let overlays = plan.consumers.get(key);
        if (!overlays) {
          overlays = new Map();
          plan.consumers.set(key, overlays);
        }
        overlays.set(route.modelId, toOverlay(fields, status));
      }
      // status 缺失是严格 metadata-only：可以 overlay 已存在 root/bridge，但不得改变
      // 实体存在或投影拓扑；否则旧 registry 会在新客户端上意外缩减模型清单。
      if (entry.status === undefined) continue;
      // membership 门控 bridge:registry 登记了该模型、但 route.agents 不含 bridge
      // agent ⇒ 从对应 bridge 排除(纯 discovery 模型不受影响)。
      for (const bridgeAgent of policy.membershipGatedBridges) {
        if (routeAgents.includes(bridgeAgent)) continue;
        for (const rootAgent of policy.roots) {
          const key = rootPlanKey(route.providerId, rootAgent);
          let rootPlan = plan.roots.get(key);
          if (!rootPlan) {
            rootPlan = emptyRootPlan();
            plan.roots.set(key, rootPlan);
          }
          rootPlan.bridgeExcluded.add(route.modelId);
        }
      }
    }
  }
  return plan;
}

/** root 投影到 bridge 后，应用目标消费端的 Registry perAgent；bridge 硬约束由调用方最后收口。 */
export function applyRegistryConsumerOverlay(
  model: CatalogModel,
  providerId: string,
  consumer: RootAgentKind,
  rootModelId: string,
  plan: ModelPlaneRegistryPlan,
): CatalogModel {
  const overlay = plan.consumers.get(consumerPlanKey(providerId, consumer))?.get(rootModelId);
  if (!overlay) return model;
  return { ...model, ...overlay };
}

/** registry 显式字段 → 已存在条目的 overlay(在场即胜出,不在场不触碰)。 */
function toOverlay(
  fields: EffectiveRouteFields,
  status: MaterializedStatus | null,
): Partial<CatalogModel> {
  return {
    name: fields.name,
    ...(fields.group !== undefined ? { group: fields.group } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.sortOrder !== undefined ? { sortOrder: fields.sortOrder } : {}),
    ...(fields.contextWindow !== undefined && fields.contextWindow > 0
      ? { contextWindow: fields.contextWindow, contextWindowVerified: true }
      : {}),
    ...(fields.maxOutput !== undefined ? { maxOutput: fields.maxOutput } : {}),
    ...(fields.efforts !== undefined ? { efforts: fields.efforts } : {}),
    ...(fields.defaultEffort !== undefined ? { defaultEffort: fields.defaultEffort } : {}),
    ...(fields.supportsFastMode !== undefined ? { supportsFastMode: fields.supportsFastMode } : {}),
    ...(status === 'deprecated'
      ? { status, defaultEnabled: false }
      : status !== null
        ? { status }
        : {}),
    ...(status !== 'deprecated' && fields.defaultEnabled !== undefined
      ? { defaultEnabled: fields.defaultEnabled }
      : {}),
  };
}

/** 纯远端新实体:能力自洽完整才实体化;返回 string = 拒绝理由(隔离+warn)。 */
function toMaterializedModel(
  modelId: string,
  fields: EffectiveRouteFields,
  status: MaterializedStatus,
): CatalogModel | string {
  if (fields.contextWindow === undefined || fields.contextWindow <= 0) {
    return 'materializable route has no positive contextWindow';
  }
  if (fields.efforts === undefined) {
    return 'materializable route has no explicit efforts';
  }
  let defaultEffort: Effort | null;
  if (fields.efforts.length === 0) {
    defaultEffort = null;
  } else if (fields.defaultEffort != null && fields.efforts.includes(fields.defaultEffort)) {
    defaultEffort = fields.defaultEffort;
  } else {
    return 'materializable route has efforts but no self-consistent defaultEffort';
  }
  return {
    id: modelId,
    name: fields.name,
    ...(fields.group !== undefined ? { group: fields.group } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.sortOrder !== undefined ? { sortOrder: fields.sortOrder } : {}),
    contextWindow: fields.contextWindow,
    contextWindowVerified: true,
    ...(fields.maxOutput !== undefined ? { maxOutput: fields.maxOutput } : {}),
    efforts: fields.efforts,
    defaultEffort,
    ...(fields.supportsFastMode !== undefined ? { supportsFastMode: fields.supportsFastMode } : {}),
    status,
    ...(status === 'deprecated'
      ? { defaultEnabled: false }
      : fields.defaultEnabled !== undefined
        ? { defaultEnabled: fields.defaultEnabled }
        : {}),
  };
}

/**
 * 为已持久化 Pi 会话重建 retired 模型的运行时描述实体。
 *
 * 这不是可选目录实体化:调用方只可把结果补进当前会话私有的 models.json;公开
 * availableModels / 新路由准入仍过滤 retired。这样纯 Registry 模型在退役并重启后
 * 仍能按旧选择续跑,同时保持 MODEL_REGISTRY.md 的“不得新实体化”契约。
 */
export function resolveRetiredRegistryModelForPi(
  registry: ModelRegistry | null | undefined,
  providerId: string,
  piModelId: string,
): CatalogModel | null {
  const policy = MODEL_PLANE_POLICIES.get(providerId);
  if (!registry || !policy) return null;
  const rootAgent = policy.piRoot;
  const rootModelId = providerId === 'openai'
    ? piModelId.startsWith(CHATGPT_MODEL_PREFIX)
      ? piModelId.slice(CHATGPT_MODEL_PREFIX.length)
      : null
    : piModelId;
  if (!rootModelId) return null;

  const matched = findModelRegistryRoute(registry, providerId, rootModelId, rootAgent);
  if (!matched || matched.entry.status !== 'retired') return null;
  const fields = effectiveRouteFields(matched.entry, rootAgent);
  if (fields.validationError) return null;
  const root = toMaterializedModel(rootModelId, fields, 'active');
  if (typeof root === 'string') return null;
  return projectRootModelToPi(providerId, rootAgent, { ...root, status: 'retired' });
}

/**
 * 把 root 计划应用到清单:overlay 已存在条目(registry > discovery),追加实体化
 * 新条目,并给 discovery 回补的 retired 同名条目打 'retired' 标记(local addition
 * 的复活豁免由 localCatalogOverrides 在其后处理)。返回新数组,输入不变。
 */
export function applyRootRegistryPlan(
  models: readonly CatalogModel[],
  rootPlan: RootRegistryPlan | undefined,
): CatalogModel[] {
  if (!rootPlan) return [...models];
  const existingIds = new Set(models.map((m) => m.id));
  const out = models.map((m) => {
    const overlay = rootPlan.overlays.get(m.id);
    let overlaid = overlay ? { ...m, ...overlay } : m;
    // 只有已有 discovery/静态证据的条目允许确定性修复缺失默认档。纯远端新实体
    // 仍由 toMaterializedModel 严格要求显式自洽，不在这里猜。
    if (overlay?.efforts !== undefined) {
      const efforts = overlaid.efforts;
      const defaultEffort = overlaid.defaultEffort;
      if (efforts.length === 0) overlaid = { ...overlaid, defaultEffort: null };
      else if (defaultEffort === null || !efforts.includes(defaultEffort)) {
        overlaid = {
          ...overlaid,
          defaultEffort: efforts.includes('high') ? 'high' : efforts[efforts.length - 1]!,
        };
      }
    }
    return rootPlan.retired.has(m.id) ? { ...overlaid, status: 'retired' as const } : overlaid;
  });
  for (const addition of rootPlan.additions) {
    if (existingIds.has(addition.id)) continue; // 已有条目走 overlay,不重复追加。
    out.push(addition);
    existingIds.add(addition.id);
  }
  return out;
}
