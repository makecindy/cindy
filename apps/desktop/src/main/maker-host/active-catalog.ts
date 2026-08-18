/**
 * active-catalog —— 进程级「当前生效目录」单例(纯状态 holder,零 Electron 依赖)。
 *
 * 设计(用户敲定):OSS 上的 `providers.json` 是运行时真源,启动时(splash 阶段)由
 * `ensureActiveCatalogLoaded`(见 createDesktopProviderService.ts)拉取一次、存进这里、
 * **无 TTL**;内置 `BUNDLED_CATALOG` 仅作「尚未加载完成 / 拉取失败」时的兜底。
 *
 * **自定义供应商**:用户在本机配置的 user provider(见 custom-provider-store)经
 * `buildUserProvider` 展开成标准 `Provider` 后由 `setCustomProviders` 注入,**追加在内置之后**。
 * `getActiveCatalog()` 返回 base + custom 的合并结果——下游(路由 / 选择器 / listProviders)
 * 不区分内置 / 自定义,统一消费。custom 追加在后:`deriveAvailableModels` 保持内置同名 id
 * 的首见展示元数据；Pi 的扁平 capability 另对涉及 custom 的 effort 做交集，避免旧消费者
 * 在丢失 provider provenance 后展示某条实际路由不支持的档位。
 *
 * 所有消费方统一读 `getActiveCatalog()`,而非各自 import `BUNDLED_CATALOG`:
 *   - maker availableModels 派生(maker-host/index.ts)
 *   - 统一路由器(provider-route.ts)
 *   - 会话标题模型(provider-one-shot.ts)
 *   - 供应商注册表(provider-service.ts,经 createDesktopProviderService 注入)
 *
 * 「启动 await 一次、之后全同步读」是关键:`getActiveCatalog()` 同步返回,消费方(含路由
 * 热路径)零额外 async / 零额外网络往返。合并结果惰性缓存(base / custom 变更时失效,
 * 下次读时重算),热路径零额外分配。本模块刻意**不依赖 Electron**——electron net/fs 落地在
 * createDesktopProviderService.ts,这样依赖本 holder 的纯逻辑模块(及其单测)不被 electron 污染。
 */

import { isDeepStrictEqual } from 'node:util';

import {
  BUNDLED_CATALOG,
  buildUserProvider,
  findModelRegistryRoute,
  type AgentKind,
  type Catalog,
  type CatalogCapabilityEvidence,
  type CatalogXdMediaKind,
  type CatalogModel,
  type CustomProviderConfig,
  type Provider,
  type ProviderWireProtocol,
} from '@cindy/model-providers';

import { CURRENT_CINDY_REGION } from '../../shared/brandRegion.js';
import { CHATGPT_MODEL_PREFIX } from '../../shared/subscriptionModels.js';
import { projectUnverifiedCatalogFallbackForBuildRegion } from './provider-access-policy.js';
import {
  applyLocalConsumerOverrides,
  applyLocalOverridesToRoot,
  applyLocalOverridesToRootModel,
  hasLocalAddition,
  EMPTY_MODEL_CATALOG_OVERRIDES,
  resolveLocalBridgeExclusions,
  type ModelCatalogOverrides,
} from './model-plane/localCatalogOverrides.js';
import {
  applyRegistryConsumerOverlay,
  applyRootRegistryPlan,
  consumerPlanKey,
  planRegistryRoots,
  toChatgptBridgeModel,
  rootPlanKey,
  type ModelPlaneWarning,
  type ModelPlaneRegistryPlan,
  type RootAgentKind,
} from './model-plane/modelPlanePolicy.js';

/** OSS / bundled 加载来的基础目录;null = 尚未加载(回落 BUNDLED_CATALOG)。 */
let base: Catalog | null = null;
/** 当前基础目录是否由本次配置的 Catalog 真源明确证明；fallback 只保兼容元数据。 */
let baseCapabilityEvidence: CatalogCapabilityEvidence = 'fallback';
/** XD media fields inherited from bundled rather than proven by the current source. */
let baseUnverifiedXdMediaKinds: ReadonlySet<CatalogXdMediaKind> = new Set([
  'image',
  'video',
  'embedding',
]);
/** Last trusted Registry used only to re-project user configs; it never changes catalog membership. */
let trustedCustomProviderRegistry: Catalog['modelRegistry'] = BUNDLED_CATALOG.modelRegistry;
/** 用户自定义供应商(已 buildUserProvider 展开的标准 Provider),追加在 base 之后。 */
let custom: Provider[] = [];
/** 当前 owner 的原始配置；仅用于 Registry 热更新后的运行时重投影。 */
let customConfigs: CustomProviderConfig[] | null = null;
/**
 * codex cache 派生的规范化模型快照(原始 slug,不带 chatgpt/ 前缀)。先 augment 到
 * openai.codex,再从生效后的 codex 列表投影 openai.claude-code bridge,确保两边名称和排序同源。
 * **additions-only**:静态 id first-wins,cache 只补未来新增模型,不会覆盖目录的受控能力元数据。
 */
let discoveredCodex: CatalogModel[] = [];
/**
 * 通用 OAuth 供应商（auth.oauth 描述符）的动态发现模型:providerId → per-agent 增量。
 * 语义同 discoveredCodex:**additions-only**,只补目录里没有的新 id,静态条目 first-wins,
 * 空/坏数据绝不抹掉静态兜底。由 generic-oauth 的 models 发现流程写入。
 */
const discoveredByProvider = new Map<string, Partial<Record<AgentKind, CatalogModel[]>>>();

/**
 * xAI 订阅账号从官方 `/v1/user` → `/v1/models` 读到的权威成员清单。
 *
 * `null` = 当前 owner 尚无成功账号快照，允许公共 Catalog / bundled 只作为启动救急；
 * `[]` = 上游明确返回空清单，仍是权威结果。成员保存为 canonical `xai/grok-*`，
 * Claude/Codex 原样消费，Pi 在投影时去掉 `xai/`。
 */
export interface XaiDiscoveredModel {
  id: string;
  name?: string;
  description?: string;
  contextWindow?: number;
  contextWindowVerified?: boolean;
  maxOutput?: number;
  efforts?: CatalogModel['efforts'];
  defaultEffort?: CatalogModel['defaultEffort'];
}

let xaiDiscoveredModels: XaiDiscoveredModel[] | null = null;
/**
 * 供应商媒体模型动态发现快照。成功快照决定当前账号的型号存在性，静态／远端
 * 同 id 条目只提供 first-wins 展示元数据；发现失败不写本 Map，完整回落静态目录。
 * 媒体字段显式 `[]` 是服务端停用信号，合并时不得被本快照复活。
 */
const discoveredMediaByProvider = new Map<
  string,
  {
    imageModels?: NonNullable<Provider['imageModels']>;
    videoModels?: NonNullable<Provider['videoModels']>;
  }
>();
/** 单 tab 能力覆盖块(shared/modelAccess ModelAccessAgentOverride 同形)。 */
export interface XdGatewayAgentOverride {
  contextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
  wireProtocol?: Extract<ProviderWireProtocol, 'anthropic-messages' | 'openai-responses'>;
}

/**
 * 服务端下发的 XD 网关模型条目(shared/modelAccess ModelAccessGatewayModel 的子集)。
 * 命名沿用历史("聊天"),但条目本身不保证是聊天模型——是否聊天模型看 mode,
 * 服务端目前只透传已经过它自己 chat 过滤的条目,过滤范围以后可能放开(issue #882);
 * 客户端一律用 isChatEligible 判定,不依赖本类型名字或服务端过滤范围。
 *
 * 能力字段已由服务端一次归一化,客户端不再二次转换(见 model-access/index.ts)。
 */
