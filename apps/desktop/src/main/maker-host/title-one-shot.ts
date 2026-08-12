/**
 * title-one-shot —— 会话标题的「单次 HTTP」生成器。
 *
 * 设计:每个会话按其所属 provider 取 catalog 配的 `titleModel`(最经济模型),
 * 用该 provider 自家凭证 + **一次** HTTP 请求起标题。
 * 三家 wire 协议不同,各一个 fetcher:
 *   - anthropic 订阅 → Anthropic Messages API(`/v1/messages`,Bearer OAuth + anthropic-beta)
 *   - openai 订阅    → ChatGPT codex 后端 Responses(`/responses`,Bearer + chatgpt-account-id,读 SSE)
 *   - xd 网关        → litellm chat-completions(`/v1/chat/completions`,Bearer 网关 key)
 *
 * 约束(用户敲定):
 *   - **只试本会话的单一 provider,不做跨 provider 兜底**。凭证缺失 / HTTP 失败 / 空响应 → 返回
 *     null,调用方(renderer scheduleAutoName)回落到「消息前 N 字」启发式。
 *   - **不实现 token 自动 refresh** —— OAuth/订阅 token 的刷新由 cc 子进程 / codex app-server 负责
 *     (它们读写同一处凭证),本模块每次实时读当下值;过期就当次失败、优雅降级。
 *   - 三条标题调用都**不注入任何 system / 身份提示词**(实测 anthropic 裸调即 200),不触及系统提示词。
 *
 * 路由素材(upstream / authStrategy)取自当前生效目录 `getActiveCatalog()`(OSS 真源 / bundled 兜底)
 * —— 与统一路由器(provider-route)同源。例外:xd 网关的 upstream 不取 catalog,
 * 运行期用 model-access server 下发的 endpoint(effectiveXdGatewayBaseUrl,与 key 同租户)。
 *
 * Provider 解析优先级(WYSIWYG,与模型选择器高亮同口径):
 *   1. DB sessions.provider_id(显式选中,race-free)。
 *   2. 无显式选 → nativeDefaultSourceId over 已连接来源列表(= 选择器里高亮的默认源)。
 *   3. 零已连接来源 → null → 回落「消息前 N 字」启发式。
 */

import { randomUUID } from 'node:crypto';

import { fetch as undiciFetch } from 'undici';

import {
  type AgentKind,
  type CatalogModel,
  type Effort,
  type Provider,
  type ProviderView,
  findModelRegistryRoute,
  isModelSelectableForNewRoute,
  nativeDefaultSourceId,
} from '@cindy/model-providers';
import { toSdkModelString } from '@cindy/maker-core';

import { createLogger } from '../logger.js';
import { getAppCapabilities } from '../appCapabilities.js';

import { getActiveCatalog } from './active-catalog.js';
import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { readModelDisableOverrides } from './model-disable-store.js';
import { readClaudeApiKey, readCodexOneShotCreds } from './auth-adapters.js';
import { getValidClaudeAiOAuth } from './claude-oauth-refresh.js';
import { outboundUndiciFetch } from './outbound-fetch.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { validateTitleOutput } from './title-output-validation.js';

const log = createLogger('maker-host:title-one-shot');

/** 标题 oneShot 单次请求超时(对齐 renderer scheduleAutoName 的等待窗口语义,留余量)。 */
const TITLE_TIMEOUT_MS = 12_000;
/** 标题 ≤ 20 字,32 token 足够;codex Responses 协议层不暴露 max_tokens,仅对 messages/chat 生效。 */
const TITLE_MAX_TOKENS = 32;
/** 异常响应保护:完整模型输出超过此 Unicode 长度就拒绝,再按历史契约截到 40 字。 */
const TITLE_OUTPUT_MAX_CHARS = 256;
/**
 * Codex Responses 要求 instructions 字段，但语言和长度必须由调用方 prompt 决定。
 * 这里仅约束输出形状，避免覆盖 locale-aware 标题指令。
 */
