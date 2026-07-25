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
 * 不区分内置 / 自定义,统一消费。custom 追加在后:`deriveAvailableModels` first-wins 去重
 * 保证与内置同名 id 时内置元数据胜出,不冲突。
 *
 * 所有消费方统一读 `getActiveCatalog()`,而非各自 import `BUNDLED_CATALOG`:
 *   - maker availableModels 派生(maker-host/index.ts)
 *   - 统一路由器(provider-route.ts)
 *   - 会话标题模型(title-one-shot.ts)
 *   - 供应商注册表(provider-service.ts,经 createDesktopProviderService 注入)
 *
 * 「启动 await 一次、之后全同步读」是关键:`getActiveCatalog()` 同步返回,消费方(含路由
 * 热路径)零额外 async / 零额外网络往返。合并结果惰性缓存(base / custom 变更时失效,
 * 下次读时重算),热路径零额外分配。本模块刻意**不依赖 Electron**——electron net/fs 落地在
 * createDesktopProviderService.ts,这样依赖本 holder 的纯逻辑模块(及其单测)不被 electron 污染。
 */

import { BUNDLED_CATALOG, type AgentKind, type Catalog, type CatalogModel, type Provider } from '@cindy/model-providers';

import { CHATGPT_MODEL_PREFIX } from '../../shared/subscriptionModels.js';

/** OSS / bundled 加载来的基础目录;null = 尚未加载(回落 BUNDLED_CATALOG)。 */
let base: Catalog | null = null;
/** 用户自定义供应商(已 buildUserProvider 展开的标准 Provider),追加在 base 之后。 */
let custom: Provider[] = [];
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
/** 单 tab 能力覆盖块(shared/modelAccess ModelAccessAgentOverride 同形)。 */
export interface XdGatewayAgentOverride {
  contextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  supportsFastMode?: boolean;
  defaultEnabled?: boolean;
}

/** 服务端下发的 XD 网关聊天模型条目(shared/modelAccess ModelAccessGatewayModel 同形)。 */
export interface XdGatewayModelInfo {
  id: string;
  /** 进哪些 runtime tab;缺省 = 仅 claude-code 兜底。 */
  agents?: AgentKind[];
  name?: string;
  group?: string;
  description?: string;
  contextWindow?: number;
  efforts?: string[];
  defaultEffort?: string | null;
  sortOrder?: number;
  /** Fast 支持;缺省按 true(未登记模型的确定性默认:开了没效果无害)。 */
  supportsFastMode?: boolean;
  /** 默认可见性;缺省按 true。 */
  defaultEnabled?: boolean;
  /** 展示图标 id(AI Gateway 设定;缺省 / 未知值渲染层回落来源供应商标)。 */
  icon?: string;
  /** per-tab 能力覆盖。 */
  perAgent?: Partial<Record<AgentKind, XdGatewayAgentOverride>>;
}

/**
 * XD 网关(内置 xd 供应商)的**权威模型清单**(model-access-server GET /models:
 * AIGateway /model-groups 投影 + 服务端内置常量表富化;2026-07-17 定案:XD 模型
 * 列表完全以网关为准,不再由 OSS 产品目录决定)。未登录 / 拉取失败 / 空响应时
 * 保持空数组,绝不把产品目录里的静态模型冒充成网关实时可用模型。有值时 xd
 * 供应商的模型列表整体重建,每个条目:
 *  - tab 归属:服务端 `agents` > 目录同 id 条目的归属 > 仅 claude-code 兜底
 *    (网关 /v1/messages 跨供应商翻译覆盖面最广;Responses 协议不猜);
 *  - 展示元数据逐字段:服务端条目 > 目录同 id 条目 > 合成默认(id 当展示名,
 *    口径同自定义 OAuth 模型发现,见 maker-ipc/register.ts oauthLogin);
 *  - 目录里有、网关没有 → 不展示。
 */
let xdGatewayModels: XdGatewayModelInfo[] = [];

/**
 * Anthropic(Claude.ai 订阅)的**权威模型清单**(2026-07-19 统一重构):由 host 的
 * anthropic 发现流程注入(登录时 HTTP `/v1/models` + 会话 init 时 SDK supportedModels
 * 捕获,见 maker-host/model-discovery/anthropic.ts)。未登录 / 未发现时保持空数组,
 * anthropic 供应商不暴露任何模型——绝不用静态目录冒充。
 */
let anthropicModels: CatalogModel[] = [];

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
/** base + custom + discovered augment 的合并缓存;null = 待重算(惰性)。 */
let merged: Catalog | null = null;
/** bundled + active v1 `cindyModelMeta` 的合并索引；目录变化时与 merged 一起失效。 */
let effectiveCindyModelMetaIndex: Map<string, CindyModelMetaFields> | null = null;