export interface XdGatewayModelInfo {
  id: string;
  /** Gateway 原生 mode(issue #882,权威分类字段;缺省时下游按 id 正则兜底)。 */
  mode?: string;
  /** AIGateway 折扣比例(0..1),折后价 = 原价 × (1 - costDiscount)。 */
  costDiscount?: number;
  /** AIGateway 标准 token 单价(per token)。 */
  inputCostPerToken?: number;
  outputCostPerToken?: number;
  /** AIGateway 缓存 token 单价(per token);参与「免费」判定与价格展示。 */
  cacheReadInputTokenCost?: number;
  cacheCreationInputTokenCost?: number;
  /** 进哪些 runtime tab；v3 由服务端完整下发。 */
  agents?: AgentKind[];
  name?: string;
  group?: string;
  description?: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  sortOrder?: number;
  /** Fast 支持;缺省按 false(上游未声明时不猜测能力)。 */
  supportsFastMode?: boolean;
  /** 默认可见性;缺省按 true。 */
  defaultEnabled?: boolean;
  /**
   * 新对话默认种子的 agent 标记(服务端 /models 下发的 newSessionDefault)。
   */
  newSessionDefault?: ('claude-code' | 'codex' | 'pi')[];
  /** 展示图标 id(AI Gateway 设定;缺省 / 未知值渲染层回落来源供应商标)。 */
  icon?: string;
  modalities?: { input: string[]; output: string[] };
  /** per-tab 能力覆盖。 */
  perAgent?: Partial<Record<AgentKind, XdGatewayAgentOverride>>;
}

/**
 * XD 网关(内置 xd 供应商)的**权威模型清单**(model-access-server GET /models:
 * AIGateway /model-groups 投影 + 服务端内置常量表富化;2026-07-17 定案:XD 模型
 * 列表完全以网关为准,不再由 OSS 产品目录决定)。未登录 / 拉取失败 / 空响应时
 * 保持空数组,绝不把产品目录里的静态模型冒充成网关实时可用模型。有值时 xd
 * 供应商的模型列表整体重建。模型、tab 归属、展示元数据和价格都只读服务端条目；
 * v3 必需字段在协议边界严格校验；这里不读取公共 Catalog，也不按模型 id 或固定常量补值。
 */
let xdGatewayModels: XdGatewayModelInfo[] = [];
/**
 * XD 模型里「由客户端投影给 Codex、但走 Anthropic Messages bridge」的 id 集合。
 * Responses → Anthropic Messages bridge，不能误用 XD 的原生 Responses 路由。
 * Set 在模型目录刷新时一次性派生，路由热路径只做 O(1) 查询。
 */
let xdCodexAnthropicBridgeModelIds = new Set<string>();

/**
 * Anthropic(Claude.ai 订阅)的**发现清单**:由 host 的 anthropic 发现流程注入
 * (登录时 HTTP `/v1/models` + 会话 init 时 SDK supportedModels 捕获,见
 * maker-host/model-discovery/anthropic.ts)。2026-08-02 起 discovery 是「已验证
 * 可用性」证据层,不再独占存在性:registry 显式实体化条目(policy 门禁见
 * model-plane/modelPlanePolicy.ts)即使未被发现也进目录——presence 与
 * entitlement 分离,选不选得中由连接态与运行期共同决定。
 */
let anthropicModels: CatalogModel[] = [];

/**
 * 用户本地目录 override(model-catalog-override-store 读入的已清洗快照)。
 * local 永远最高:远端刷新只换 base/registry 层,合并期最后作用于 root。
 */
let localOverrides: ModelCatalogOverrides = EMPTY_MODEL_CATALOG_OVERRIDES;

/** 最近一次合并的 registry 实体化告警(单 route 隔离不拖垮其余;刷新路径读走打日志)。 */
let lastPlanWarnings: ModelPlaneWarning[] = [];

type Effort = CatalogModel['efforts'][number];

function xdGatewayTargetAgents(model: XdGatewayModelInfo): AgentKind[] {
  return model.agents ? [...model.agents] : [];
}

/**
 * XD 下发模型给 Pi 时的真实 wire protocol。
 *
 * Pi provider 始终叫 `cindy`；这里只读取 v3 服务端给该模型的 transport，供
 * models.json 写入模型级 `api`。三态语义：非 XD Pi 模型返回 undefined；XD Pi 模型
 * 缺失或协议非法返回 null，由 maker-core fail closed；有效配置返回 Responses。
 */
export function resolveXdPiGatewayWireProtocol(
  modelId: string,
): Extract<ProviderWireProtocol, 'openai-responses'> | null | undefined {
  const normalized = modelId.replace(/\[1m\]$/, '');
  const gatewayModel = xdGatewayModels.find((model) => model.id === normalized);
  if (!gatewayModel?.agents?.includes('pi')) return undefined;
  const wireProtocol = gatewayModel.perAgent?.pi?.wireProtocol;
  return wireProtocol === 'openai-responses' ? wireProtocol : null;
}

/** 派生 XD 中「仅 claude-code 面（投影给 Claude）、无 codex 原生」的模型 id 集合。 */
function deriveXdCodexAnthropicBridgeModelIds(models: XdGatewayModelInfo[]): Set<string> {
  const support = new Map<string, { claudeCode: boolean; codex: boolean }>();
  for (const model of models) {
    const current = support.get(model.id) ?? { claudeCode: false, codex: false };
    for (const agent of xdGatewayTargetAgents(model)) {
      if (agent === 'claude-code') current.claudeCode = true;
      else if (agent === 'codex') current.codex = true;
    }
    support.set(model.id, current);
  }
  return new Set(
    [...support]
      .filter(([, agents]) => agents.claudeCode && !agents.codex)
      .map(([modelId]) => modelId),
  );
}

/** 当前 XD 模型是否由客户端投影给 Codex、并应走 Anthropic Messages bridge。 */
export function isXdCodexAnthropicBridgeModel(modelId: string): boolean {
  // Codex 会把 1M 上下文选择编码成 wire model 后缀；目录身份仍是原始 model id。
  // wire model 还可能带 `codex/` 前缀（视觉桥按模型前缀选面时传给路由判定的形态）；
  // 剥到目录身份再查，否则投影特例不命中、误走 Responses 面。
  const normalized = modelId.replace(/\[1m\]$/, '').replace(/^codex\//, '');
  return xdCodexAnthropicBridgeModelIds.has(normalized);
}

function nonNegativeFiniteOrUndefined(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function effectiveGatewayModelCost(model: XdGatewayModelInfo): CatalogModel['cost'] | undefined {
  const input = model.inputCostPerToken;
  const output = model.outputCostPerToken;
  if (
    typeof input !== 'number' ||
    !Number.isFinite(input) ||
    input < 0 ||
    typeof output !== 'number' ||
    !Number.isFinite(output) ||
    output < 0
  ) {
    return undefined;
  }
  const discount =
    typeof model.costDiscount === 'number' &&
    Number.isFinite(model.costDiscount) &&
    model.costDiscount > 0 &&
    model.costDiscount <= 1
      ? model.costDiscount
      : 0;
  const multiplier = 1 - discount;
  const cacheRead = nonNegativeFiniteOrUndefined(model.cacheReadInputTokenCost);
  const cacheWrite = nonNegativeFiniteOrUndefined(model.cacheCreationInputTokenCost);
  return {
    input: input * 1_000_000 * multiplier,
    output: output * 1_000_000 * multiplier,
    ...(cacheRead !== undefined ? { cacheRead: cacheRead * 1_000_000 * multiplier } : {}),
    ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite * 1_000_000 * multiplier } : {}),
  };
}