const CODEX_TITLE_INSTRUCTIONS =
  'Output only the short conversation title requested by the user message, without quotation marks or ending punctuation.';

type FetchImpl = typeof undiciFetch;

/** 标题 wire 协议 —— 决定 endpoint 路径、请求体形状、响应解析方式。 */
export type TitleWire = 'anthropic-messages' | 'codex-responses' | 'gateway-chat';

/** 解析出的「这条会话用谁、什么模型、走什么 wire」目标。null = 无法智能起名(回落启发式)。 */
export interface TitleTarget {
  providerId: string;
  /** catalog model id(titleModel)。anthropic 走 wire 前会经 toSdkModelString 还原成 dated 串。 */
  model: string;
  /** 该模型在目录里的最低 effort 档;null = 该模型不支持 effort(如 Haiku)。 */
  effort: Effort | null;
  wire: TitleWire;
  /** 上游 base(anthropic/openai 取自 catalog routing.upstream;xd 取 server 下发 endpoint)。 */
  upstream: string;
}

/** 注入点 —— 便于单测(mock fetch / 伪造凭证 / 伪造 provider)。缺省均返回 null(回落启发式)。 */
export interface TitleOneShotDeps {
  fetchImpl?: FetchImpl;
  /** 读 DB sessions.provider_id(race-free 显式来源)。null = 未显式选,走默认。 */
  readSessionProviderId?: (sessionId: string) => Promise<string | null>;
  /** 某 agent 下已连接的供应商视图列表(实时连接态)。用于无显式选择时取 WYSIWYG 默认。 */
  listConnectedProviders?: (agentKind: AgentKind) => Promise<ProviderView[]>;
  readAnthropicOAuth?: () =>
    Promise<{ accessToken: string } | null> | { accessToken: string } | null;
  readCodexCreds?: () => { accessToken: string; accountId: string } | null;
  readGatewayKey?: () => string | null;
}

const EFFORT_RANK: Record<Effort, number> = {
  minimal: 0,
  low: 1,
  medium: 2,
  high: 3,
  xhigh: 4,
  max: 5,
  ultra: 6,
};

/** 取一组 effort 里的最低档;空 → null。 */
function lowestEffort(efforts: Effort[]): Effort | null {
  if (!efforts.length) return null;
  return [...efforts].sort((a, b) => EFFORT_RANK[a] - EFFORT_RANK[b])[0];
}

function trimTrailingSlash(s: string): string {
  return s.replace(/\/+$/, '');
}

/** 在 provider 的所有 agent 模型清单里查某 model id 的目录条目(用于取 efforts)。 */
function findCatalogModel(provider: Provider, modelId: string) {
  for (const agent of provider.agents) {
    const hit = (provider.models[agent] ?? []).find((m) => m.id === modelId);
    if (hit) return hit;
  }
  return undefined;
}

type TitleRouteUnavailableReason = 'disabled' | 'retired' | 'capability-model';

function titleRouteUnavailableReason(
  model: CatalogModel,
  userProvider: boolean,
): TitleRouteUnavailableReason | null {
  if (isModelSelectableForNewRoute(model, { userProvider })) return null;
  if (model.status === 'retired') return 'retired';
  return model.disabled === true ? 'disabled' : 'capability-model';
}

/**
 * XD 网关实时清单中选标题模型:存在 + 具备聊天能力 + 未停用/未退休,取单价最低者
 * (标题 oneShot 语义 = 最经济模型)。清单为空或无可用聊天模型 → null(回落启发式,
 * 不向网关发送必然 400 的无效请求)。
 *
 * 2026-08-06 修复(#1891):此前 xd 分支直发静态 titleModel `gpt-5.4-mini`,而网关
 * 清单已不含该模型(网关 /v1/models 是权威,模型 id 均带供应商前缀)——修复后改为
 * 从 active catalog 中 xd provider 的 models(由 setXdGatewayModels 整体重建)选择,
 * 网关清单变化不再导致标题通道硬失败。
 */