/**
 * 目录修订号。所有会改变 getActiveCatalog() 结果的写入都必须经过 markChanged，
 * 让 main 能先同步刷新 Maker capabilities，再向 renderer 广播同一代目录。
 */
let revision = 0;

/** Electron 相关副作用由 desktop host 注入，本模块继续保持纯状态容器。 */
let changedListener: ((nextRevision: number) => void) | null = null;

function markChanged(): void {
  merged = null;
  effectiveCindyModelMetaIndex = null;
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
              (b.model.sortOrder ?? Number.MAX_SAFE_INTEGER) ||
            a.index - b.index,
        )
        .map(({ model }) => model)
    : combined;
  return { ...p, models: { ...p.models, [agent]: models } };
}

/**
 * bridge tab 默认收起的原始 slug(旧产品目录 chatgpt/* 条目 defaultEnabled:false 的
 * 延续):cc tab 上 ChatGPT 订阅直连只默认露出旗舰,legacy 模型收起——与 codex tab
 * 的可见性策略(见 codex-model-discovery DEFAULT_HIDDEN_SLUGS)按 tab 各自维护。
 */
const BRIDGE_DEFAULT_HIDDEN_SLUGS: ReadonlySet<string> = new Set(['gpt-5.4', 'gpt-5.4-mini']);

/**
 * Claude bridge(anthropic-responses)对这些 GPT 模型的推理档封顶 xhigh —— max/ultra
 * 会被 bridge 降级(见 anthropic-responses-bridge normalizeReasoningEffort)。投影到
 * claude-code tab 时剔除 max/ultra,避免暴露实际不被 honored 的档(issue #352)。
 */
const CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS: ReadonlySet<Effort> = new Set(['max', 'ultra']);

/** Codex 规范模型 → Claude bridge 路由模型；显示元数据保持一致，只改路由 id + effort 封顶。 */
function toChatgptBridgeModel(model: CatalogModel): CatalogModel {
  const bridgeEfforts = model.efforts.filter((e) => !CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS.has(e));
  const cappedDefault: Effort | null =
    model.defaultEffort && CLAUDE_BRIDGE_UNSUPPORTED_EFFORTS.has(model.defaultEffort)
      ? bridgeEfforts.includes('xhigh')
        ? 'xhigh'
        : bridgeEfforts[bridgeEfforts.length - 1] ?? null
      : model.defaultEffort;
  return {
    ...model,
    id: `${CHATGPT_MODEL_PREFIX}${model.id}`,
    // 仅当模型确有 max/ultra 时才改写 efforts/defaultEffort,其余模型逐字节不变。
    ...(bridgeEfforts.length !== model.efforts.length
      ? { efforts: bridgeEfforts, defaultEffort: cappedDefault }
      : {}),
    ...(BRIDGE_DEFAULT_HIDDEN_SLUGS.has(model.id) ? { defaultEnabled: false } : {}),
  };
}

/**
 * 以生效 Codex 列表校正 bridge 的展示名称 / 排序，同时保留 bridge 自己的 context、effort、
 * defaultEnabled 等 runtime 能力。这样旧远端目录里曾固化的本地化后缀也不会继续泄漏。
 */
function projectCodexModelsToClaude(p: Provider): Provider {
  const codex = p.models.codex ?? [];
  const canonical = new Map(codex.map((model) => [model.id, model]));
  const existing = p.models['claude-code'] ?? [];
  let aligned = false;
  const alignedExisting = existing.map((model) => {
    if (!model.id.startsWith(CHATGPT_MODEL_PREFIX)) return model;
    const source = canonical.get(model.id.slice(CHATGPT_MODEL_PREFIX.length));
    if (!source || (model.name === source.name && model.sortOrder === source.sortOrder)) return model;
    aligned = true;
    return { ...model, name: source.name, sortOrder: source.sortOrder };
  });
  const withAligned = aligned
    ? { ...p, models: { ...p.models, 'claude-code': alignedExisting } }
    : p;
  return augmentModels(withAligned, 'claude-code', codex.map(toChatgptBridgeModel), true);
}

/** 清单来源唯一化的动态供应商:目录(bundled/远端)里的静态模型一律忽略,清单只来自运行时注入。 */
const DYNAMIC_LIST_PROVIDER_IDS: ReadonlySet<string> = new Set(['anthropic', 'openai', 'xd']);