/** base + custom + discovered augment 的合并缓存;null = 待重算(惰性)。 */
let merged: Catalog | null = null;
/** 当前 registry 的 Anthropic 路由元数据索引；目录变化时与 merged 一起失效。 */
let effectiveRegistryMetaIndex: Map<string, RegistryMetaFields> | null = null;

/**
 * 目录修订号。所有会改变 getActiveCatalog() 结果的写入都必须经过 markChanged，
 * 让 main 能先同步刷新 Maker capabilities，再向 renderer 广播同一代目录。
 */
let revision = 0;

/** Electron 相关副作用由 desktop host 注入，本模块继续保持纯状态容器。 */
let changedListener: ((nextRevision: number) => void) | null = null;

function markChanged(): void {
  merged = null;
  effectiveRegistryMetaIndex = null;
  revision += 1;
  changedListener?.(revision);
}

/** additions-only:静态同 id first-wins；Codex 投影可显式要求按 sortOrder 稳定重排。 */
function augmentModels(
  p: Provider,
  agent: AgentKind,
  additions: CatalogModel[],
  sortByOrder = false,
): Provider {
  const existing = p.models[agent] ?? [];
  const existingIds = new Set(existing.map((m) => m.id));
  const fresh = additions.filter((m) => !existingIds.has(m.id));
  if (fresh.length === 0) return p;
  const combined = [...existing, ...fresh];
  const models = sortByOrder
    ? combined
        .map((model, index) => ({ model, index }))
        .sort(
          (a, b) =>
            (a.model.sortOrder ?? Number.MAX_SAFE_INTEGER) -
              (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
        )
        .map(({ model }) => model)
    : combined;
  return { ...p, models: { ...p.models, [agent]: models } };
}

function applyMediaDiscovery(
  provider: Provider,
  key: 'imageModels' | 'videoModels',
  discovered: NonNullable<Provider['imageModels']>,
): Provider {
  const existing = provider[key];
  // undefined = 这份原始目录没有声明能力；正常加载路径会先由 source 用 bundled
  // 补旧目录。[] 则是明确停用。两种情况都不能仅凭账号发现把能力凭空复活。
  if (!existing || existing.length === 0) return provider;
  // 官方端点成功返回空清单 = 当前账号此类媒体没有可执行型号。它与请求失败不同，
  // 必须清掉旧快照／静态兜底，不能继续展示一个账号实际不可用的型号。
  if (discovered.length === 0) return { ...provider, [key]: [] };
  const discoveredById = new Map(discovered.map((model) => [model.id, model]));
  const retained = existing.filter((model) => discoveredById.delete(model.id));
  const next = [...retained, ...discoveredById.values()];
  const unchanged =
    next.length === existing.length && next.every((model, index) => model === existing[index]);
  return unchanged ? provider : { ...provider, [key]: next };
}

/**
 * 以生效 Codex 列表校正 bridge 的展示名称 / 排序，同时保留 bridge 自己的 context、effort、
 * defaultEnabled 等 runtime 能力。这样旧远端目录里曾固化的本地化后缀也不会继续泄漏。
 *
 * claude-code bridge 受 registry membership 门控(route.agents 不含 claude-code 的
 * 模型经 `claudeExcluded` 排除);Pi 恒定从 codex root 派生、不受门控——投影拓扑
 * 见 model-plane/modelPlanePolicy.ts。
 */
function projectCodexModelsToBridges(
  p: Provider,
  claudeExcluded: ReadonlySet<string> = new Set(),
  prepareClaudeModel: (model: CatalogModel) => CatalogModel = (model) => model,
  preparePiModel: (model: CatalogModel) => CatalogModel = (model) => model,
): Provider {
  const codex = p.models.codex ?? [];
  const canonical = new Map(codex.map((model) => [model.id, model]));
  const existing = p.models['claude-code'] ?? [];
  let aligned = false;
  const alignedExisting = existing.map((model) => {
    if (!model.id.startsWith(CHATGPT_MODEL_PREFIX)) return model;
    const source = canonical.get(model.id.slice(CHATGPT_MODEL_PREFIX.length));
    if (!source || (model.name === source.name && model.sortOrder === source.sortOrder))
      return model;
    aligned = true;
    return { ...model, name: source.name, sortOrder: source.sortOrder };
  });
  const withAligned = aligned
    ? { ...p, models: { ...p.models, 'claude-code': alignedExisting } }
    : p;
  const claudeSource = codex.filter((model) => !claudeExcluded.has(model.id));
  const withClaude = augmentModels(
    withAligned,
    'claude-code',
    claudeSource.map((model) => toChatgptBridgeModel(prepareClaudeModel(model))),
    true,
  );
  return augmentModels(
    withClaude,
    'pi',
    codex.map((model) => toChatgptBridgeModel(preparePiModel(model))),
    true,
  );
}

/** 静态段被淘汰的供应商：先清空 providers.models，再由 discovery + Registry/local root 装配。 */
const DYNAMIC_LIST_PROVIDER_IDS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'xd']);

/**
 * Anthropic discovery 映射阶段读取的 Registry 字段子集：上游缺字段时先用它补齐，
 * 随后的 root 装配仍按统一优先级 local > Registry 显式 > discovery 显式。
 * 这只是 discovery 适配器的同步查询索引，不是另一套合并权威。
 */
interface RegistryMetaFields {
  name?: string;
  group?: string;
  description?: string;
  sortOrder?: number;
  defaultEnabled?: boolean;
  contextWindow?: number;
  maxOutput?: number;
  efforts?: Effort[];
  defaultEffort?: Effort | null;
  supportsFastMode?: boolean;
  status?: CatalogModel['status'];
}

function modelRegistryMetaFields(
  providerId: string,
  agent: AgentKind,
  modelId: string,
): RegistryMetaFields | undefined {
  // 模型 registry 的路由与 perAgent 覆盖只按 claude-code / codex 建键;Pi 是动态 BYOM,
  // 无 registry per-agent 覆盖,按 agent 无关处理(取条目基线元数据)。
  const registryAgent = agent === 'pi' ? undefined : agent;
  const catalog = base ?? BUNDLED_CATALOG;
  const matched = findModelRegistryRoute(catalog.modelRegistry, providerId, modelId, registryAgent);
  if (!matched) return undefined;
  const { entry } = matched;
  const perAgent = registryAgent ? entry.perAgent?.[registryAgent] : undefined;
  const efforts = perAgent?.efforts ?? entry.efforts;
  const defaultEffort = perAgent?.defaultEffort ?? entry.defaultEffort;
  return {
    name: entry.name,
    ...(entry.group !== undefined ? { group: entry.group } : {}),
    ...(entry.description !== undefined ? { description: entry.description } : {}),
    ...(entry.sortOrder !== undefined ? { sortOrder: entry.sortOrder } : {}),
    ...(perAgent?.defaultEnabled !== undefined || entry.defaultEnabled !== undefined
      ? { defaultEnabled: perAgent?.defaultEnabled ?? entry.defaultEnabled }
      : {}),
    ...(perAgent?.contextWindow !== undefined || entry.contextWindow !== undefined
      ? { contextWindow: perAgent?.contextWindow ?? entry.contextWindow }
      : {}),
    ...(entry.maxOutputTokens !== undefined ? { maxOutput: entry.maxOutputTokens } : {}),
    ...(efforts !== undefined ? { efforts: efforts as Effort[] } : {}),
    ...(defaultEffort !== undefined
      ? { defaultEffort: defaultEffort as Effort }
      : efforts?.length === 0
        ? { defaultEffort: null }
        : {}),
    ...(perAgent?.supportsFastMode !== undefined || entry.supportsFastMode !== undefined
      ? { supportsFastMode: perAgent?.supportsFastMode ?? entry.supportsFastMode }
      : {}),
    ...(entry.status !== undefined
      ? {
          status:
            entry.status === 'preview'
              ? 'alpha'
              : entry.status === 'deprecated' || entry.status === 'retired'
                ? 'deprecated'
                : 'active',
        }
      : {}),
  };
}

