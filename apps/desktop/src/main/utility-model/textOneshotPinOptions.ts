/**
 * textOneshotPinOptions.ts — 快问快答(text.oneshot)钉档的目录模型清单与路由解析。
 *
 * 背景(2026-08-05 与刘佳黎定稿):钉档可选项从 9 个轻量档位扩展为**当前供应商
 * 目录里的全部文本模型**——用户安装插件即承担其成本,主机在安装/详情页如实
 * 展示可选面,不再用一份小清单替用户做成本决定。
 *
 * 钉值两种形态(消费方都要认):
 * - 轻量档位键(如 'litellm-kimi-k2.6',见 utilityModelProfiles):随系统链演进
 *   的逻辑档位,覆盖表里的既有形态;
 * - 目录钉(本文件 'cat:' 编码):精确钉死一组 供应商×agent×模型。
 *
 * 插件还可在身份卡 `cindy.oneshotModel` 声明**偏好**模型 id(目录模型,如
 * 'codex/gpt-5.5'):解析优先级 = 用户钉档 > 插件声明 > 系统默认链。声明只表达
 * 意图——目录没有 / 已停用 / 不可路由时按未声明处理,绝不构成硬依赖。
 *
 * 纯逻辑、零 Electron:被 cindySlot(类型)与 IPC 接线共用,单测直测。
 */

import {
  classifyModel,
  isModelSelectableForNewRoute,
  isModelDisabled,
  isProviderDisabled,
  type AgentKind,
  type Catalog,
  type CatalogModel,
  type ModelDisableOverrides,
  type Provider,
} from '@cindy/model-providers';

import { applyProviderOrder } from '../../shared/providerOrder.js';
import {
  decodeCatalogModelPin,
  encodeCatalogModelPin,
} from '../../shared/catalogModelPin.js';

/** oneshot 可路由的 agent(Pi 的 oneShot 未实现,不进钉档清单)。 */
const ONESHOT_ROUTE_AGENTS = ['codex', 'claude-code'] as const;

/**
 * 执行侧(requestBuiltinProviderText)硬编码认的四家内置供应商。清单侧必须
 * 按同一集合过滤——否则将来新增第五个聊天型内置供应商(如 gemini 配上
 * agent)时,清单会列出执行侧 fallthrough agent_unavailable 的模型,"可见但
 * 不可执行"。两边任一处变动都要同步另一处。
 */
const ONESHOT_EXECUTABLE_BUILTIN_PROVIDERS = new Set(['xd', 'anthropic', 'openai', 'xai']);

/** 一次快问快答的路由:用户钉档或插件声明解析出的终态。 */
export type OneshotRoute =
  | { kind: 'utility-profile'; profileId: string }
  | { kind: 'catalog'; providerId: string; agentKind: AgentKind; model: string };

/** 目录钉编码:cat:<providerId>:<agentKind>:<modelId>(modelId 可含 '/' 与 ':')。 */
export function encodeCatalogPin(providerId: string, agentKind: AgentKind, model: string): string {
  if (agentKind !== 'codex' && agentKind !== 'claude-code') {
    throw new Error(`unsupported catalog pin agent: ${agentKind}`);
  }
  return encodeCatalogModelPin({ providerId, agentKind, model });
}

/** 解码目录钉;不是目录钉(或形态残缺/agent 不可路由)返回 null。 */
export function decodeCatalogPin(
  raw: string,
): { providerId: string; agentKind: AgentKind; model: string } | null {
  return decodeCatalogModelPin(raw);
}

/**
 * 该 (provider, agent) 组合对 oneshot 是否结构可路由——镜像
 * requestUtilityText 显式路径的静态闸:内置供应商只收执行侧硬编码认的
 * 四家(见 ONESHOT_EXECUTABLE_BUILTIN_PROVIDERS);自定义供应商要求 routing
 * 未禁用 + 鉴权策略受支持 + 有上游地址 + 声明的 wire 与执行侧该 agent 的
 * 实际出线一致(claude-code 恒发 anthropic-messages;codex 发不出
 * anthropic-messages,会被静默当 responses——配置错线的组合钉上恒失败,
 * 不进清单)。
 */