function pickXdTitleModel(provider: Provider): CatalogModel | null {
  // 用户显式停用(disable override store)优先于清单排序:active catalog 的 xd
  // 模型不带 buildRegistry 烘焙的 disabled 字段(那在 rail 的 ProviderView 上),
  // 只查目录会选中已停用模型,派发前 routeUnavailableNow 再中止整个 one-shot,
  // 标题退回落启发式而非次便宜可用模型(Codex review round 2)。
  const disableOverrides = readModelDisableOverrides();
  const candidates: CatalogModel[] = [];
  for (const agent of provider.agents) {
    for (const model of provider.models[agent] ?? []) {
      if (!isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' })) {
        continue;
      }
      // 只选原生 chat 模型:mode 明确为 'responses' 的模型需要走 Codex Responses
      // wire,而标题通道固定走 gateway-chat(/v1/chat/completions)——选中的话仍会
      // 被网关拒收(Greptile review P2,2026-08-06)。mode 缺省(网关旧条目)按 chat
      // 处理,由 isModelSelectableForNewRoute 的 id 分类兜底。
      if (model.mode === 'responses') continue;
      if (isModelDisabled(disableOverrides, provider.id, model.id)) continue;
      candidates.push(model);
    }
  }
  if (candidates.length === 0) return null;
  // 按 per-1M token 总价升序选最经济;无价条目排后(仍可被选中,兜底保证可用性)。
  const costRank = (m: CatalogModel): number => {
    const c = m.cost;
    if (!c) return Number.POSITIVE_INFINITY;
    return (typeof c.input === 'number' ? c.input : 0) + (typeof c.output === 'number' ? c.output : 0);
  };
  return [...candidates].sort((a, b) => costRank(a) - costRank(b))[0];
}

/**
 * 据 providerId 组装标题目标(模型 + 最低 effort + wire + upstream)。
 * provider 无 titleModel / 无对应路由 / 未知 provider → null(不参与智能起名)。
 *
 * wire 按 provider 分派:内置三家协议各异且无法纯靠 authStrategy 区分(anthropic 与 openai
 * 同为 oauth-passthrough 但 wire 不同),故按 id 显式分派。**新增供应商的标题支持 = 加一个 case。**
 *
 * 注意:anthropic / openai 的 titleModel 是各自订阅通道内有效的静态值(haiku /
 * gpt-5.4-mini 在 ChatGPT 后端有效);xd 是动态清单供应商,**标题模型从网关实时
 * 清单选择**(pickXdTitleModel),不读静态 titleModel(网关清单即权威)。
 */
export function buildTitleTarget(providerId: string): TitleTarget | null {
  const provider = getActiveCatalog().providers.find((p) => p.id === providerId);
  if (!provider) return null;

  switch (provider.id) {
    case 'anthropic': {
      if (!provider.titleModel) return null;
      const model = provider.titleModel;
      const effort = lowestEffort(findCatalogModel(provider, model)?.efforts ?? []);
      const routing = provider.routing['claude-code'];
      return routing
        ? { providerId, model, effort, wire: 'anthropic-messages', upstream: routing.upstream }
        : null;
    }
    case 'openai': {
      if (!provider.titleModel) return null;
      const model = provider.titleModel;
      const effort = lowestEffort(findCatalogModel(provider, model)?.efforts ?? []);
      const routing = provider.routing['codex'];
      return routing
        ? { providerId, model, effort, wire: 'codex-responses', upstream: routing.upstream }
        : null;
    }
    case 'xd': {
      if (!getAppCapabilities().canUseCindyGateway) return null;
      // 上游不取 catalog routing.upstream:XD 网关入口一律用 model-access server
      // 随凭据下发的 endpoint(与 key 同租户,见 effectiveEndpoint.ts);凭据未
      // 就绪(空串)时返回 null,回落启发式起名。
      const base = effectiveXdGatewayBaseUrl().trim();
      if (!base) return null;
      const model = pickXdTitleModel(provider);
      if (!model) {
        log.debug('title oneShot skipped: no usable chat model in xd gateway catalog', {
          providerId,
        });
        return null;
      }
      return {
        providerId,
        model: model.id,
        effort: lowestEffort(model.efforts ?? []),
        wire: 'gateway-chat',
        upstream: `${trimTrailingSlash(base)}/v1`,
      };
    }
    default:
      return null;
  }
}

