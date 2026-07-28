/**
 * 用户自定义供应商：把 `CustomProviderConfig` 展开成标准 `Provider`（纯逻辑，零依赖）。
 *
 * 设计要点：
 *   - 产出的 `Provider` 与内置厂商（providers.json）**同形状**，进同一 active-catalog，
 *     下游（路由 / 选择器 / listProviders）不区分内置 / 自定义，统一消费。
 *   - `source: 'user'`，鉴权可为 API key / OAuth / none。
 *   - 每个用户选中的 agent 生成一份与鉴权形态匹配的路由（upstream = baseUrl，带用户自定义
 *     headers）；**API key 不在此注入**——它存 safeStorage，由 host 在路由 resolve 时按
 *     `provider_key_<id>` 读出并写进鉴权头，绝不进 catalog（防经 listProviders 泄漏给 renderer）。
 *   - 用户模型可携带预设确认的 contextWindow；缺省时补保守默认，effort 使用 runtime 默认。
 */

import type {
  AgentKind,
  CatalogModel,
  CustomProviderConfig,
  Effort,
  Provider,
  ProviderRuntimeModelConfig,
  RoutingDescriptor,
} from './types.js';
import { isLoopbackProviderUrl } from './provider-url.js';

/** 自定义模型缺省上下文窗口（用户不填元数据时的保守默认，仅用于展示）。 */
export const DEFAULT_CUSTOM_CONTEXT_WINDOW = 200_000;

/**
 * 自定义模型的默认 effort 档位（「参考默认设置」）——与内置当代旗舰模型对齐：
 *   - claude-code：low/medium/high/xhigh/max（同 opus / fable）；
 *   - codex：low/medium/high/xhigh（同 gpt-5.x）。
 * 让自定义模型像内置模型一样能在选择器里切 reasoning/thinking 强度（默认 high）。
 * 端点是否真支持由其后端决定：cc 经 `thinking`、codex 经 reasoning effort 透传，
 * anthropic-compat-proxy 仅对个别内置 model id strip 字段、对自定义 id 一律字节透传。
 */
const CUSTOM_EFFORTS: Partial<Record<AgentKind, Effort[]>> = {
  'claude-code': ['low', 'medium', 'high', 'xhigh', 'max'],
  codex: ['low', 'medium', 'high', 'xhigh'],
};
/** 自定义模型默认选中的 effort（与内置旗舰一致）。 */
const DEFAULT_CUSTOM_EFFORT: Effort = 'high';

/** 固定 agent 顺序：保证派生出的 provider.agents / routing / models 顺序稳定。 */
const AGENT_ORDER: readonly AgentKind[] = ['claude-code', 'codex'];

/** 单个用户填写的模型 → CatalogModel（补默认元数据；effort 按所属 agent 参考内置默认）。 */
function toCatalogModel(
  m: ProviderRuntimeModelConfig,
  providerId: string,
  agent: AgentKind,
): CatalogModel {
  const efforts = CUSTOM_EFFORTS[agent] ?? [];
  return {
    id: m.id,
    name: m.name,
    contextWindow: m.contextWindow ?? DEFAULT_CUSTOM_CONTEXT_WINDOW,
    efforts,
    defaultEffort: efforts.length > 0 ? DEFAULT_CUSTOM_EFFORT : null,
    // 选择器右栏按 group 聚合：同一自定义来源的模型聚成一组（渲染层用 provider 名兜底标签）。
    group: `custom:${providerId}`,
    // 手填模型保持历史默认可见；刷新发现的模型可显式声明默认隐藏。
    defaultEnabled: m.defaultEnabled ?? true,
  };
}

function defaultWireProtocol(agent: AgentKind): 'anthropic-messages' | 'openai-responses' {
  return agent === 'claude-code' ? 'anthropic-messages' : 'openai-responses';
}

/** baseUrl + 自定义 headers → 路由描述符（**不含密钥**）。 */
function toRouting(
  agent: AgentKind,
  baseUrl: string,
  requestPath: string | undefined,
  headers: Record<string, string> | undefined,
  strategy: 'api-key-header' | 'oauth-token' | 'none',
  modelsUrl?: string,
  wireProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat',
): RoutingDescriptor {
  const r: RoutingDescriptor = {
    upstream: baseUrl,
    authStrategy: strategy,
    ...(strategy === 'none'
      && (!isLoopbackProviderUrl(baseUrl)
        || (modelsUrl !== undefined && !isLoopbackProviderUrl(modelsUrl)))
      ? { disabled: true }
      : {}),
    ...(requestPath ? { requestPath } : {}),
    ...(wireProtocol && wireProtocol !== defaultWireProtocol(agent) ? { wireProtocol } : {}),
  };
  if (headers && Object.keys(headers).length > 0) r.headerOverride = { ...headers };
  // 列模型端点回带（编辑表单从 routing 重建配置时不丢；路由器不消费本字段）。
  if (modelsUrl) r.modelsUrl = modelsUrl;
  return r;
}

/**
 * 把用户自定义配置展开成标准 `Provider`。纯函数，不校验（合法性由 host 的 store / handler 保证）。
 * 按 `runtimes` 里**已配置的 runtime** 生成各 agent 的 routing / models（每 runtime 独立 baseUrl /
 * 模型 / headers）；空 runtimes 产出空 Provider（不出现在任何 agent 列表，无害）。
 */
export function buildUserProvider(config: CustomProviderConfig): Provider {
  // OAuth 形态路由走 Runner Bearer；none 明确走无鉴权且由 host 剥凭证；缺省保持历史 API key。
  const oauth = config.auth?.method === 'oauth' ? config.auth.oauth : undefined;
  const isOAuth = oauth !== undefined;
  const noAuth = config.auth?.method === 'none';
  const strategy = isOAuth ? 'oauth-token' : noAuth ? 'none' : 'api-key-header';
  const routing: Partial<Record<AgentKind, RoutingDescriptor>> = {};
  const models: Partial<Record<AgentKind, CatalogModel[]>> = {};
  const agents: AgentKind[] = [];
  for (const agent of AGENT_ORDER) {
    const rt = config.runtimes[agent];
    if (!rt) continue;
    agents.push(agent);
    routing[agent] = toRouting(
      agent,
      rt.baseUrl,
      rt.requestPath,
      rt.headers,
      strategy,
      rt.modelsUrl,
      rt.wireProtocol,
    );
    models[agent] = rt.models.map((m) => toCatalogModel(m, config.id, agent));
  }
  return {
    id: config.id,
    name: config.name,
    source: 'user',
    agents,
    auth: isOAuth
      ? { method: 'oauth', oauth }
      : noAuth
        ? { method: 'none' }
        : { method: 'apiKey' },
    // API key / 无鉴权代理都属于用户自备接口；通用 OAuth 可能订阅也可能按量，未声明前不猜。
    ...(isOAuth ? {} : { access: { kind: 'api' as const } }),
    routing,
    models,
  };
}