function isRoutableForOneshot(provider: Provider, agentKind: AgentKind): boolean {
  if (!provider.agents.includes(agentKind)) return false;
  const routing = provider.routing[agentKind];
  if (!routing || routing.disabled) return false;
  if (provider.source === 'builtin') return ONESHOT_EXECUTABLE_BUILTIN_PROVIDERS.has(provider.id);
  if (agentKind === 'claude-code') {
    if (routing.wireProtocol !== undefined && routing.wireProtocol !== 'anthropic-messages') return false;
  } else if (routing.wireProtocol === 'anthropic-messages') return false;
  return (
    (routing.authStrategy === 'api-key-header'
      || routing.authStrategy === 'oauth-token'
      || routing.authStrategy === 'none')
    && typeof routing.upstream === 'string'
    && routing.upstream.length > 0
  );
}

/** 只收对话模型:与新建对话/开协同的模型清单同一判据(classification 的
 *  isAgentSelectableModel——mode 权威,缺省时要 group/厂商前缀佐证;自建一份
 *  更宽的判据会把 mode 缺省、group='image' 的网关条目放进钉档清单,钉死
 *  不回落 = 恒失败)。userProvider 标记镜像模型选择器的自定义供应商放行。 */
function isChatModel(model: CatalogModel, provider: Provider): boolean {
  return isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' });
}

const AGENT_LABEL: Record<(typeof ONESHOT_ROUTE_AGENTS)[number], string> = {
  codex: 'Codex',
  'claude-code': 'Claude Code',
};

/**
 * 下发 renderer 的 routing 先剥 headerOverride:旧版 header-only 配置的自定义
 * 供应商把明文 API key 写在里面,而「运行期鉴权头不下发任何 Renderer」是仓库
 * 既定不变量(与 providerHandlers.withoutProviderHeaderCredentials 同款)。
 * 渲染层判厂牌图标只用 upstream 等结构字段。
 */
function routingForRenderer(routing: Provider['routing']): Provider['routing'] {
  return Object.fromEntries(
    Object.entries(routing).map(([agent, descriptor]) => {
      if (!descriptor) return [agent, descriptor];
      const { headerOverride: _secretHeaders, ...safeDescriptor } = descriptor;
      return [agent, safeDescriptor];
    }),
  ) as Provider['routing'];
}

export interface TextOneshotPinOption {
  /** 钉值(cat: 编码)。 */
  id: string;
  /** 兜底行文案:`<Agent> · <模型名> · <供应商名>`。 */
  label: string;
  /** 分组(供应商显示名)。 */
  group: string;
  providerId: string;
  agentKind: AgentKind;
  modelId: string;
  /** 模型展示名(CatalogModel.name)。 */
  modelName: string;
  /** 模型选择器的目录默认可见性；缺省 = 可见。 */
  defaultEnabled?: boolean;
  /** 模型展示图标 id(CatalogModel.icon;未设定时渲染层回落供应商标)。 */
  icon?: string;
  /** 折扣路由条目(classifyModel = gpt-budget)——渲染层据此亮「折扣」徽标。 */
  budget: boolean;
  /** 订阅制供应商条目——渲染层亮「订阅」徽标。 */
  subscription: boolean;
  /** 供应商路由描述(渲染层厂牌图标判定用,ProviderLogoMark)。 */
  routing?: Provider['routing'];
  /** 该精确路由使用的 Agent('Codex' / 'Claude Code')。 */
  agentSuffix: string;
}

/**
 * 快问快答的系统默认链家在 XD 网关:用户没有显式供应商排序时,钉档清单让
 * xd 在首(其余按目录序);有显式排序(设置页拖拽的那一份)则全听用户的。
 * 注意:缺省 bias 是本清单刻意的产品选择,新建对话选择器无此 bias(空排序
 * 纯按目录序)——两个入口只在用户有显式排序时严格同序。
 */
function orderedProviders(catalog: Catalog, providerOrder: readonly string[] | undefined): Provider[] {
  return applyProviderOrder(
    catalog.providers,
    providerOrder && providerOrder.length > 0 ? providerOrder : ['xd'],
  );
}

/** 供应商内模型按 sortOrder 升序(缺省排末尾,稳定)——与模型选择器的展示序同口径。 */
function displayOrderedModels(models: readonly CatalogModel[]): CatalogModel[] {
  return [...models].sort(
    (a, b) => (a.sortOrder ?? Number.POSITIVE_INFINITY) - (b.sortOrder ?? Number.POSITIVE_INFINITY),
  );
}