// ── wire fetchers(各自一次 fetch;失败 / 空 → 抛错,由编排层吞成 null)─────────────

/** Anthropic Messages:Bearer 订阅 OAuth + anthropic-beta;model 经 toSdkModelString 还原 wire 串。 */
async function fetchAnthropicTitle(
  upstream: string,
  modelId: string,
  prompt: string,
  oauthToken: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetchImpl(`${trimTrailingSlash(upstream)}/v1/messages`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${oauthToken}`,
      'anthropic-version': '2023-06-01',
      'anthropic-beta': 'oauth-2025-04-20',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: toSdkModelString(modelId),
      max_tokens: TITLE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic messages HTTP ${res.status}`);
  const json = (await res.json()) as { content?: Array<{ type?: string; text?: string }> };
  return (json.content ?? [])
    .filter((b) => b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')
    .trim();
}

/** ChatGPT codex 后端 Responses:Bearer + chatgpt-account-id + originator;SSE 流式,读 output_text。 */
async function fetchCodexTitle(
  upstream: string,
  modelId: string,
  effort: Effort | null,
  prompt: string,
  creds: { accessToken: string; accountId: string },
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<string> {
  const body: Record<string, unknown> = {
    model: modelId,
    instructions: CODEX_TITLE_INSTRUCTIONS,
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: prompt }] }],
    tools: [],
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
  };
  if (effort) body.reasoning = { effort };

  const res = await fetchImpl(`${trimTrailingSlash(upstream)}/responses`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${creds.accessToken}`,
      'chatgpt-account-id': creds.accountId,
      'OpenAI-Beta': 'responses=experimental',
      originator: 'codex_cli_rs',
      session_id: randomUUID(),
      'content-type': 'application/json',
      accept: 'text/event-stream',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`codex responses HTTP ${res.status}`);
  return parseResponsesSse(await res.text());
}

/** XD 网关 litellm:Bearer 网关 key,OpenAI chat-completions 形状。 */
async function fetchGatewayTitle(
  upstream: string,
  modelId: string,
  prompt: string,
  gatewayKey: string,
  fetchImpl: FetchImpl,
  signal: AbortSignal,
): Promise<string> {
  const res = await fetchImpl(`${trimTrailingSlash(upstream)}/chat/completions`, {
    method: 'POST',
    signal,
    headers: {
      authorization: `Bearer ${gatewayKey}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: modelId,
      max_tokens: TITLE_MAX_TOKENS,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`gateway chat HTTP ${res.status}`);
  const json = (await res.json()) as { choices?: Array<{ message?: { content?: unknown } }> };
  return (json.choices ?? [])
    .map((c) => (typeof c.message?.content === 'string' ? c.message.content : ''))
    .join('')
    .trim();
}

/** 解析 Responses SSE 文本:累加 output_text.delta,有 response.completed 则以其 final 文本为准。 */
export function parseResponsesSse(raw: string): string {
  let delta = '';
  let final = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const ev = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        response?: { output?: Array<{ content?: Array<{ type?: string; text?: string }> }> };
      };
      if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
        delta += ev.delta;
      } else if (ev.type === 'response.completed' && ev.response) {
        final = (ev.response.output ?? [])
          .flatMap((o) => o.content ?? [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text ?? '')
          .join('');
      }
    } catch {
      /* 跳过非 JSON / 心跳行 */
    }
  }
  return (final || delta).trim();
}

/**
 * 标题 oneShot 主入口:解析本会话 provider → titleModel → 单次 HTTP 起标题。
 * 任何环节失败(无 titleModel / 凭证缺失 / HTTP 错 / 空响应 / 超时)→ 返回 null,调用方回落启发式。
 * 全程不打印 token(只记 providerId / model / wire / 耗时)。
 */