/**
 * cindyModelMeta 里客户端认识的字段子集。展示字段直接覆盖发现条目；context / effort
 * 字段只在 Anthropic 动态通道**没有能力信息**时作为基线，由
 * model-discovery/anthropic 消费。上游显式能力始终优先，meta 不在 active catalog
 * overlay 阶段改写能力。
 */
interface CindyModelMetaFields {
  name?: string;
  group?: string;
  description?: string;
  sortOrder?: number;
  defaultEnabled?: boolean;
  contextWindow?: number;
  efforts?: Effort[];
  defaultEffort?: Effort | null;
}

/**
 * 解析目录顶层 `cindyModelMeta`(`{ version: 1, models: { id: {...} } }` 信封)为
 * 展示字段索引。schema 归服务端所有,客户端只读认识的字段、逐字段校验类型;
 * **版本门禁**:version !== 1 整段忽略(未来服务端升 schema 时老客户端安全降级,
 * 不按旧语义误读新数据)。坏信封 / 坏条目静默跳过,绝不让元数据把清单弄坏。
 */
function buildCindyModelMetaIndex(meta: unknown): Map<string, CindyModelMetaFields> {
  const index = new Map<string, CindyModelMetaFields>();
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return index;
  const envelope = meta as { version?: unknown; models?: unknown };
  if (envelope.version !== 1) return index;
  const models = envelope.models;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return index;
  for (const [id, entry] of Object.entries(models as Record<string, unknown>)) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    const e = entry as Record<string, unknown>;
    const fields: CindyModelMetaFields = {};
    if (typeof e.name === 'string' && e.name.length > 0) fields.name = e.name;
    if (typeof e.group === 'string' && e.group.length > 0) fields.group = e.group;
    if (typeof e.description === 'string' && e.description.length > 0) fields.description = e.description;
    if (typeof e.sortOrder === 'number' && Number.isFinite(e.sortOrder)) fields.sortOrder = e.sortOrder;
    if (typeof e.defaultEnabled === 'boolean') fields.defaultEnabled = e.defaultEnabled;
    if (typeof e.contextWindow === 'number' && Number.isFinite(e.contextWindow) && e.contextWindow > 0) {
      fields.contextWindow = e.contextWindow;
    }
    if (Array.isArray(e.efforts)) {
      const efforts = e.efforts.filter((value): value is Effort =>
        typeof value === 'string' && VALID_EFFORTS.has(value));
      if (efforts.length === e.efforts.length) fields.efforts = efforts;
    }
    if (e.defaultEffort === null) fields.defaultEffort = null;
    else if (typeof e.defaultEffort === 'string' && VALID_EFFORTS.has(e.defaultEffort)) {
      fields.defaultEffort = e.defaultEffort as Effort;
    }
    if (Object.keys(fields).length > 0) index.set(id, fields);
  }
  return index;
}

/**
 * 远端 v1 元数据允许按模型、按字段增量覆盖 bundled v1。旧远端目录经常只带
 * 部分新字段或缺少新模型；缺口必须回落 bundled，否则已知 200k 模型会落入
 * 1M 启发式。非 v1 active 信封仍整段忽略，不能拿 bundled v1 混入未知 schema。
 */
function buildEffectiveCindyModelMetaIndex(): Map<string, CindyModelMetaFields> {
  if (effectiveCindyModelMetaIndex) return effectiveCindyModelMetaIndex;

  const bundled = buildCindyModelMetaIndex(BUNDLED_CATALOG.cindyModelMeta);
  if (!base || base.cindyModelMeta === undefined) {
    effectiveCindyModelMetaIndex = bundled;
    return effectiveCindyModelMetaIndex;
  }

  const activeMeta = base.cindyModelMeta;
  if (
    !activeMeta ||
    typeof activeMeta !== 'object' ||
    Array.isArray(activeMeta) ||
    (activeMeta as { version?: unknown }).version !== 1
  ) {
    effectiveCindyModelMetaIndex = new Map();
    return effectiveCindyModelMetaIndex;
  }

  const effective = new Map<string, CindyModelMetaFields>();
  for (const [id, fields] of bundled) effective.set(id, { ...fields });
  for (const [id, fields] of buildCindyModelMetaIndex(activeMeta)) {
    effective.set(id, { ...effective.get(id), ...fields });
  }
  effectiveCindyModelMetaIndex = effective;
  return effectiveCindyModelMetaIndex;
}

export interface CindyModelEffortBaseline {
  efforts: Effort[];
  defaultEffort: Effort | null;
}