/** Registry 是动态发现缺少能力信息时唯一的产品元数据基线。 */
function buildEffectiveRegistryMetaIndex(): Map<string, RegistryMetaFields> {
  if (effectiveRegistryMetaIndex) return effectiveRegistryMetaIndex;

  const effective = new Map<string, RegistryMetaFields>();
  const registry = (base ?? BUNDLED_CATALOG).modelRegistry;
  for (const entry of registry?.models ?? []) {
    for (const route of entry.routes) {
      if (route.providerId !== 'anthropic' || !route.agents.includes('claude-code')) continue;
      const fields = modelRegistryMetaFields('anthropic', 'claude-code', route.modelId);
      if (fields) effective.set(route.modelId, fields);
    }
  }
  effectiveRegistryMetaIndex = effective;
  return effectiveRegistryMetaIndex;
}

export interface CindyModelEffortBaseline {
  efforts: Effort[];
  defaultEffort: Effort | null;
}

/** 返回当前目录的已知上下文窗口；只供动态发现缺少上游明确值时兜底。 */
export function getCindyModelContextWindow(modelId: string): number | null {
  return buildEffectiveRegistryMetaIndex().get(modelId)?.contextWindow ?? null;
}

/**
 * 返回当前目录的模型 effort 基线。只供动态发现缺少 capability 字段时兜底；
 * 模型存在性由 discovery 证据或通过 policy 门禁的 Registry presence 决定。
 */
export function getCindyModelEffortBaseline(modelId: string): CindyModelEffortBaseline | null {
  const fields = buildEffectiveRegistryMetaIndex().get(modelId);
  if (!fields?.efforts) return null;
  const efforts = [...fields.efforts];
  const defaultEffort =
    fields.defaultEffort !== undefined &&
    (fields.defaultEffort === null || efforts.includes(fields.defaultEffort))
      ? fields.defaultEffort
      : efforts.includes('high')
        ? 'high'
        : (efforts[efforts.length - 1] ?? null);
  return { efforts, defaultEffort };
}