/**
 * 凭证探测(可选):传入时只收当下有可用凭证的 (供应商 × agent)——没配
 * key / 没登录的供应商钉上也只会在执行期 NO_CANDIDATE,不给了没用的选项。
 * 展示层过滤,不是安全边界(执行侧仍逐候选现查)。
 */
export type OneshotCredentialProbe = (provider: Provider, agentKind: AgentKind) => boolean;

/**
 * 目录全量文本模型钉档清单:遍历 供应商 × 可路由 agent × 对话模型,滤掉停用
 * 轴(供应商级与逐模型)与不可路由组合。供应商序 = 用户显式排序(缺省 xd 在
 * 首),供应商内模型按 sortOrder。
 */
export function buildTextOneshotPinOptions(
  catalog: Catalog,
  overrides: ModelDisableOverrides | undefined,
  providerOrder?: readonly string[],
  hasCredential?: OneshotCredentialProbe,
): TextOneshotPinOption[] {
  const entries: { provider: Provider; agentKind: (typeof ONESHOT_ROUTE_AGENTS)[number]; model: CatalogModel }[] = [];
  const seenRoutes = new Set<string>();
  for (const provider of orderedProviders(catalog, providerOrder)) {
    if (isProviderDisabled(overrides, provider.id)) continue;
    // Agent 决定模型可见性和实际 wire。即使内置供应商的两条路由最终共享
    // 凭证或上游，也分别展示并保存，让用户选择一组确定的 Agent + Model。
    for (const agentKind of ONESHOT_ROUTE_AGENTS) {
      if (!isRoutableForOneshot(provider, agentKind)) continue;
      if (hasCredential && !hasCredential(provider, agentKind)) continue;
      for (const model of displayOrderedModels(provider.models[agentKind] ?? [])) {
        if (!isChatModel(model, provider)) continue;
        if (isModelDisabled(overrides, provider.id, model.id)) continue;
        const routeKey = `${provider.id}\n${agentKind}\n${model.id}`;
        if (seenRoutes.has(routeKey)) continue;
        seenRoutes.add(routeKey);
        entries.push({ provider, agentKind, model });
      }
    }
  }
  return entries.map((e) => {
    const base = `${e.model.name} · ${e.provider.name}`;
    return {
      id: encodeCatalogPin(e.provider.id, e.agentKind, e.model.id),
      label: `${AGENT_LABEL[e.agentKind]} · ${base}`,
      group: e.provider.name,
      providerId: e.provider.id,
      agentKind: e.agentKind,
      modelId: e.model.id,
      modelName: e.model.name,
      ...(e.model.defaultEnabled !== undefined ? { defaultEnabled: e.model.defaultEnabled } : {}),
      ...(e.model.icon !== undefined ? { icon: e.model.icon } : {}),
      budget: classifyModel(e.model) === 'gpt-budget',
      subscription: e.provider.access?.kind === 'subscription',
      ...(e.provider.routing !== undefined ? { routing: routingForRenderer(e.provider.routing) } : {}),
      agentSuffix: AGENT_LABEL[e.agentKind],
    };
  });
}

/**
 * 插件声明的偏好模型 id → 可路由的目录条目。供应商序同钉档清单(用户显式
 * 排序优先,缺省 xd 在首),agent 序 codex 先于 claude-code(与
 * inferProviderAgent 同偏好);停用/不可路由/非对话模型跳过。
 * 找不到返回 null = 按未声明处理(回落系统默认链)。
 */
export function resolveOneshotCatalogModel(
  catalog: Catalog,
  overrides: ModelDisableOverrides | undefined,
  modelId: string,
  providerOrder?: readonly string[],
  hasCredential?: OneshotCredentialProbe,
): { providerId: string; agentKind: AgentKind; model: string } | null {
  const wanted = modelId.trim();
  if (!wanted) return null;
  for (const provider of orderedProviders(catalog, providerOrder)) {
    if (isProviderDisabled(overrides, provider.id)) continue;
    for (const agentKind of ONESHOT_ROUTE_AGENTS) {
      if (!isRoutableForOneshot(provider, agentKind)) continue;
      if (hasCredential && !hasCredential(provider, agentKind)) continue;
      const hit = (provider.models[agentKind] ?? []).find(
        (m) => m.id === wanted && isChatModel(m, provider) && !isModelDisabled(overrides, provider.id, m.id),
      );
      if (hit) return { providerId: provider.id, agentKind, model: hit.id };
    }
  }
  return null;
}