/** 返回当前目录的已知上下文窗口；只供动态发现缺少上游明确值时兜底。 */
export function getCindyModelContextWindow(modelId: string): number | null {
  return buildEffectiveCindyModelMetaIndex().get(modelId)?.contextWindow ?? null;
}

/**
 * 返回当前目录的模型 effort 基线。只供动态发现缺少 capability 字段时兜底；
 * 模型是否存在仍完全由 HTTP / SDK 动态清单决定。
 */
export function getCindyModelEffortBaseline(modelId: string): CindyModelEffortBaseline | null {
  const fields = buildEffectiveCindyModelMetaIndex().get(modelId);
  if (!fields?.efforts) return null;
  const efforts = [...fields.efforts];
  const defaultEffort =
    fields.defaultEffort !== undefined &&
    (fields.defaultEffort === null || efforts.includes(fields.defaultEffort))
      ? fields.defaultEffort
      : efforts.includes('high')
        ? 'high'
        : efforts[efforts.length - 1] ?? null;
  return { efforts, defaultEffort };
}

/**
 * 把元数据基线的展示字段覆盖到发现条目上(基线在场即胜出;不在场保留上游值)。
 * 典型修正:订阅 `/v1/models` / SDK 捕获给的家族级名字("Fable")→ 产品命名
 * ("Fable 5");上游无排序 → 产品排序。
 */