/** 按 sortOrder 稳定排序(无 sortOrder 排最后,按进入序)——与 augmentModels 同口径。 */
function sortModelsByOrder(models: CatalogModel[]): CatalogModel[] {
  return models
    .map((model, index) => ({ model, index }))
    .sort(
      (a, b) =>
        (a.model.sortOrder ?? Number.MAX_SAFE_INTEGER) -
          (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
    )
    .map(({ model }) => model);
}

/**
 * root 装配:registry plan(overlay / 实体化 / retired 标记)→ 本地 override
 * (addition 整条胜 + patch 逐字段)→ retired 复标——patch 改 status 也压不掉
 * 远端 tombstone,唯一复活通道是完整 local addition(hasLocalAddition 豁免)。
 * overlay / 本地 patch 合并后始终按最终 sortOrder 稳定重排；xAI legacy 根保留
 * Registry 声明顺序，与服务端投影给旧客户端的数组保持逐项兼容。
 */
function assembleRoot(
  providerId: string,
  agent: RootAgentKind,
  models: readonly CatalogModel[],
  plan: ModelPlaneRegistryPlan,
  preserveDeclarationOrder = false,
): CatalogModel[] {
  const rootPlan = plan.roots.get(rootPlanKey(providerId, agent));
  let out = applyRootRegistryPlan(models, rootPlan);
  out = applyLocalOverridesToRoot(providerId, agent, out, localOverrides, plan.warnings);
  if (rootPlan && rootPlan.retired.size > 0) {
    out = out.map((m) =>
      rootPlan.retired.has(m.id) &&
      m.status !== 'retired' &&
      !hasLocalAddition(localOverrides, providerId, m.id, agent)
        ? { ...m, status: 'retired' as const }
        : m,
    );
  }
  return preserveDeclarationOrder ? out : sortModelsByOrder(out);
}

/** Registry / local override 只能补账号已返回的条目，不能重新实体化账号没有的成员。 */
function assembleAuthoritativeRoot(
  providerId: string,
  agent: RootAgentKind,
  models: readonly CatalogModel[],
  plan: ModelPlaneRegistryPlan,
): CatalogModel[] {
  const memberIds = new Set(models.map((model) => model.id));
  return assembleRoot(providerId, agent, models, plan, true).filter((model) =>
    memberIds.has(model.id),
  );
}

function xaiCatalogModelById(
  provider: Provider,
  id: string,
  agent: AgentKind,
): CatalogModel | undefined {
  const bundled = BUNDLED_CATALOG.providers.find((entry) => entry.id === 'xai');
  if (agent === 'pi') {
    const bare = id.startsWith('xai/') ? id.slice('xai/'.length) : id;
    return (
      provider.models.pi?.find((model) => model.id === bare) ??
      bundled?.models.pi?.find((model) => model.id === bare)
    );
  }
  return (
    provider.models[agent]?.find((model) => model.id === id) ??
    bundled?.models[agent]?.find((model) => model.id === id)
  );
}

function materializeXaiAccountModels(
  provider: Provider,
  agent: RootAgentKind,
  discovered: readonly XaiDiscoveredModel[],
): CatalogModel[] {
  return discovered.map((entry, index) => {
    const catalogModel =
      xaiCatalogModelById(provider, entry.id, agent) ??
      xaiCatalogModelById(provider, entry.id, 'pi');
    const registry = modelRegistryMetaFields('xai', agent, entry.id);
    const efforts = entry.efforts
      ? [...entry.efforts]
      : [...(registry?.efforts ?? catalogModel?.efforts ?? [])];
    const requestedDefault =
      entry.defaultEffort !== undefined
        ? entry.defaultEffort
        : (registry?.defaultEffort ?? catalogModel?.defaultEffort ?? null);
    const defaultEffort =
      requestedDefault !== null && efforts.includes(requestedDefault)
        ? requestedDefault
        : efforts.includes('high')
          ? 'high'
          : (efforts[efforts.length - 1] ?? null);
    const contextWindow =
      entry.contextWindow ?? registry?.contextWindow ?? catalogModel?.contextWindow ?? 200_000;
    const contextWindowVerified =
      entry.contextWindow !== undefined
        ? (entry.contextWindowVerified ?? true)
        : registry?.contextWindow !== undefined || catalogModel?.contextWindowVerified === true;
    return {
      ...catalogModel,
      id: entry.id,
      name: entry.name ?? registry?.name ?? catalogModel?.name ?? entry.id.slice('xai/'.length),
      ...(entry.description !== undefined
        ? { description: entry.description }
        : registry?.description !== undefined
          ? { description: registry.description }
          : {}),
      group: registry?.group ?? catalogModel?.group ?? 'grok',
      sortOrder: registry?.sortOrder ?? catalogModel?.sortOrder ?? 1_000 + index,
      contextWindow,
      ...(contextWindowVerified ? { contextWindowVerified: true } : {}),
      ...(entry.maxOutput !== undefined
        ? { maxOutput: entry.maxOutput }
        : registry?.maxOutput !== undefined
          ? { maxOutput: registry.maxOutput }
          : catalogModel?.maxOutput !== undefined
            ? { maxOutput: catalogModel.maxOutput }
            : {}),
      efforts,
      defaultEffort,
      ...(registry?.supportsFastMode !== undefined
        ? { supportsFastMode: registry.supportsFastMode }
        : {}),
      status: registry?.status ?? catalogModel?.status ?? 'active',
      defaultEnabled: registry?.defaultEnabled ?? catalogModel?.defaultEnabled ?? true,
    };
  });
}

function bundledXaiFallbackMembers(provider: Provider): XaiDiscoveredModel[] {
  return (provider.models.pi ?? []).map((model) => ({
    id: model.id.startsWith('xai/') ? model.id : `xai/${model.id}`,
  }));
}

function projectXaiPiModel(provider: Provider, model: CatalogModel): CatalogModel {
  const bareId = model.id.startsWith('xai/') ? model.id.slice('xai/'.length) : model.id;
  const piMetadata = xaiCatalogModelById(provider, model.id, 'pi');
  return {
    ...model,
    ...piMetadata,
    id: bareId,
    name: model.name,
    description: model.description,
    group: model.group,
    sortOrder: model.sortOrder,
    contextWindow: model.contextWindow,
    ...(model.contextWindowVerified !== undefined
      ? { contextWindowVerified: model.contextWindowVerified }
      : {}),
    ...(model.maxOutput !== undefined ? { maxOutput: model.maxOutput } : {}),
    // Official Pi effort maps stay authoritative, including explicit empty lists.
    // CC/Codex root efforts must not leak into the Pi projection.
    status: model.status,
    defaultEnabled: model.defaultEnabled,
  };
}

/** 把 provider 的全部 per-agent 模型清单清零(保留身份卡);已为空则原样返回。 */
function withEmptyModels(p: Provider): Provider {
  const entries = Object.entries(p.models) as [AgentKind, CatalogModel[]][];
  if (entries.every(([, list]) => list.length === 0)) return p;
  const models: Provider['models'] = {};
  for (const [agent] of entries) models[agent] = [];
  return { ...p, models };
}

function computeMerged(): Catalog {
  const source = base ?? BUNDLED_CATALOG;
  const b =
    baseCapabilityEvidence === 'current'
      ? projectUnverifiedCatalogFallbackForBuildRegion(
          source,
          CURRENT_CINDY_REGION,
          baseUnverifiedXdMediaKinds,
        )
      : projectUnverifiedCatalogFallbackForBuildRegion(source, CURRENT_CINDY_REGION);
  // Dynamic OpenAI/Anthropic roots are rebuilt from discovery/registry below,
  // but the daily OSS catalog may carry sparse PI protocol annotations. Keep
  // only that metadata and apply it after existence has been independently
  // proven; these entries never create a selectable model by themselves.
  const piApiByProvider = new Map<string, Map<string, NonNullable<CatalogModel['piApi']>>>();
  for (const provider of b.providers) {
    const annotationSources = [
      ...(provider.models.pi ?? []),
      ...(provider.id === 'xai' ? (provider.models['claude-code'] ?? []) : []),
    ];
    for (const model of annotationSources) {
      if (!model.piApi) continue;
      const byModel = piApiByProvider.get(provider.id) ?? new Map();
      byModel.set(model.id, model.piApi);
      if (provider.id === 'openai' && model.id.startsWith(CHATGPT_MODEL_PREFIX)) {
        byModel.set(model.id.slice(CHATGPT_MODEL_PREFIX.length), model.piApi);
      }
      piApiByProvider.set(provider.id, byModel);
    }
  }
  const applyPiApiAnnotations = (providerId: string, models: CatalogModel[]): CatalogModel[] => {
    const annotations = piApiByProvider.get(providerId);
    if (!annotations || annotations.size === 0) return models;
    return models.map((model) => {
      const rawId =
        providerId === 'openai' && model.id.startsWith(CHATGPT_MODEL_PREFIX)
          ? model.id.slice(CHATGPT_MODEL_PREFIX.length)
          : model.id;
      const piApi = annotations.get(model.id) ?? annotations.get(rawId);
      return piApi && model.piApi !== piApi ? { ...model, piApi } : model;
    });
  };
  // registry 消费计划(实体化/overlay/retired/bridge 门控)一次算好;单 route 的
  // 作者错误隔离进 warnings,由刷新路径读走打日志,不拖垮其余条目。
  const plan = planRegistryRoots(b.modelRegistry);
  lastPlanWarnings = plan.warnings;
  // XD 的对话模型成员仍由下方 `/models` 权威重建，但 provider 壳中的媒体清单、
  // 默认项和显式空值必须服从当前 Catalog。只有目录本身缺少 XD（生产加载经
  // mergeWithBundled 后通常不会发生）才回落与 evidence 同级安全的 bundled 壳。
  const fallbackXdCatalog =
    baseCapabilityEvidence === 'current'
      ? projectUnverifiedCatalogFallbackForBuildRegion(
          BUNDLED_CATALOG,
          CURRENT_CINDY_REGION,
          baseUnverifiedXdMediaKinds,
        )
      : projectUnverifiedCatalogFallbackForBuildRegion(BUNDLED_CATALOG, CURRENT_CINDY_REGION);
  const catalogXd = b.providers.find((provider) => provider.id === 'xd');
  const xdShell = catalogXd ?? fallbackXdCatalog.providers.find((provider) => provider.id === 'xd');
  const bundledXai = BUNDLED_CATALOG.providers.find((provider) => provider.id === 'xai');
  const remoteXdIndex = b.providers.findIndex((provider) => provider.id === 'xd');
  const providerSources = b.providers.filter((provider) => provider.id !== 'xd');
  if (xdShell) providerSources.splice(Math.max(0, remoteXdIndex), 0, xdShell);
  let providers: Provider[] = providerSources;

  // 先清零已退役的静态 providers.models 段：无论目录来自 bundled 还是远端，
  // OpenAI/Anthropic 的 root 都只由 discovery 证据 + Registry presence + local
  // addition 重新装配；XD 随后仍由 Gateway /models 独占重建。
  const normalized = providers.map((p) =>
    DYNAMIC_LIST_PROVIDER_IDS.has(p.id) ? withEmptyModels(p) : p,
  );
  if (normalized.some((p, index) => p !== providers[index])) providers = normalized;

  // 同一份规范快照先进入 Codex root;bridge/Pi 投影移到 root 装配(registry 实体化 +
  // 本地 override)之后统一做——派生端永远从最终 root 重算,不再维护两份名单。
  const withCodexDiscovery = providers.map((p) =>
    p.id === 'openai' ? augmentModels(p, 'codex', discoveredCodex, true) : p,
  );
  if (withCodexDiscovery.some((p, index) => p !== providers[index])) {
    providers = withCodexDiscovery;
  }

  // 自定义供应商先追加、再做通用发现 augment——顺序反了的话,自定义 OAuth 供应商
  // 的发现模型永远合不进目录(map 只扫过内置列表)。
  if (custom.length > 0) providers = [...providers, ...custom];

  // 通用 OAuth 供应商的发现模型(additions-only,per provider × agent;内置与自定义同待遇)。
  if (discoveredByProvider.size > 0) {
    providers = providers.map((p) => {
      const byAgent = discoveredByProvider.get(p.id);
      if (!byAgent) return p;
      let next = p;
      for (const [agent, additions] of Object.entries(byAgent) as [AgentKind, CatalogModel[]][]) {
        if (additions.length > 0) next = augmentModels(next, agent, additions);
      }
      return next;
    });
  }
  if (discoveredMediaByProvider.size > 0) {
    providers = providers.map((provider) => {
      const snapshot = discoveredMediaByProvider.get(provider.id);
      if (!snapshot) return provider;
      let next = provider;
      if (snapshot.imageModels) {
        next = applyMediaDiscovery(next, 'imageModels', snapshot.imageModels);
      }
      if (snapshot.videoModels) {
        next = applyMediaDiscovery(next, 'videoModels', snapshot.videoModels);
      }
      return next;
    });
  }
  // ── root 装配 + 投影(2026-08-02 模型平面收敛,拓扑见 model-plane/modelPlanePolicy.ts)。
  // 每个 allowlist 供应商:registry presence 实体化/overlay + retired 标记 → 本地
  // override(local 永远最高)→ 派生端(bridge/Pi)从最终 root 统一重算。
  // 优先级:local addition/patch > registry 显式字段 > discovery 显式值 > 静态兜底。
  // 注:anthropic 的 discovery 快照非空时整表以它为基线(登录态权威);registry
  // 实体化条目在未登录时也保持 presence——能否选中由连接态门控,presence ≠ entitlement。
  providers = providers.map((p) => {
    if (p.id === 'openai') {
      const root = assembleRoot('openai', 'codex', p.models.codex ?? [], plan);
      const withRoot: Provider = { ...p, models: { ...p.models, codex: root } };
      const remoteExcluded =
        plan.roots.get(rootPlanKey('openai', 'codex'))?.bridgeExcluded ?? new Set<string>();
      const excluded = resolveLocalBridgeExclusions(
        'openai',
        'claude-code',
        remoteExcluded,
        localOverrides,
      );
      const prepareClaudeModel = (model: CatalogModel): CatalogModel =>
        applyLocalConsumerOverrides(
          'openai',
          'claude-code',
          model.id,
          applyRegistryConsumerOverlay(model, 'openai', 'claude-code', model.id, plan),
          localOverrides,
          plan.warnings,
        );
      const preparePiModel = (model: CatalogModel): CatalogModel =>
        applyLocalOverridesToRootModel(
          'openai',
          'codex',
          applyRegistryConsumerOverlay(model, 'openai', 'pi', model.id, plan),
          localOverrides,
          plan.warnings,
        );
      const projected = projectCodexModelsToBridges(
        withRoot,
        excluded,
        prepareClaudeModel,
        preparePiModel,
      );
      const appendConsumerAdditions = (
        agent: 'claude-code' | 'pi',
        models: CatalogModel[],
      ): CatalogModel[] => {
        const additions = (plan.consumerAdditions.get(consumerPlanKey('openai', agent)) ?? []).map(
          (model) =>
            toChatgptBridgeModel(
              agent === 'pi'
                ? applyLocalOverridesToRootModel(
                    'openai',
                    'codex',
                    model,
                    localOverrides,
                    plan.warnings,
                  )
                : applyLocalConsumerOverrides(
                    'openai',
                    'claude-code',
                    model.id,
                    model,
                    localOverrides,
                    plan.warnings,
                  ),
            ),
        );
        if (additions.length === 0) return models;
        const seen = new Set(models.map((model) => model.id));
        return [...models, ...additions.filter((model) => !seen.has(model.id))];
      };
      return {
        ...projected,
        models: {
          ...projected.models,
          'claude-code': appendConsumerAdditions(
            'claude-code',
            projected.models['claude-code'] ?? [],
          ),
          pi: applyPiApiAnnotations(
            'openai',
            appendConsumerAdditions('pi', projected.models.pi ?? []),
          ),
        },
      };
    }
    if (p.id === 'anthropic') {
      const seed = anthropicModels.length > 0 ? anthropicModels : (p.models['claude-code'] ?? []);
      const root = assembleRoot('anthropic', 'claude-code', seed, plan);
      const remoteExcluded =
        plan.roots.get(rootPlanKey('anthropic', 'claude-code'))?.bridgeExcluded ??
        new Set<string>();
      const excluded = resolveLocalBridgeExclusions(
        'anthropic',
        'codex',
        remoteExcluded,
        localOverrides,
      );
      // codex bridge 受 membership 门控且 fast=false(硬约束);Pi 恒定镜像 root。
      const codexBridge = root
        .filter((m) => !excluded.has(m.id))
        .map((model) =>
          applyLocalConsumerOverrides(
            'anthropic',
            'codex',
            model.id,
            applyRegistryConsumerOverlay(model, 'anthropic', 'codex', model.id, plan),
            localOverrides,
            plan.warnings,
          ),
        )
        .map((model) => ({ ...model, supportsFastMode: false }));
      return {
        ...p,
        models: {
          ...p.models,
          'claude-code': root,
          codex: codexBridge,
          pi: applyPiApiAnnotations('anthropic', root),
        },
      };
    }
    if (p.id === 'xai') {
      const useAccountMembership = xaiDiscoveredModels !== null;
      const accountModels = xaiDiscoveredModels ?? [];
      // The bundled-only fallback uses Pi's official list as its membership seed because it is
      // the freshest packaged xAI list (and currently carries Grok 4.6). A loaded server Catalog
      // remains the preceding fallback and keeps its own legacy static membership for old server
      // compatibility. Any successful account snapshot, including [], overrides both.
      const authoritativeMembers = useAccountMembership
        ? accountModels
        : b === BUNDLED_CATALOG || p === bundledXai
          ? bundledXaiFallbackMembers(p)
          : null;
      const claudeSeed = authoritativeMembers
        ? materializeXaiAccountModels(p, 'claude-code', authoritativeMembers)
        : (p.models['claude-code'] ?? []);
      const codexSeed = authoritativeMembers
        ? materializeXaiAccountModels(p, 'codex', authoritativeMembers)
        : (p.models.codex ?? []);
      const claudeRoot = authoritativeMembers
        ? assembleAuthoritativeRoot('xai', 'claude-code', claudeSeed, plan)
        : assembleRoot('xai', 'claude-code', claudeSeed, plan, true);
      const codexRoot = authoritativeMembers
        ? assembleAuthoritativeRoot('xai', 'codex', codexSeed, plan)
        : assembleRoot('xai', 'codex', codexSeed, plan, true);
      const stripPiApi = (model: CatalogModel): CatalogModel => {
        if (model.piApi === undefined) return model;
        const rest = { ...model };
        delete rest.piApi;
        return rest;
      };
      const piModels = applyPiApiAnnotations(
        'xai',
        claudeRoot.map((model) => projectXaiPiModel(p, model)),
      );
      return {
        ...p,
        agents: p.agents.includes('pi') ? p.agents : [...p.agents, 'pi' as AgentKind],
        routing: {
          ...p.routing,
          ...(p.routing.pi
            ? {}
            : bundledXai?.routing.pi
              ? {
                  pi: bundledXai.routing.pi,
                }
              : {}),
        },
        models: {
          ...p.models,
          'claude-code': claudeRoot.map(stripPiApi),
          codex: codexRoot.map(stripPiApi),
          pi: piModels,
        },
      };
    }
    return p;
  });

  // XD 网关权威模型清单重建。即使实时清单为空也必须重建为空:不能证明某个模型
  // 当前在网关可用就不显示。元数据**只信服务端下发**(2026-07-19 起
  // 不再回落产品目录静态模型条目——服务端 modelRegistry 已是唯一策展元数据权威):
  //   - perAgent 覆盖块按 tab 应用在基线字段之上;
  //   - efforts 缺失或 [] = 没有可调档位，不合成任何档位;
  //   - defaultEffort 只使用服务端明确下发值，不猜 high / 最大档;
  //   - supportsFastMode / defaultEnabled 缺失就保持缺失，不物化客户端默认值;
  //   - v3 name / contextWindow 已在 HTTP 协议边界强制要求，这里绝不补 id / 200K。
  // 放在所有 augment 之后:只影响 xd 供应商自己的模型列表,同 id 模型经其它供应商
  // (如 anthropic 订阅直连)仍照常可用。
  const gwModels = xdGatewayModels;
  providers = providers.map((p) => {
    if (p.id !== 'xd') return p;
    const agentKeys = Object.keys(p.models) as AgentKind[];

    const models: Provider['models'] = {};
    for (const agent of agentKeys) models[agent] = [];
    for (const gm of gwModels) {
      // tab 归属只读服务端 agents；v3 缺失时不向任何 Agent 猜测或补全。
      const targetAgents = xdGatewayTargetAgents(gm);
      for (const agent of targetAgents) {
        if (!models[agent]) continue; // 未知 agent 键防御(wire 数据)
        const ov = gm.perAgent?.[agent] ?? {};
        // v3 validator 已检查 effort 枚举与 defaultEffort 从属关系；此处只做层级覆盖。
        const efforts = (ov.efforts ?? gm.efforts ?? []) as Effort[];
        const rawDefault = ov.defaultEffort !== undefined ? ov.defaultEffort : gm.defaultEffort;
        const defaultEffort = (rawDefault ?? null) as Effort | null;
        const defaultEnabled = ov.defaultEnabled ?? gm.defaultEnabled;
        const cost = effectiveGatewayModelCost(gm);
        const contextWindow = ov.contextWindow ?? gm.contextWindow;
        const merged: CatalogModel = {
          id: gm.id,
          // name / contextWindow are required by Model Access v3 and therefore never synthesized.
          name: gm.name as string,
          ...(gm.group !== undefined ? { group: gm.group } : {}),
          contextWindow: contextWindow as number,
          ...(gm.maxOutputTokens !== undefined ? { maxOutput: gm.maxOutputTokens } : {}),
          contextWindowVerified: true,
          efforts,
          defaultEffort,
          ...(ov.supportsFastMode !== undefined || gm.supportsFastMode !== undefined
            ? { supportsFastMode: ov.supportsFastMode ?? gm.supportsFastMode }
            : {}),
          ...(gm.mode !== undefined ? { mode: gm.mode } : {}),
          ...(gm.description !== undefined ? { description: gm.description } : {}),
          ...(gm.sortOrder !== undefined ? { sortOrder: gm.sortOrder } : {}),
          ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
          ...(gm.newSessionDefault !== undefined
            ? { newSessionDefault: gm.newSessionDefault }
            : {}),
          ...(gm.icon !== undefined ? { icon: gm.icon } : {}),
          ...(cost ? { cost } : {}),
          ...(gm.modalities !== undefined ? { modalities: gm.modalities } : {}),
        };
        models[agent]!.push(merged);
      }
    }
    // 每个 tab 内按 sortOrder 稳定排序(无 sortOrder 的合成条目排最后,按进入序)。
    for (const agent of agentKeys) {
      models[agent] = models[agent]!.map((model, index) => ({ model, index }))
        .sort(
          (a, b) =>
            (a.model.sortOrder ?? Number.MAX_SAFE_INTEGER) -
              (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) || a.index - b.index,
        )
        .map(({ model }) => model);
    }
    return { ...p, models };
  });

  if (providers === b.providers) return b; // 无 augment、无 custom → 原样返回
  return { ...b, providers }; // spread 保留 presets 等目录顶层字段
}

/**
 * 同步返回当前生效目录(base + 自定义供应商)。未加载完成 → base 回落 `BUNDLED_CATALOG`
 * (安全兜底,绝不抛)。消费方(路由 / 标题 / 能力派生 / 注册表)统一走这里。
 */
export function getActiveCatalog(): Catalog {
  if (!merged) merged = computeMerged();
  return merged;
}

/**
 * 返回指定 provider/agent 下模型的目录上下文窗口。
 *
 * Codex wire model 可能带有 `[1m]` 展示后缀，或被 route 的 stripPrefix
 * 包了一层；目录始终保存原始模型 id，因此查询在这里统一做去后缀/去前缀
 * 候选归一，避免各个上游 bridge 自己复制一份模型匹配逻辑。
 */
export function getCatalogModelContextWindow(
  providerId: string,
  agent: AgentKind,
  modelId: string,
  stripPrefix?: string,
): number | null {
  const candidates = new Set<string>([modelId, modelId.replace(/\[1m\]$/, '')]);
  if (stripPrefix && modelId.startsWith(stripPrefix)) {
    const stripped = modelId.slice(stripPrefix.length);
    candidates.add(stripped);
    candidates.add(stripped.replace(/\[1m\]$/, ''));
  }
  const provider = getActiveCatalog().providers.find((entry) => entry.id === providerId);
  const model = provider?.models[agent]?.find((entry) => candidates.has(entry.id));
  return model?.contextWindow ?? null;
}

/** 由 host 的目录加载器(ensureActiveCatalogLoaded)在拉取成功后写入基础目录。 */
function installActiveCatalog(
  catalog: Catalog,
  capabilityEvidence: CatalogCapabilityEvidence,
  unverifiedXdMediaKinds: readonly CatalogXdMediaKind[],
  force: boolean,
): boolean {
  const previous = base ?? BUNDLED_CATALOG;
  const nextUnverifiedXdMediaKinds = new Set(unverifiedXdMediaKinds);
  if (
    !force &&
    base !== null &&
    baseCapabilityEvidence === capabilityEvidence &&
    isDeepStrictEqual(baseUnverifiedXdMediaKinds, nextUnverifiedXdMediaKinds) &&
    isDeepStrictEqual(base, catalog)
  ) {
    return false;
  }
  const projectionRegistry =
    catalog.modelRegistry ?? previous.modelRegistry ?? trustedCustomProviderRegistry;
  trustedCustomProviderRegistry = projectionRegistry;
  base = catalog;
  baseCapabilityEvidence = capabilityEvidence;
  baseUnverifiedXdMediaKinds = nextUnverifiedXdMediaKinds;
  if (customConfigs) {
    custom = customConfigs.map((config) =>
      buildUserProvider(config, { modelRegistry: projectionRegistry }),
    );
  }
  markChanged();
  return true;
}

export function setActiveCatalog(
  catalog: Catalog,
  options: {
    capabilityEvidence?: CatalogCapabilityEvidence;
    unverifiedXdMediaKinds?: readonly CatalogXdMediaKind[];
  } = {},
): void {
  const capabilityEvidence = options.capabilityEvidence ?? 'current';
  installActiveCatalog(
    catalog,
    capabilityEvidence,
    options.unverifiedXdMediaKinds ??
      (capabilityEvidence === 'fallback' ? ['image', 'video', 'embedding'] : []),
    true,
  );
}

/**
 * Atomically install one complete source snapshot and its capability evidence. Refresh
 * callers use this instead of comparing only modelRegistry: media lists, presets and
 * explicit empty fields are part of the same catalog truth. Exact no-ops stay silent.
 */
export function commitActiveCatalogSnapshot(
  catalog: Catalog,
  options: {
    capabilityEvidence?: CatalogCapabilityEvidence;
    unverifiedXdMediaKinds?: readonly CatalogXdMediaKind[];
  } = {},
): boolean {
  const capabilityEvidence = options.capabilityEvidence ?? 'current';
  return installActiveCatalog(
    catalog,
    capabilityEvidence,
    options.unverifiedXdMediaKinds ??
      (capabilityEvidence === 'fallback' ? ['image', 'video', 'embedding'] : []),
    false,
  );
}

/**
 * **原子模型平面提交**:把一次刷新目录里的 xAI 双 root 静态清单与 modelRegistry
 * 组装成单次 base swap + 单次 markChanged。替代刷新路径串行调
 * setProviderModelsFromCatalog('xai') + setModelRegistryFromCatalog 的旧写法——
 * 那会产生两个 revision、两次 capabilities 重算/广播,且中间存在
 * 「xai 新表 + registry 旧表」的可观测混态窗口。
 * 目标不变量:成功且有变化 = 恰 1 revision / 1 broadcast;no-op/拒收 = 0。
 */
export function commitModelPlaneFromCatalog(
  catalog: Catalog,
  options: {
    capabilityEvidence?: CatalogCapabilityEvidence;
    unverifiedXdMediaKinds?: readonly CatalogXdMediaKind[];
  } = {},
): void {
  const current = base ?? BUNDLED_CATALOG;
  const incomingXai = catalog.providers.find((provider) => provider.id === 'xai');
  const providers =
    incomingXai && current.providers.some((provider) => provider.id === 'xai')
      ? current.providers.map((provider) => (provider.id === 'xai' ? incomingXai : provider))
      : current.providers;
  if (catalog.modelRegistry) trustedCustomProviderRegistry = catalog.modelRegistry;
  base = {
    ...current,
    providers,
    ...(catalog.modelRegistry ? { modelRegistry: catalog.modelRegistry } : {}),
  };
  baseCapabilityEvidence = options.capabilityEvidence ?? 'current';
  if (options.unverifiedXdMediaKinds !== undefined) {
    baseUnverifiedXdMediaKinds = new Set(options.unverifiedXdMediaKinds);
  } else if (baseCapabilityEvidence === 'fallback') {
    baseUnverifiedXdMediaKinds = new Set(['image', 'video', 'embedding']);
  }
  if (customConfigs) {
    custom = customConfigs.map((config) =>
      buildUserProvider(config, { modelRegistry: trustedCustomProviderRegistry }),
    );
  }
  markChanged();
}

/**
 * 注入用户本地目录 override 快照(model-catalog-override-store 已清洗)。
 * 调用方(createDesktopProviderService)负责变更判定,避免无谓 revision。
 */
export function setLocalCatalogOverrides(overrides: ModelCatalogOverrides): void {
  localOverrides = overrides;
  markChanged();
}

/** 当前 active-catalog 使用的已清洗本地最终层快照。 */
export function getLocalCatalogOverridesSnapshot(): ModelCatalogOverrides {
  return localOverrides;
}

/** 最近一次合并的 registry 实体化告警(单 route 隔离;刷新路径读走打日志/计数)。 */
export function getModelPlaneWarnings(): readonly ModelPlaneWarning[] {
  return lastPlanWarnings;
}

/**
 * 注入 / 刷新用户自定义供应商(CRUD 后、或换账号 DB 重开后调用)。
 * 传入的是已 `buildUserProvider` 展开的标准 `Provider[]`(**不含 API key**)。
 */
export function setCustomProviders(providers: Provider[]): void {
  customConfigs = null;
  custom = [...providers];
  markChanged();
}

/**
 * 保存当前 owner 的原始配置并按生效 Registry 展开。配置本身不改写、不持久化；目录刷新时
 * 可在同一个 revision 内重算 effort 投影。
 */
export function setCustomProviderConfigs(configs: CustomProviderConfig[]): void {
  customConfigs = [...configs];
  custom = customConfigs.map((config) =>
    buildUserProvider(config, { modelRegistry: trustedCustomProviderRegistry }),
  );
  markChanged();
}

/**
 * 注入 codex cache 派生的规范化模型快照。由 ensureActiveCatalogLoaded 在目录加载后调用。
 * 传空数组 = 有效空快照(回到静态兜底);读取失败时调用方不应调用本 setter,以保留现值。
 */
export function setDiscoveredCodexModels(models: CatalogModel[]): void {
  discoveredCodex = [...models];
  markChanged();
}

/**
 * 注入通用 OAuth 供应商的发现模型(per provider × agent)。additions-only 合并见
 * computeMerged;传空数组 = 清空该 provider×agent 的 discovery(回纯静态)。
 */
export function setDiscoveredProviderModels(
  providerId: string,
  agent: AgentKind,
  models: CatalogModel[],
): void {
  const byAgent = discoveredByProvider.get(providerId) ?? {};
  byAgent[agent] = [...models];
  discoveredByProvider.set(providerId, byAgent);
  markChanged();
}

/** 成功空数组同样是权威成员快照；null 仅表示当前 owner 尚无成功快照。 */
export function setXaiDiscoveredModels(models: readonly XaiDiscoveredModel[] | null): void {
  xaiDiscoveredModels = models === null ? null : models.map((model) => ({ ...model }));
  markChanged();
}

/**
 * 原子注入供应商图片／视频发现快照。成功快照决定存在性，同 id 静态元数据优先；
 * 传 null 清空该供应商账号态快照，回到当前
 * 静态／远端目录；失败路径不应调用，以保留同账号上次成功结果。
 */
export function setDiscoveredProviderMediaModels(
  providerId: string,
  snapshot: {
    imageModels?: NonNullable<Provider['imageModels']>;
    videoModels?: NonNullable<Provider['videoModels']>;
  } | null,
): void {
  if (snapshot === null) discoveredMediaByProvider.delete(providerId);
  else {
    const previous = discoveredMediaByProvider.get(providerId) ?? {};
    discoveredMediaByProvider.set(providerId, {
      ...previous,
      ...(snapshot.imageModels ? { imageModels: [...snapshot.imageModels] } : {}),
      ...(snapshot.videoModels ? { videoModels: [...snapshot.videoModels] } : {}),
    });
  }
  markChanged();
}

/**
 * 注入 XD 网关权威模型清单(model-access 拉取流程写入,重建逻辑见 computeMerged)。
 * 传空数组 = 实时清单不可用,此时 XD 供应商保留但不暴露任何模型。
 */
export function setXdGatewayModels(models: XdGatewayModelInfo[]): void {
  xdGatewayModels = [...models];
  xdCodexAnthropicBridgeModelIds = deriveXdCodexAnthropicBridgeModelIds(models);
  markChanged();
}

/** 同步读取最近一次完整 `/models` 快照，供 sendSync 配置面只读投影。 */
export function getXdGatewayModels(): readonly XdGatewayModelInfo[] {
  return xdGatewayModels;
}

/** 返回当前 active catalog 的单调递增修订号。 */
export function getActiveCatalogRevision(): number {
  return revision;
}

/**
 * 注册唯一的目录变更收口。监听器必须同步且不可抛错：setter 返回前 capabilities
 * 已与 active catalog 对齐，随后才允许 renderer 收到对应 revision 的广播。
 */
export function setActiveCatalogChangedListener(
  listener: ((nextRevision: number) => void) | null,
): void {
  changedListener = listener;
}

/**
 * 注入 Anthropic 权威模型清单(model-discovery/anthropic 发现流程写入)。
 * 传空数组 = 未登录 / 发现不可用,anthropic 供应商保留但不暴露任何模型。
 */
export function setAnthropicDiscoveredModels(models: CatalogModel[]): void {
  anthropicModels = [...models];
  markChanged();
}