export async function generateTitleViaProvider(
  args: { sessionId: string; agentKind: AgentKind; prompt: string; signal?: AbortSignal },
  deps: TitleOneShotDeps = {},
): Promise<string | null> {
  // 默认走吃系统代理的 undici fetch:上游可能是境外端点(catalog routing.upstream)。
  const fetchImpl = deps.fetchImpl ?? outboundUndiciFetch;
  const readSessionProviderId = deps.readSessionProviderId ?? (async () => null);
  const listConnectedProviders = deps.listConnectedProviders ?? (async () => []);
  const readCodexCreds = deps.readCodexCreds ?? readCodexOneShotCreds;
  // 走刷新模块而非直读凭证库:cc >= 2.1.198 后凭证库的新鲜度取决于 host 刷新节奏,
  // 直读会在 token 过期后长期拿死值 → 静默 401 回落启发式标题。getValidClaudeAiOAuth
  // 临期自动续(非强制语义,失败退回现值,行为不劣于直读)。
  const readAnthropicOAuth = deps.readAnthropicOAuth ?? (() => getValidClaudeAiOAuth());
  const readGatewayKey = deps.readGatewayKey ?? readClaudeApiKey;

  // Provider 解析:WYSIWYG,与模型选择器高亮同口径。
  //   1. DB sessions.provider_id(显式选中,race-free)—— 但必须仍在可路由 rail 里
  //      (connectedProvidersForAgent 已剔除 suspended 停用供应商):标题 one-shot 是
  //      一次新的付费调用,停用的来源不给用(PR #744 review);断开的来源本来也会在
  //      各 wire 的凭证检查处折返,这里提前跳过语义一致。
  //   2. 无显式选 → nativeDefaultSourceId(已连接来源列表,agentKind)。
  //   3. 零已连接来源 → null → 直接跳过(不起智能标题)。
  const explicitFromDb = args.sessionId ? await readSessionProviderId(args.sessionId) : null;
  const rail = await listConnectedProviders(args.agentKind);
  let providerId: string | null;
  if (explicitFromDb) {
    providerId = rail.some((p) => p.id === explicitFromDb) ? explicitFromDb : null;
  } else {
    providerId = nativeDefaultSourceId(rail, args.agentKind);
  }

  if (!providerId) {
    log.debug('title oneShot skipped: no connected provider', { agentKind: args.agentKind });
    return null;
  }

  const target = buildTitleTarget(providerId);
  if (!target) {
    log.debug('title oneShot skipped: no title target', { providerId, agentKind: args.agentKind });
    return null;
  }
  // 标题模型这份拷贝被用户停用 → 跳过(回落启发式起名)。rail 条目带 buildRegistry
  // 烘焙的 disabled 标志。查找必须跨该供应商的**所有 agent** 清单(findCatalogModel,
  // 与 buildTitleTarget 解析 titleModel 的口径一致):cc 会话经 OpenAI 路由时,标题模型
  // gpt-5.4-mini 挂在 codex 清单下,只查会话 agent 会漏掉停用标志(PR #744 review
  // 第十一轮)。目录里完全找不到该模型时不额外拦。
  const railProvider = rail.find((p) => p.id === providerId);
  const titleCatalogModel = railProvider ? findCatalogModel(railProvider, target.model) : undefined;
  const initialUnavailableReason = titleCatalogModel
    ? titleRouteUnavailableReason(titleCatalogModel, railProvider?.source === 'user')
    : null;
  if (initialUnavailableReason) {
    log.debug('title oneShot skipped: title model unavailable for new route', {
      providerId,
      model: target.model,
      reason: initialUnavailableReason,
    });
    return null;
  }

  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TITLE_TIMEOUT_MS);
  // 外部 signal(发送被取消)联动到本次请求。
  const onExternalAbort = () => controller.abort();
  args.signal?.addEventListener('abort', onExternalAbort);

  // 派发紧前重查(PR #744 review 第二十一轮):OAuth 刷新等凭证获取是可能数秒的
  // await,期间该 (来源, 标题模型) 可能被用户停用或被热刷新标成 retired —— 凭证
  // 到手、请求发出的紧前同时重读 override store 与 active catalog。直查这两份同步
  // 真源(不经 oneShotCandidates:那条链模块加载期拖 runtime-configs / ripgrep 探测等
  // electron 面,污染轻量测试环境)。
  const routeUnavailableNow = (): TitleRouteUnavailableReason | null => {
    const overrides = readModelDisableOverrides();
    if (
      isProviderDisabled(overrides, providerId) ||
      isModelDisabled(overrides, providerId, target.model)
    ) {
      return 'disabled';
    }
    const currentCatalog = getActiveCatalog();
    const currentProvider = currentCatalog.providers.find((provider) => provider.id === providerId);
    const currentModel = currentProvider
      ? findCatalogModel(currentProvider, target.model)
      : undefined;
    if (currentModel) {
      return titleRouteUnavailableReason(currentModel, currentProvider?.source === 'user');
    }
    // retired 且没有 discovery/local addition 时不会出现在 provider.models；仍要从
    // Registry tombstone 本身识别，不能把“未实体化”误当成“没有限制”。
    return findModelRegistryRoute(currentCatalog.modelRegistry, providerId, target.model)?.entry
      .status === 'retired'
      ? 'retired'
      : null;
  };
  const canDispatchNow = (stage: string): boolean => {
    const reason = routeUnavailableNow();
    if (!reason) return true;
    log.debug('title oneShot skipped: route unavailable before dispatch', {
      providerId,
      model: target.model,
      reason,
      stage,
    });
    return false;
  };
  try {
    let text = '';
    switch (target.wire) {
      case 'anthropic-messages': {
        const oauth = await readAnthropicOAuth();
        if (!oauth?.accessToken) {
          log.debug('title oneShot skipped: no anthropic OAuth', { providerId });
          return null;
        }
        if (!canDispatchNow('after-credential-refresh')) return null;
        text = await fetchAnthropicTitle(
          target.upstream,
          target.model,
          args.prompt,
          oauth.accessToken,
          fetchImpl,
          controller.signal,
        );
        break;
      }
      case 'codex-responses': {
        const creds = readCodexCreds();
        if (!creds) {
          log.debug('title oneShot skipped: no codex creds', { providerId });
          return null;
        }
        if (!canDispatchNow('after-credential-read')) return null;
        text = await fetchCodexTitle(
          target.upstream,
          target.model,
          target.effort,
          args.prompt,
          creds,
          fetchImpl,
          controller.signal,
        );
        break;
      }
      case 'gateway-chat': {
        const key = readGatewayKey();
        if (!key) {
          log.debug('title oneShot skipped: no gateway key', { providerId });
          return null;
        }
        if (!canDispatchNow('after-credential-read')) return null;
        text = await fetchGatewayTitle(
          target.upstream,
          target.model,
          args.prompt,
          key,
          fetchImpl,
          controller.signal,
        );
        break;
      }
    }
    // The prompt is advisory; never persist a transcript continuation, role-labelled
    // response, Markdown wrapper, or multiline answer. Validate the complete response
    // before applying the historical 40-character auto-title truncation, so a bad suffix
    // cannot hide beyond the slice boundary.
    const normalized = validateTitleOutput(text, TITLE_OUTPUT_MAX_CHARS);
    const title = normalized ? Array.from(normalized).slice(0, 40).join('') : null;
    if (!title) {
      log.warn('title oneShot rejected invalid model output', {
        providerId,
        model: target.model,
        wire: target.wire,
        elapsedMs: Date.now() - startedAt,
      });
      return null;
    }
    log.info('title oneShot done', {
      providerId,
      model: target.model,
      wire: target.wire,
      elapsedMs: Date.now() - startedAt,
      chars: Array.from(title).length,
    });
    return title;
  } catch (err) {
    log.warn('title oneShot failed (swallowed)', {
      providerId,
      model: target.model,
      wire: target.wire,
      elapsedMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    });
    return null;
  } finally {
    clearTimeout(timeout);
    args.signal?.removeEventListener('abort', onExternalAbort);
  }
}