function overlayCindyMeta(model: CatalogModel, fields: CindyModelMetaFields | undefined): CatalogModel {
  if (!fields) return model;
  return {
    ...model,
    ...(fields.name !== undefined ? { name: fields.name } : {}),
    ...(fields.group !== undefined ? { group: fields.group } : {}),
    ...(fields.description !== undefined ? { description: fields.description } : {}),
    ...(fields.sortOrder !== undefined ? { sortOrder: fields.sortOrder } : {}),
    ...(fields.defaultEnabled !== undefined ? { defaultEnabled: fields.defaultEnabled } : {}),
  };
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

/** 把 provider 的全部 per-agent 模型清单清零(保留身份卡);已为空则原样返回。 */
function withEmptyModels(p: Provider): Provider {
  const entries = Object.entries(p.models) as [AgentKind, CatalogModel[]][];
  if (entries.every(([, list]) => list.length === 0)) return p;
  const models: Provider['models'] = {};
  for (const [agent] of entries) models[agent] = [];
  return { ...p, models };
}

function computeMerged(): Catalog {
  const b = base ?? BUNDLED_CATALOG;
  let providers = b.providers;

  // 动态清单供应商先清零静态模型(2026-07-19 统一重构):无论目录来自 bundled 还是
  // 远端(含仍带静态段的旧版 v1 OSS 文件),这三家的清单**只信运行时注入**——
  // 否则过渡期旧 OSS 文件会让静态清单复活,违反「无可用性证明不展示」。
  const normalized = providers.map((p) => (DYNAMIC_LIST_PROVIDER_IDS.has(p.id) ? withEmptyModels(p) : p));
  if (normalized.some((p, index) => p !== providers[index])) providers = normalized;

  // 同一份规范快照先进入 Codex,再从「静态 first-wins 后的生效 Codex 列表」投影 bridge。
  // 即使 cache 不可用,静态 Codex 新模型也会自动出现在 Claude tab,不会再维护两份名单。
  const withCodexProjection = providers.map((p) => {
    if (p.id !== 'openai') return p;
    const withDiscovered = augmentModels(p, 'codex', discoveredCodex, true);
    return projectCodexModelsToClaude(withDiscovered);
  });
  if (withCodexProjection.some((p, index) => p !== providers[index])) {
    providers = withCodexProjection;
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
  // Anthropic 权威模型清单重建(2026-07-19 统一重构):清单唯一来源是 SDK / 登录时
  // HTTP 发现(host 经 setAnthropicDiscoveredModels 注入),目录静态段已退役(bundled
  // 恒为空数组)。空 = 未发现,anthropic 供应商保留但不暴露任何模型,不用静态数据冒充。
  // 展示元数据(名字/分组/排序/默认可见)以目录 cindyModelMeta 为基线覆盖(2026-07-21
  // 三层合并:存在性=发现,展示=产品目录,用户 override 永远最高)——订阅通道返回的
  // 家族级名字("Fable")在此归位为产品命名("Fable 5");能力字段仍以发现为准。
  if (anthropicModels.length > 0) {
    const metaIndex = buildEffectiveCindyModelMetaIndex();
    const overlaid = sortModelsByOrder(
      anthropicModels.map((m) => overlayCindyMeta(m, metaIndex.get(m.id))),
    );
    providers = providers.map((p) =>
      p.id === 'anthropic'
        ? { ...p, models: { ...p.models, 'claude-code': overlaid } }
        : p,
    );
  }

  // XD 网关权威模型清单重建。即使实时清单为空也必须重建为空:不能证明某个模型
  // 当前在网关可用就不显示。元数据**只信服务端下发 + 确定性默认值**(2026-07-19 起
  // 不再回落产品目录条目——服务端 MODEL_METADATA 已是唯一权威):
  //   - perAgent 覆盖块按 tab 应用在基线字段之上;
  //   - efforts 字段缺失 = 未登记 → 合成 3 档(low/medium/high,默认 high);
  //     显式 [] = 登记为不可调 → 尊重为空;
  //   - supportsFastMode 缺失 → true(开了没效果无害,但不能没有);
  //   - defaultEnabled 缺失 → 默认可见。
  // 放在所有 augment 之后:只影响 xd 供应商自己的模型列表,同 id 模型经其它供应商
  // (如 anthropic 订阅直连)仍照常可用。
  const gwModels = xdGatewayModels;
  providers = providers.map((p) => {
    if (p.id !== 'xd') return p;
    const agentKeys = Object.keys(p.models) as AgentKind[];

    const models: Provider['models'] = {};
    for (const agent of agentKeys) models[agent] = [];
    for (const gm of gwModels) {
      // tab 归属:服务端 agents > 仅 claude-code(网关 /v1/messages 翻译覆盖面最广,不猜)
      const targetAgents: AgentKind[] = gm.agents && gm.agents.length > 0 ? gm.agents : ['claude-code'];
      for (const agent of targetAgents) {
        if (!models[agent]) continue; // 未知 agent 键防御(wire 数据)
        const ov = gm.perAgent?.[agent] ?? {};
        // efforts:override > 基线;字段"存在"与"空数组"语义不同(缺失=未登记→3档,[]=不可调)
        const rawEfforts = ov.efforts ?? gm.efforts;
        const efforts: Effort[] =
          rawEfforts === undefined
            ? ['low', 'medium', 'high']
            : rawEfforts.filter((e): e is Effort => VALID_EFFORTS.has(e));
        const rawDefault =
          ov.defaultEffort !== undefined ? ov.defaultEffort : gm.defaultEffort;
        const defaultEffort: Effort | null =
          rawDefault && VALID_EFFORTS.has(rawDefault) && efforts.includes(rawDefault as Effort)
            ? (rawDefault as Effort)
            : efforts.includes('high')
              ? 'high'
              : efforts.length > 0
                ? efforts[efforts.length - 1]
                : null;
        const defaultEnabled = ov.defaultEnabled ?? gm.defaultEnabled;
        const merged: CatalogModel = {
          id: gm.id,
          name: gm.name ?? gm.id,
          group: gm.group ?? 'custom:xd',
          contextWindow: ov.contextWindow ?? gm.contextWindow ?? 200_000,
          efforts,
          defaultEffort,
          supportsFastMode: ov.supportsFastMode ?? gm.supportsFastMode ?? true,
          ...(gm.description !== undefined ? { description: gm.description } : {}),
          ...(gm.sortOrder !== undefined ? { sortOrder: gm.sortOrder } : {}),
          ...(defaultEnabled !== undefined ? { defaultEnabled } : {}),
          ...(gm.icon !== undefined ? { icon: gm.icon } : {}),
        };
        models[agent]!.push(merged);
      }
    }
    // 每个 tab 内按 sortOrder 稳定排序(无 sortOrder 的合成条目排最后,按进入序)。
    for (const agent of agentKeys) {
      models[agent] = models[agent]!
        .map((model, index) => ({ model, index }))
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

/** 由 host 的目录加载器(ensureActiveCatalogLoaded)在拉取成功后写入基础目录。 */
export function setActiveCatalog(catalog: Catalog): void {
  base = catalog;
  markChanged();
}

/**
 * 注入 / 刷新用户自定义供应商(CRUD 后、或换账号 DB 重开后调用)。
 * 传入的是已 `buildUserProvider` 展开的标准 `Provider[]`(**不含 API key**)。
 */
export function setCustomProviders(providers: Provider[]): void {
  custom = [...providers];
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

/**
 * 注入 XD 网关权威模型清单(model-access 拉取流程写入,重建逻辑见 computeMerged)。
 * 传空数组 = 实时清单不可用,此时 XD 供应商保留但不暴露任何模型。
 */
export function setXdGatewayModels(models: XdGatewayModelInfo[]): void {
  xdGatewayModels = [...models];
  markChanged();
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
