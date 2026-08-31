import { randomUUID } from 'node:crypto';

import { type AgentKind, type Maker } from '@cindy/maker-core';
import {
  appendProviderRequestPath,
  isModelSelectableForNewRoute,
  storedCustomProviderId,
} from '@cindy/model-providers';

import { createLogger } from '../logger.js';
import { getAppCapabilities } from '../appCapabilities.js';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getChatgptBridgeAuth } from '../maker-host/anthropic-responses-bridge-host.js';
import { getValidClaudeAiOAuth } from '../maker-host/claude-oauth-refresh.js';
import { getGrokAccessToken } from '../maker-host/grok-oauth-login.js';
import { readCachedGenericOAuthAccessToken } from '../maker-host/generic-oauth.js';
// undici 的 fetch,但 per-request 现取系统代理(裸 undici 不吃代理设置)。
import { outboundUndiciFetch as undiciFetch } from '../maker-host/outbound-fetch.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import {
  getActiveCatalog,
  isXdGatewayPaymentRequiredRoute,
} from '../maker-host/active-catalog.js';
import { readModelDisableOverrides } from '../maker-host/model-disable-store.js';
import { isModelDisabled, isProviderDisabled } from '@cindy/model-providers';
import { isProviderRouteMutationInProgress } from '../maker-host/provider-route.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { parseAuxiliaryModelRef, type ParsedAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import { getEffectiveAuxiliaryModelChain } from './resolveAuxiliaryModelChain.js';
import { getUtilityModelProfile, isUtilityModelProviderKind } from '../../shared/utilityModelProfiles.js';
import type { UtilityModelProfile, UtilityModelTransport } from '../../shared/utilityModelProfiles.js';
import type {
  UtilityTextAttempt,
  UtilityTextAttemptReason,
  UtilityTextFailureReason,
  UtilityTextResult,
} from '../../shared/utilityTextResult.js';

const log = createLogger('utility-model:one-shot');

const XD_UTILITY_ROUTE_AGENTS: readonly AgentKind[] = ['claude-code', 'codex', 'pi'];

/**
 * Utility profiles call the XD chat-completions endpoint directly and therefore
 * have no Session agent rail. A v5 paid deny on any advertised rail is enough
 * to block the same gateway model id here; availability is account/model scoped.
 */
function isXdUtilityModelPaymentRequired(model: string): boolean {
  return XD_UTILITY_ROUTE_AGENTS.some((agent) =>
    isXdGatewayPaymentRequiredRoute(model, agent),
  );
}

/**
 * Shared live entitlement predicate for direct utility consumers. Only XD
 * LiteLLM routes use the Cindy account catalog; Codex and custom BYOK routes
 * keep their own credential plane. Organization catalogs are not subject to
 * personal free/paid gating and arrive as not_applicable with every visible
 * model available, so they never create this deny state.
 */
export function isUtilityRoutePaymentRequired(profile: {
  transport?: string;
  model: string;
}): boolean {
  return profile.transport === 'litellm-chat-completions'
    && isXdUtilityModelPaymentRequired(profile.model);
}

/**
 * 实现了 `Agent.oneShot` 的 agent 集合(当前 claude-code / codex)。PiAgent 继承 BaseAgent
 * 的 not-implemented,选中它调 oneShot 会抛错;help 兜底与任务摘要兜底都据此跳过 Pi,避免
 * best-effort 结果被静默丢弃。Pi 实现 oneShot 后把它加入本集合即可。
 */
const ONESHOT_CAPABLE_AGENTS: ReadonlySet<AgentKind> = new Set(['claude-code', 'codex']);
export function agentSupportsOneShot(agentKind: AgentKind): boolean {
  return ONESHOT_CAPABLE_AGENTS.has(agentKind);
}

export type UtilityTextCapability = {
  transports: readonly UtilityModelTransport[];
};

export interface UtilityTextDispatchRoute {
  providerId: string;
  agentKind: AgentKind;
  model: string;
}

export type UtilityTextCandidate = {
  providerId: string;
  model: string;
  transport: UtilityModelTransport;
  profile: UtilityModelProfile;
  execute: (prompt: string, opts?: UtilityTextRequestOptions) => Promise<string>;
};

export type UtilityTextRequestOptions = {
  maxTokens?: number;
  timeoutMs?: number;
  /** Optional lightweight reasoning hint for short internal classifiers. */
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  /**
   * Disable provider-native thinking for strict short-output budgets. Messages
   * and chat routes send `thinking.type=disabled`; Responses routes use the
   * lowest supported effort because that protocol has no off value.
   */
  disableReasoning?: boolean;
  /** Abort an in-flight direct HTTP request when the owning workflow ends. */
  signal?: AbortSignal;
  /** Provider-native system/instructions text, kept separate from reference data. */
  systemPrompt?: string;
  /** Additional output-shape instruction (mainly for Responses-compatible routes). */
  responseInstructions?: string;
  /** Final ownership/config guard immediately before an explicit HTTP dispatch. */
  beforeDispatch?: (route: UtilityTextDispatchRoute) => Promise<boolean>;
  /** 显式任务来源；存在时禁止跨来源 fallback。 */
  providerId?: string;
  agentKind?: AgentKind;
  model?: string;
  /**
   * 钉住某一个轻量档位(UTILITY_MODEL_PROFILES 的 key,如 codex-gpt-5.4-nano)。
   * 用于插件把 cindy.text.oneshot 的选型钉到一组供应商×模型上——与图像/视频
   * 的"钉后端"同一口径:**钉了就只用它**,不再沿链回落,否则"我钉了 A 却悄悄
   * 用了 B"比直接失败更伤信任。不认的值忽略(回到跟随默认)。
   */
  pinnedProfileId?: string;
};

/** Internal resolution result keeps skipped candidates visible to diagnostics. */
type UtilityTextCandidateResolution =
  | { candidate: UtilityTextCandidate }
  | { attempt: UtilityTextAttempt };

/** Credential-safe failure raised by a concrete utility transport. */
type UtilityTextExecutionFailure =
  | { reason: 'http_error'; httpStatus: number }
  | {
    reason: Extract<UtilityTextAttemptReason, 'timeout' | 'empty_response' | 'request_failed'>;
    httpStatus?: never;
  };

/** Credential-safe error raised by a concrete utility transport. */
class UtilityTextExecutionError extends Error {
  constructor(readonly failure: UtilityTextExecutionFailure) {
    super(failure.reason);
    this.name = 'UtilityTextExecutionError';
  }
}

/**
 * Resolves text-capable utility models in configured priority order, skipping
 * entries that are unsupported by the caller or not currently credential-ready.
 * Callers still own fallback semantics: try one, try several, or ignore this.
 */
export async function getUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability = { transports: ['codex-responses', 'litellm-chat-completions'] },
): Promise<UtilityTextCandidate[]> {
  return (await resolveUtilityTextCandidates(maker, capability)).candidates;
}

/** Resolve candidates and retain safe reasons for every skipped profile. */
/**
 * utility profile 的真实路由供应商 id(停用 override 的记账主体):
 * codex-responses 经 OpenAI 订阅下单,litellm-chat-completions 经 XD 网关。
 * 未知 transport 回退 profile.id(宁可过滤不命中,不误伤)。
 */
function utilityProfileRouteProviderId(profile: UtilityModelProfile): string {
  return utilityRouteProviderIdFor(profile.transport, profile.id);
}

function utilityRouteProviderIdFor(transport: string | undefined, fallbackId: string): string {
  switch (transport) {
    case 'codex-responses':
      return 'openai';
    case 'litellm-chat-completions':
      return 'xd';
    default:
      return fallbackId;
  }
}

/**
 * 共享 utility 档位形态的直连消费方(voice-input BYOK 精修链等)复用的停用判定:
 * 按真实路由供应商(codex-responses→openai,litellm→xd)查 override,供应商级或
 * 该 (来源, 模型) 条目命中即视为停用(PR #744 review 第十五轮)。
 */
export function isUtilityRouteDisabled(profile: {
  id: string;
  transport?: string;
  model: string;
}): boolean {
  const overrides = readModelDisableOverrides();
  const routeProviderId = utilityRouteProviderIdFor(profile.transport, profile.id);
  return (
    isProviderDisabled(overrides, routeProviderId) ||
    isModelDisabled(overrides, routeProviderId, profile.model)
  );
}

/**
 * 供应商级停用的直查入口(voice ASR / embedding 等非目录模型消费方用):这些链路
 * 的模型不在 chat/media 目录里,逐模型停用无从谈起,但「供应商整体停用」必须生效
 * —— 它们同样是经该供应商凭证的新付费调用(PR #744 review 第十六轮)。
 */
export function isProviderRouteSuspended(providerId: string): boolean {
  return isProviderDisabled(readModelDisableOverrides(), providerId);
}

/**
 * (供应商, 模型) 组合判定:供应商级停用或该模型条目被点名停用任一命中即真。
 * embedding 等「模型 id 可被逐条停用但不在 chat 目录」的消费方用
 * (PR #744 review 第十九轮)。
 */
export function isProviderModelRouteDisabled(providerId: string, modelId: string): boolean {
  const overrides = readModelDisableOverrides();
  return (
    isProviderDisabled(overrides, providerId) ||
    isModelDisabled(overrides, providerId, modelId)
  );
}

async function resolveUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability,
  pinnedProfileId?: string,
): Promise<{ candidates: UtilityTextCandidate[]; attempts: UtilityTextAttempt[] }> {
  // 钉住某一档时只拿那一个候选:钉了还沿链回落,等于用户的选择被悄悄换掉。
  // 注意不能从链里筛——默认链只有 4 档,而可钉的档位有 9 个,链外的钉不上。
  const pinned =
    pinnedProfileId && isUtilityModelProviderKind(pinnedProfileId)
      ? getUtilityModelProfile(pinnedProfileId)
      : null;
  if (pinnedProfileId && !pinned) {
    log.warn('utility text pinned profile unknown, falling back to chain', { pinnedProfileId });
  }
  const profiles = pinned ? [pinned] : getUtilityModelChainProfiles();
  const candidates: UtilityTextCandidate[] = [];
  const attempts: UtilityTextAttempt[] = [];
  // 停用轴同样约束 utility one-shot(帮助/摘要/hook 生成):停用的供应商或模型
  // 不再作为候选付费下单,链路自然落到下一个候选(PR #744 review)。
  // 注意:profile.id 是逻辑档位键(codex-gpt-5.4-mini / litellm-gpt-5.4-mini),
  // 而停用 override 按**目录供应商 id** 记账 —— 必须先映射到真实路由供应商
  // (codex-responses 走 OpenAI 订阅,litellm 走 XD 网关),否则过滤恒不命中
  // (PR #744 review 第四轮)。
  const disableOverrides = readModelDisableOverrides();
  for (const profile of profiles) {
    const routeProviderId = utilityProfileRouteProviderId(profile);
    if (
      isProviderDisabled(disableOverrides, routeProviderId) ||
      isModelDisabled(disableOverrides, routeProviderId, profile.model)
    ) {
      log.debug('utility text candidate skipped: disabled in settings', {
        providerId: routeProviderId,
        profileId: profile.id,
        model: profile.model,
      });
      attempts.push(skippedAttempt(profile, 'model_unavailable'));
      continue;
    }
    if (isUtilityRoutePaymentRequired(profile)) {
      log.debug('utility text candidate skipped: paid XD route unavailable', {
        providerId: routeProviderId,
        profileId: profile.id,
        model: profile.model,
      });
      attempts.push(skippedAttempt(profile, 'model_unavailable'));
      continue;
    }
    if (!capability.transports.includes(profile.transport)) {
      log.debug('utility text candidate skipped: unsupported transport', {
        providerId: profile.id,
        transport: profile.transport,
      });
      attempts.push(skippedAttempt(profile, 'unsupported_transport'));
      continue;
    }

    if (profile.transport === 'codex-responses') {
      const codex = await resolveCodexCandidate(maker, profile);
      if ('candidate' in codex) candidates.push(codex.candidate);
      else attempts.push(codex.attempt);
      continue;
    }

    if (profile.transport === 'litellm-chat-completions') {
      const litellm = resolveLiteLlmCandidate(profile);
      if ('candidate' in litellm) candidates.push(litellm.candidate);
      else attempts.push(litellm.attempt);
    }
  }
  return { candidates, attempts };
}

export async function requestUtilityText(
  maker: Maker,
  prompt: string,
  opts?: UtilityTextRequestOptions & {
    capability?: UtilityTextCapability;
  },
): Promise<UtilityTextResult> {
  const explicitProviderId = opts?.providerId?.trim()
    || inferUniqueProviderId(opts?.agentKind, opts?.model);
  if (explicitProviderId) {
    // 停用轴:显式点名的 (来源, 模型) 被停用 → fail closed,不派发也不落到
    // 无关的 XD utility fallback chain(与会话路由边界同语义,PR #744 review)。
    const disableOverrides = readModelDisableOverrides();
    const explicitModel = opts?.model?.trim();
    if (
      isProviderDisabled(disableOverrides, explicitProviderId) ||
      (explicitModel && isModelDisabled(disableOverrides, explicitProviderId, explicitModel))
    ) {
      log.warn('utility text route disabled in settings', {
        providerId: explicitProviderId,
        model: explicitModel ?? null,
      });
      return { ok: false, reason: 'no_candidate', attempts: [] };
    }
    return requestExplicitProviderText(prompt, {
      ...opts,
      providerId: explicitProviderId,
    });
  }

  // A caller that supplied an agent/model is asking for that task route. If
  // the catalog cannot resolve it, fail closed instead of leaking the prompt
  // into the unrelated XD utility fallback chain.
  if (opts?.agentKind && opts.model?.trim()) {
    log.warn('utility text selection has no routable provider', {
      agentKind: opts.agentKind,
      model: opts.model.trim(),
    });
    return { ok: false, reason: 'no_candidate', attempts: [] };
  }

  return requestDefaultUtilityText(maker, prompt, opts);
}

/** Execute one exact catalog route; failures never enter the default chain. */
export async function requestExplicitUtilityText(
  prompt: string,
  opts: UtilityTextRequestOptions & { providerId: string },
): Promise<UtilityTextResult> {
  const providerId = opts.providerId.trim();
  const explicitModel = opts.model?.trim();
  if (!providerId) return { ok: false, reason: 'no_candidate', attempts: [] };

  const disableOverrides = readModelDisableOverrides();
  if (
    isProviderDisabled(disableOverrides, providerId) ||
    (explicitModel && isModelDisabled(disableOverrides, providerId, explicitModel))
  ) {
    log.warn('utility text route disabled in settings', {
      providerId,
      model: explicitModel ?? null,
    });
    return { ok: false, reason: 'no_candidate', attempts: [] };
  }
  return requestExplicitProviderText(prompt, {
    ...opts,
    providerId,
    ...(explicitModel === undefined ? {} : { model: explicitModel }),
  });
}

const DEDICATED_AUTO_REVIEW_MAX_TOKENS = 384;

/**
 * Auto-review 的封闭候选表。它刻意不接受调用方传 provider/model：待审内容只能
 * 发往 Cindy 托管网关或用户已连接的 OpenAI/Anthropic 订阅，不能跟随主会话
 * 落到 xAI、DeepSeek、Kimi 或自定义 BYOM。
 */
export const DEDICATED_AUTO_REVIEW_CANDIDATES = Object.freeze([
  {
    id: 'cindy-gateway',
    providerId: 'xd',
    agentKind: 'codex',
    model: 'cindy/auto-review',
    transport: 'litellm-chat-completions',
    reasoningEffort: undefined,
  },
  {
    id: 'chatgpt-nano',
    providerId: 'openai',
    agentKind: 'codex',
    model: 'gpt-5.4-nano',
    transport: 'codex-responses',
    reasoningEffort: 'low',
  },
  {
    id: 'chatgpt-luna',
    providerId: 'openai',
    agentKind: 'codex',
    model: 'gpt-5.6-luna',
    transport: 'codex-responses',
    reasoningEffort: 'low',
  },
  {
    id: 'claude-haiku',
    providerId: 'anthropic',
    agentKind: 'claude-code',
    model: 'claude-haiku-4-5',
    transport: 'litellm-chat-completions',
    reasoningEffort: undefined,
  },
] as const satisfies ReadonlyArray<{
  id: string;
  providerId: 'xd' | 'openai' | 'anthropic';
  agentKind: AgentKind;
  model: string;
  transport: UtilityModelTransport;
  reasoningEffort: 'low' | undefined;
}>);

export type DedicatedAutoReviewCandidate = (typeof DEDICATED_AUTO_REVIEW_CANDIDATES)[number];

/**
 * 执行一个专用 Auto-review 候选。
 *
 * Gateway 别名不属于用户模型目录，必须走这条受限入口绕过普通显式路由的目录
 * 校验；订阅候选反过来必须存在于实时目录，防止对账号不支持的模型盲发请求。
 */
export async function requestDedicatedAutoReviewCandidateText(
  prompt: string,
  candidate: DedicatedAutoReviewCandidate,
  opts: { timeoutMs: number; signal?: AbortSignal },
): Promise<UtilityTextResult> {
  const profile: UtilityModelProfile = {
    id: candidate.providerId,
    model: candidate.model,
    transport: candidate.transport,
    auth: candidate.providerId === 'xd' ? 'api-key' : 'codex',
    settingsTab: 'providers',
    missingCredentialMessage: 'The Auto-review provider is not authenticated.',
  };

  if (opts.signal?.aborted) return cancelledUtilityTextResult(profile);
  if (isProviderDisabled(readModelDisableOverrides(), candidate.providerId)) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'model_unavailable')] };
  }

  if (candidate.id === 'cindy-gateway') {
    if (!getAppCapabilities().canUseCindyGateway) {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'not_authenticated')] };
    }
    const apiKey = readClaudeApiKey();
    const baseUrl = effectiveXdGatewayBaseUrl().trim();
    if (!apiKey) {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'api_key_missing')] };
    }
    if (!baseUrl) {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'endpoint_missing')] };
    }
    return executeCandidates([{
      providerId: candidate.providerId,
      model: candidate.model,
      transport: candidate.transport,
      profile,
      execute: (text, requestOpts) => requestProviderHttpText({
        wire: 'chat-completions',
        endpoint: joinProxyPath(baseUrl, '/v1/chat/completions'),
        headers: { Authorization: `Bearer ${apiKey}` },
        model: candidate.model,
        prompt: text,
        maxTokens: DEDICATED_AUTO_REVIEW_MAX_TOKENS,
        timeoutMs: requestOpts?.timeoutMs ?? opts.timeoutMs,
        signal: requestOpts?.signal ?? opts.signal,
      }),
    }], prompt, [], {
      maxTokens: DEDICATED_AUTO_REVIEW_MAX_TOKENS,
      timeoutMs: opts.timeoutMs,
      signal: opts.signal,
    });
  }

  const provider = getActiveCatalog().providers.find((item) => item.id === candidate.providerId);
  const configured = provider?.models[candidate.agentKind] ?? [];
  if (
    !provider
    || !provider.agents.includes(candidate.agentKind)
    || !provider.routing[candidate.agentKind]
  ) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'agent_unavailable')] };
  }
  if (!configured.some((model) => model.id === candidate.model)) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'model_unavailable')] };
  }
  if (isProviderModelRouteDisabled(candidate.providerId, candidate.model)) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'model_unavailable')] };
  }

  return requestBuiltinProviderText(prompt, {
    provider,
    agentKind: candidate.agentKind,
    model: candidate.model,
    transport: candidate.transport,
    maxTokens: DEDICATED_AUTO_REVIEW_MAX_TOKENS,
    timeoutMs: opts.timeoutMs,
    reasoningEffort: candidate.reasoningEffort,
    signal: opts.signal,
  });
}

/** Older remote/mobile callers may omit providerId; a model unique to one
 * non-XD provider is still enough to preserve the selected route. */
function inferUniqueProviderId(agentKind: AgentKind | undefined, model: string | undefined): string | undefined {
  const normalizedModel = model?.trim();
  if (!agentKind || !normalizedModel) return undefined;
  // 停用的 (来源, 模型) 不参与推断:被推断出来也会在派发前被 fail closed,
  // 提前剔除让「另一家启用的来源」仍能保住所选路由。
  const disableOverrides = readModelDisableOverrides();
  const matches = getActiveCatalog().providers.filter((provider) =>
    provider.agents.includes(agentKind)
    && !isProviderDisabled(disableOverrides, provider.id)
    && !isModelDisabled(disableOverrides, provider.id, normalizedModel)
    && (provider.models[agentKind] ?? []).some((candidate) => candidate.id === normalizedModel),
  );
  const nonXd = matches.filter((provider) => provider.id !== 'xd');
  if (nonXd.length === 1) return nonXd[0]?.id;
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function auxiliaryRefDispatchRoute(parsed: ParsedAuxiliaryModelRef): UtilityTextDispatchRoute {
  if (parsed.kind === 'catalog') {
    return {
      providerId: parsed.route.providerId,
      agentKind: parsed.route.agentKind,
      model: parsed.route.model,
    };
  }
  const profile = getUtilityModelProfile(parsed.id);
  return {
    providerId: profile.transport === 'codex-responses' ? 'openai' : 'xd',
    agentKind: 'codex',
    model: profile.model,
  };
}

async function runDefaultProfileCandidates(
  prompt: string,
  candidates: UtilityTextCandidate[],
  attempts: UtilityTextAttempt[],
  opts?: UtilityTextRequestOptions,
): Promise<UtilityTextResult | null> {
  for (const candidate of candidates) {
    // 逐候选执行前按**当前** override 重查(PR #744 review 第二十一轮):前一个
    // 候选失败/超时可能耗时数十秒,期间本候选可能已被停用 —— 不再对其付费下单,
    // 记 model_unavailable 落到下一候选。
    if (isUtilityRouteDisabled(candidate.profile)) {
      attempts.push(skippedAttempt(candidate.profile, 'model_unavailable'));
      continue;
    }
    // 前一个 fallback 候选可能运行数十秒；在每个 XD 候选真正执行前重读
    // owner-scoped v5 deny，避免订阅状态/模型目录刚变化后继续向网关下单。
    if (isUtilityRoutePaymentRequired(candidate.profile)) {
      attempts.push(skippedAttempt(candidate.profile, 'model_unavailable'));
      continue;
    }
    // Profile candidates may spend time awaiting credential discovery before
    // they reach this loop (for example maker.getAgentAuthState for Codex).
    // Re-check the owning workflow immediately before invoking the candidate;
    // otherwise a profile route can bypass the catalog HTTP path's final
    // beforeDispatch fence and send the old owner's prompt after a switch.
    if (
      opts?.beforeDispatch
      && !(await opts.beforeDispatch({
        providerId: utilityRouteProviderIdFor(candidate.profile.transport, candidate.providerId),
        agentKind: 'codex',
        model: candidate.model,
      }))
    ) {
      log.warn('utility text profile candidate aborted before dispatch', {
        providerId: candidate.providerId,
        model: candidate.model,
      });
      return null;
    }
    try {
      const text = (await candidate.execute(prompt, opts)).trim();
      if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
      return {
        ok: true,
        text,
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
      };
    } catch (error) {
      const failure = classifyExecutionFailure(error);
      attempts.push(failedAttempt(candidate, failure));
      log.warn('utility text candidate failed, trying next', {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        reason: failure.reason,
        httpStatus: failure.httpStatus,
      });
    }
  }
  return null;
}

function failedChainResult(attempts: UtilityTextAttempt[]): UtilityTextResult {
  const failed = attempts.filter((attempt) => attempt.status === 'failed');
  const reason = failed.length > 0
    ? aggregateFailureReason(failed)
    : attempts.length > 0
      ? 'no_candidate'
      : 'all_candidates_failed';
  log.warn('all utility text candidates failed', { reason, attempts: attempts.length });
  return { ok: false, reason, attempts };
}

async function requestDefaultUtilityText(
  maker: Maker,
  prompt: string,
  opts?: UtilityTextRequestOptions & { capability?: UtilityTextCapability },
): Promise<UtilityTextResult> {
  // Default-chain resolution and credential discovery can both await. Capture
  // the owner before either starts so callers that do not provide their own
  // workflow guard still fail closed instead of dispatching into a new owner.
  const ownerScopeKey = activeOwnerScopeKey();
  // A fallback chain is a user-selected routing decision. If it changes while
  // an earlier candidate is awaiting credentials or failing, do not dispatch a
  // later candidate from the stale snapshot into the new configuration.
  const initialChain = opts?.pinnedProfileId ? null : getEffectiveAuxiliaryModelChain();
  const chainSnapshot = initialChain ? stableSnapshot(initialChain) : null;
  const callerBeforeDispatch = opts?.beforeDispatch;
  const requestOpts: UtilityTextRequestOptions & { capability?: UtilityTextCapability } = {
    ...opts,
    beforeDispatch: async (route) => {
      if (isAppSessionBoundaryPending() || activeOwnerScopeKey() !== ownerScopeKey) return false;
      if (
        chainSnapshot !== null
        && stableSnapshot(getEffectiveAuxiliaryModelChain()) !== chainSnapshot
      ) return false;
      return callerBeforeDispatch ? callerBeforeDispatch(route) : true;
    },
    // Short auxiliary budgets cannot afford provider-default thinking. Callers
    // that need reasoning must pass disableReasoning: false.
    disableReasoning: opts?.disableReasoning ?? true,
  };
  const capability = opts?.capability ?? {
    transports: ['codex-responses', 'litellm-chat-completions'],
  };

  if (opts?.pinnedProfileId) {
    const { candidates, attempts } = await resolveUtilityTextCandidates(
      maker,
      capability,
      opts.pinnedProfileId,
    );
    if (candidates.length === 0) {
      return { ok: false, reason: 'no_candidate', attempts };
    }
    const success = await runDefaultProfileCandidates(prompt, candidates, attempts, requestOpts);
    return success ?? failedChainResult(attempts);
  }

  const chain = initialChain!;
  const attempts: UtilityTextAttempt[] = [];
  for (const ref of chain.refs) {
    const parsed = parseAuxiliaryModelRef(ref);
    if (!parsed) continue;
    if (
      requestOpts.beforeDispatch
      && !(await requestOpts.beforeDispatch(auxiliaryRefDispatchRoute(parsed)))
    ) {
      log.warn('utility text chain aborted before dispatch', { ref, source: chain.source });
      return failedChainResult(attempts);
    }
    if (parsed.kind === 'profile') {
      const resolved = await resolveUtilityTextCandidates(maker, capability, parsed.id);
      attempts.push(...resolved.attempts);
      if (resolved.candidates.length === 0) continue;
      const success = await runDefaultProfileCandidates(
        prompt,
        resolved.candidates,
        attempts,
        requestOpts,
      );
      if (success) return success;
      continue;
    }
    const result = await requestExplicitProviderText(prompt, {
      ...requestOpts,
      providerId: parsed.route.providerId,
      agentKind: parsed.route.agentKind,
      model: parsed.route.model,
    });
    if (result.ok) return result;
    attempts.push(...result.attempts);
  }
  return failedChainResult(attempts);
}

function stableSnapshot(value: unknown): string {
  const normalize = (entry: unknown): unknown => {
    if (Array.isArray(entry)) return entry.map(normalize);
    if (entry && typeof entry === 'object') {
      return Object.keys(entry as Record<string, unknown>)
        .sort()
        .reduce<Record<string, unknown>>((result, key) => {
          result[key] = normalize((entry as Record<string, unknown>)[key]);
          return result;
        }, {});
    }
    return entry;
  };
  return JSON.stringify(normalize(value));
}

/**
 * Explicit task provider path. A selected custom provider is a single route,
 * not another entry in the XD fallback pool: a failed request must not leak
 * the prompt to a different gateway or credential.
 */
async function requestExplicitProviderText(
  prompt: string,
  opts: UtilityTextRequestOptions & { providerId: string },
): Promise<UtilityTextResult> {
  const provider = getActiveCatalog().providers.find((item) => item.id === opts.providerId);
  const agentKind = opts.agentKind ?? inferProviderAgent(provider);
  const configuredModels = agentKind ? provider?.models[agentKind] ?? [] : [];
  const requestedModel = opts.model?.trim();
  // Model resolution is scoped to the selected agent. Never use provider.titleModel
  // here: that legacy field may belong to another runtime (for example Codex),
  // which would silently turn a Claude request into a Codex request.
  const model = requestedModel || configuredModels.find((item) =>
    isModelSelectableForNewRoute(item, { userProvider: provider?.source === 'user' }))?.id || '';
  const selectedRouting = agentKind ? provider?.routing[agentKind] : undefined;
  const transport: UtilityModelTransport =
    agentKind === 'codex' && selectedRouting?.wireProtocol !== 'openai-chat'
      ? 'codex-responses'
      : 'litellm-chat-completions';

  if (!provider || !agentKind || !provider.agents.includes(agentKind)) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: opts.providerId,
        model,
        transport,
        status: 'skipped',
        reason: 'agent_unavailable',
      }],
    };
  }
  if (isProviderRouteMutationInProgress(provider.id)) {
    return {
      ok: false,
      reason: 'all_candidates_failed',
      attempts: [{
        providerId: provider.id,
        model,
        transport,
        status: 'failed',
        reason: 'request_failed',
      }],
    };
  }
  if (!model) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: provider.id,
        model: '',
        transport,
        status: 'skipped',
        reason: 'model_unavailable',
      }],
    };
  }
  if (requestedModel && !configuredModels.some((item) =>
    item.id === requestedModel
    && isModelSelectableForNewRoute(item, { userProvider: provider.source === 'user' }))) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: provider.id,
        model: requestedModel,
        transport,
        status: 'skipped',
        reason: 'model_unavailable',
      }],
    };
  }

  // 自定义供应商目录钉同样钳制到模型声明的输出上限(与 builtin 分支同口径,
  // 见 requestBuiltinProviderText 开头)。Codex 2026-08-06。
  const routeSnapshot = stableSnapshot({
    routing: selectedRouting,
    auth: provider.auth,
    source: provider.source,
  });
  const routeStillCurrent = (): boolean => {
    if (isProviderRouteMutationInProgress(provider.id)) return false;
    if (isProviderModelRouteDisabled(provider.id, model)) return false;
    if (provider.id === 'xd' && isXdGatewayPaymentRequiredRoute(model, agentKind)) return false;
    const currentProvider = getActiveCatalog().providers.find((item) => item.id === provider.id);
    if (!currentProvider || !currentProvider.agents.includes(agentKind)) return false;
    const currentModel = currentProvider.models[agentKind]?.find((item) => item.id === model);
    if (
      !currentModel ||
      !isModelSelectableForNewRoute(currentModel, { userProvider: currentProvider.source === 'user' })
    ) return false;
    return stableSnapshot({
      routing: currentProvider.routing[agentKind],
      auth: currentProvider.auth,
      source: currentProvider.source,
    }) === routeSnapshot;
  };

  const catalogModel = provider.models[agentKind]?.find((m) => m.id === model);
  if (opts.maxTokens !== undefined && catalogModel?.maxOutput !== undefined) {
    opts = { ...opts, maxTokens: Math.min(opts.maxTokens, catalogModel.maxOutput) };
  }

  if (provider.id === 'xd' || provider.id === 'anthropic' || provider.id === 'openai' || provider.id === 'xai') {
    return requestBuiltinProviderText(prompt, {
      provider,
      agentKind,
      model,
      transport,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
      reasoningEffort: opts.reasoningEffort,
      disableReasoning: opts.disableReasoning,
      signal: opts.signal,
      systemPrompt: opts.systemPrompt,
      responseInstructions: opts.responseInstructions,
      beforeDispatch: opts.beforeDispatch,
      routeStillCurrent,
    });
  }

  const routing = provider.routing[agentKind];
  if (routing?.disabled) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: provider.id,
        model,
        transport,
        status: 'skipped',
        reason: 'endpoint_missing',
      }],
    };
  }
  if (
    routing?.authStrategy !== 'api-key-header'
    && routing?.authStrategy !== 'oauth-token'
    && routing?.authStrategy !== 'none'
  ) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{ providerId: provider.id, model, transport, status: 'skipped', reason: 'not_authenticated' }],
    };
  }
  const authStrategy: 'api-key-header' | 'oauth-token' | 'none' = routing.authStrategy;
  if (!routing?.upstream) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{ providerId: provider.id, model, transport, status: 'skipped', reason: 'endpoint_missing' }],
    };
  }
  const isOAuth = authStrategy === 'oauth-token';
  const noAuth = authStrategy === 'none';
  const credential = isOAuth
    ? readCachedGenericOAuthAccessToken(storedCustomProviderId(provider.id), provider.auth.oauth)
    : noAuth
      ? null
      : readCustomProviderKey(provider.id, agentKind);
  const hasLegacyHeaderCredential = (
    authStrategy === 'api-key-header'
    && Object.entries(routing.headerOverride ?? {}).some(([key, value]) => {
      const normalized = key.toLowerCase();
      return (
        (normalized === 'authorization' || normalized === 'x-api-key')
        && value.trim().length > 0
      );
    })
  );
  if (!noAuth && !credential && !hasLegacyHeaderCredential) {
    return {
      ok: false,
      reason: 'no_candidate',
      attempts: [{
        providerId: provider.id,
        model,
        transport,
        status: 'skipped',
        reason: isOAuth ? 'not_authenticated' : 'api_key_missing',
      }],
    };
  }

  const profile: UtilityModelProfile = {
    id: provider.id,
    model,
    transport,
    auth: 'api-key',
    settingsTab: 'providers',
    missingCredentialMessage: 'API key is required for the selected provider.',
  };
  const candidate: UtilityTextCandidate = {
    providerId: provider.id,
    model,
    transport,
    profile,
    execute: (text, requestOpts) => requestCustomProviderText({
      agentKind,
      baseUrl: routing.upstream,
      requestPath: routing.requestPath,
      wireProtocol: routing.wireProtocol,
      headers: routing.headerOverride,
      credential: credential ?? '',
      authStrategy,
      model,
      prompt: text,
      maxTokens: requestOpts?.maxTokens,
      timeoutMs: requestOpts?.timeoutMs,
      reasoningEffort: requestOpts?.reasoningEffort,
      disableReasoning: requestOpts?.disableReasoning,
      signal: requestOpts?.signal,
      systemPrompt: requestOpts?.systemPrompt,
      responseInstructions: requestOpts?.responseInstructions,
      beforeDispatch: requestOpts?.beforeDispatch
        ? () => requestOpts.beforeDispatch!({ providerId: provider.id, agentKind, model })
        : undefined,
      credentialStillCurrent: requestOpts?.beforeDispatch
        ? () => {
            if (noAuth) return true;
            if (isOAuth) {
              return readCachedGenericOAuthAccessToken(
                storedCustomProviderId(provider.id),
                provider.auth.oauth,
              ) === credential;
            }
            return readCustomProviderKey(provider.id, agentKind) === credential;
          }
        : undefined,
      routeStillCurrent: requestOpts?.beforeDispatch ? routeStillCurrent : undefined,
    }),
  };
  return executeCandidates([candidate], prompt, [], opts);
}

function inferProviderAgent(provider: ReturnType<typeof getActiveCatalog>['providers'][number] | undefined): AgentKind | undefined {
  if (!provider) return undefined;
  if (provider.agents.includes('codex')) return 'codex';
  if (provider.agents.includes('claude-code')) return 'claude-code';
  return undefined;
}

/** Matches the xAI bridge capability gate: coding/build variants reject `reasoning`. */
function supportsXaiReasoning(model: string): boolean {
  const normalized = model.replace(/^xai\//, '');
  return !(normalized.startsWith('grok-code') || normalized.startsWith('grok-build'));
}

function cancelledUtilityTextResult(profile: UtilityModelProfile): UtilityTextResult {
  return {
    ok: false,
    reason: 'timeout',
    attempts: [{
      providerId: profile.id,
      model: profile.model,
      transport: profile.transport,
      status: 'failed',
      reason: 'timeout',
    }],
  };
}

// 内置供应商的执行分支只认下面硬编码的 xd/anthropic/openai/xai 四家;钉档
// 清单侧(textOneshotPinOptions.isRoutableForOneshot)按同一集合过滤——新增
// 第五个聊天型内置供应商时两边一起动,否则清单会列出这里接不住的模型。
async function requestBuiltinProviderText(
  prompt: string,
  input: {
    provider: ReturnType<typeof getActiveCatalog>['providers'][number];
    agentKind: AgentKind;
    model: string;
    transport: UtilityModelTransport;
    maxTokens?: number;
    timeoutMs?: number;
    reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
    disableReasoning?: boolean;
    signal?: AbortSignal;
    systemPrompt?: string;
    responseInstructions?: string;
    beforeDispatch?: (route: UtilityTextDispatchRoute) => Promise<boolean>;
    routeStillCurrent?: () => boolean;
  },
): Promise<UtilityTextResult> {
  const profile: UtilityModelProfile = {
    id: input.provider.id,
    model: input.model,
    transport: input.transport,
    auth: input.provider.id === 'xd' ? 'api-key' : 'codex',
    settingsTab: 'providers',
    missingCredentialMessage: 'The selected provider is not authenticated.',
  };
  if (input.signal?.aborted) return cancelledUtilityTextResult(profile);
  const routing = input.provider.routing[input.agentKind];
  if (!routing) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'agent_unavailable')] };
  }
  // 内置供应商同样要尊重 routing.disabled:目录钉指向的 runtime 被停用后,
  // 不应再把 prompt 发过去(与自定义分支 430-431 同一判据,reason 同口径)。
  // Codex 2026-08-06。
  if (routing.disabled) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'endpoint_missing')] };
  }
  // XD catalog entries can lose entitlement after they are selected. Recheck
  // the owner-scoped payment snapshot before resolving credentials or creating
  // an HTTP candidate, matching the profile-chain guard above.
  if (input.provider.id === 'xd' && isXdGatewayPaymentRequiredRoute(input.model, input.agentKind)) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'model_unavailable')] };
  }

  // 插件显式传了 maxTokens 时,钳到该模型目录声明的输出上限(maxOutput),
  // 避免发送超过模型能力的值被 provider 拒绝。缺省(未传)不钳,走模型自然输出。
  const catalogModel = findProviderModel(input.provider, input.agentKind, input.model);
  if (input.maxTokens !== undefined && catalogModel?.maxOutput !== undefined) {
    input = { ...input, maxTokens: Math.min(input.maxTokens, catalogModel.maxOutput) };
  }

  if (input.provider.id === 'xd') {
    const apiKey = readClaudeApiKey();
    const baseUrl = effectiveXdGatewayBaseUrl().trim();
    if (!apiKey) return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'api_key_missing')] };
    if (!baseUrl) return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'endpoint_missing')] };
    return executeCandidates([{
      providerId: input.provider.id,
      model: input.model,
      transport: 'litellm-chat-completions',
      profile,
      execute: (text, requestOpts) => requestProviderHttpText({
        wire: 'chat-completions',
        endpoint: joinProxyPath(baseUrl, '/v1/chat/completions'),
        headers: { Authorization: `Bearer ${apiKey}` },
        model: input.model,
        prompt: text,
        maxTokens: requestOpts?.maxTokens ?? input.maxTokens,
        timeoutMs: requestOpts?.timeoutMs ?? input.timeoutMs,
        reasoningEffort: requestOpts?.reasoningEffort ?? input.reasoningEffort,
        disableReasoning: requestOpts?.disableReasoning ?? input.disableReasoning,
        signal: requestOpts?.signal ?? input.signal,
        systemPrompt: requestOpts?.systemPrompt,
        responseInstructions: requestOpts?.responseInstructions,
        beforeDispatch: requestOpts?.beforeDispatch
          ? () => requestOpts.beforeDispatch!({
              providerId: input.provider.id,
              agentKind: input.agentKind,
              model: input.model,
            })
          : undefined,
        credentialStillCurrent: requestOpts?.beforeDispatch
          ? () => readClaudeApiKey() === apiKey && effectiveXdGatewayBaseUrl().trim() === baseUrl
          : undefined,
        routeStillCurrent: requestOpts?.beforeDispatch ? input.routeStillCurrent : undefined,
      }),
    }], prompt, [], input);
  }

  if (input.provider.id === 'anthropic') {
    const oauth = await getValidClaudeAiOAuth();
    if (input.signal?.aborted) return cancelledUtilityTextResult(profile);
    if (!oauth?.accessToken) {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'not_authenticated')] };
    }
    return executeCandidates([{
      providerId: input.provider.id,
      model: input.model,
      transport: 'litellm-chat-completions',
      profile,
      execute: (text, requestOpts) => requestProviderHttpText({
        wire: 'anthropic-messages',
        endpoint: joinAnthropicMessagesPath(routing.upstream),
        headers: {
          Authorization: `Bearer ${oauth.accessToken}`,
          'anthropic-version': '2023-06-01',
          'anthropic-beta': 'oauth-2025-04-20',
        },
        // 直连 Anthropic API 用目录裸 id;不要复用 toSdkModelString——它会给 1M
        // 目录模型追加 SDK 专用的 [1m] 后缀,/v1/messages 对该串返回 404(#2429)。
        model: toAnthropicApiModelId(input.model),
        prompt: text,
        // Anthropic API 协议必填 max_tokens:缺省时以模型目录声明的 maxOutput
        // (模型自身输出能力)兜底,没有目录条目才回退 81920——宿主不设政策上限。
        maxTokens: requestOpts?.maxTokens ?? input.maxTokens ?? catalogModel?.maxOutput ?? 81_920,
        timeoutMs: requestOpts?.timeoutMs ?? input.timeoutMs,
        reasoningEffort: requestOpts?.reasoningEffort ?? input.reasoningEffort,
        disableReasoning: requestOpts?.disableReasoning ?? input.disableReasoning,
        signal: requestOpts?.signal ?? input.signal,
        systemPrompt: requestOpts?.systemPrompt,
        responseInstructions: requestOpts?.responseInstructions,
        beforeDispatch: requestOpts?.beforeDispatch
          ? () => requestOpts.beforeDispatch!({
              providerId: input.provider.id,
              agentKind: input.agentKind,
              model: input.model,
            })
          : undefined,
        credentialStillCurrent: requestOpts?.beforeDispatch
          ? async () => (await getValidClaudeAiOAuth())?.accessToken === oauth.accessToken
          : undefined,
        routeStillCurrent: requestOpts?.beforeDispatch ? input.routeStillCurrent : undefined,
      }),
    }], prompt, [], input);
  }

  if (input.provider.id === 'openai') {
    let creds: Awaited<ReturnType<typeof getChatgptBridgeAuth>>;
    try {
      creds = await getChatgptBridgeAuth();
    } catch {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'not_authenticated')] };
    }
    if (input.signal?.aborted) return cancelledUtilityTextResult(profile);
    if (!creds.accountId) {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'not_authenticated')] };
    }
    const accountId = creds.accountId;
    return executeCandidates([{
      providerId: input.provider.id,
      model: input.model,
      transport: 'codex-responses',
      profile,
      execute: (text, requestOpts) => requestProviderHttpText({
        wire: 'responses',
        endpoint: joinProxyPath(routing.upstream, '/responses'),
        headers: {
          Authorization: `Bearer ${creds.accessToken}`,
          'chatgpt-account-id': accountId,
          'OpenAI-Beta': 'responses=experimental',
          originator: 'codex_cli_rs',
          session_id: randomUUID(),
          accept: 'text/event-stream',
        },
        model: input.model.replace(/^chatgpt\//, ''),
        prompt: text,
        maxTokens: requestOpts?.maxTokens ?? input.maxTokens,
        timeoutMs: requestOpts?.timeoutMs ?? input.timeoutMs,
        reasoningEffort: requestOpts?.reasoningEffort ?? input.reasoningEffort,
        disableReasoning: requestOpts?.disableReasoning ?? input.disableReasoning,
        // ChatGPT's private Codex Responses endpoint rejects this public API
        // parameter with HTTP 400. The Auto reviewer enforces its own compact
        // output ceiling after the response instead.
        supportsMaxOutputTokens: false,
        signal: requestOpts?.signal ?? input.signal,
        systemPrompt: requestOpts?.systemPrompt,
        responseInstructions: requestOpts?.responseInstructions,
        beforeDispatch: requestOpts?.beforeDispatch
          ? () => requestOpts.beforeDispatch!({
              providerId: input.provider.id,
              agentKind: input.agentKind,
              model: input.model,
            })
          : undefined,
        credentialStillCurrent: requestOpts?.beforeDispatch
          ? async () => {
              try {
                const current = await getChatgptBridgeAuth();
                return current.accountId === accountId && current.accessToken === creds.accessToken;
              } catch {
                return false;
              }
            }
          : undefined,
        routeStillCurrent: requestOpts?.beforeDispatch ? input.routeStillCurrent : undefined,
      }),
    }], prompt, [], input);
  }

  if (input.provider.id === 'xai') {
    let accessToken: string;
    try {
      accessToken = await getGrokAccessToken();
    } catch {
      return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'not_authenticated')] };
    }
    if (input.signal?.aborted) return cancelledUtilityTextResult(profile);
    return executeCandidates([{
      providerId: input.provider.id,
      model: input.model,
      transport: 'codex-responses',
      profile,
      execute: (text, requestOpts) => requestProviderHttpText({
        wire: 'responses',
        endpoint: joinProxyPath(routing.upstream, '/responses'),
        headers: { Authorization: `Bearer ${accessToken}` },
        model: input.model.replace(/^xai\//, ''),
        prompt: text,
        maxTokens: requestOpts?.maxTokens ?? input.maxTokens,
        timeoutMs: requestOpts?.timeoutMs ?? input.timeoutMs,
        reasoningEffort: requestOpts?.reasoningEffort ?? input.reasoningEffort,
        disableReasoning: requestOpts?.disableReasoning ?? input.disableReasoning,
        supportsReasoning: supportsXaiReasoning(input.model),
        signal: requestOpts?.signal ?? input.signal,
        systemPrompt: requestOpts?.systemPrompt,
        responseInstructions: requestOpts?.responseInstructions,
        beforeDispatch: requestOpts?.beforeDispatch
          ? () => requestOpts.beforeDispatch!({
              providerId: input.provider.id,
              agentKind: input.agentKind,
              model: input.model,
            })
          : undefined,
        credentialStillCurrent: requestOpts?.beforeDispatch
          ? async () => {
              try {
                return (await getGrokAccessToken()) === accessToken;
              } catch {
                return false;
              }
            }
          : undefined,
        routeStillCurrent: requestOpts?.beforeDispatch ? input.routeStillCurrent : undefined,
      }),
    }], prompt, [], input);
  }

  return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'agent_unavailable')] };
}

async function executeCandidates(
  candidates: UtilityTextCandidate[],
  prompt: string,
  attempts: UtilityTextAttempt[],
  opts?: UtilityTextRequestOptions,
): Promise<UtilityTextResult> {
  for (const candidate of candidates) {
      // 逐候选执行前按**当前** override 重查(PR #744 review 第二十一轮):前一个
      // 候选失败/超时可能耗时数十秒,期间本候选可能已被停用 —— 不再对其付费下单,
      // 记 model_unavailable 落到下一候选。
      // 本函数只服务显式来源路径(custom / builtin),candidate.providerId 就是目录
      // 供应商 id —— 直接按 (来源, 模型) 查 override,不做 transport 推断:显式
      // anthropic/custom 走 litellm wire、xai 走 responses wire,按 transport 推断
      // 会查到 xd/openai 的 override 上(PR #744 review 第二十二轮)。
      if (isProviderModelRouteDisabled(candidate.providerId, candidate.model)) {
        attempts.push(skippedAttempt(candidate.profile, 'model_unavailable'));
        continue;
      }
    try {
      const text = (await candidate.execute(prompt, opts)).trim();
      if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
      log.info('explicit utility text provider succeeded', {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
      });
      return { ok: true, text, providerId: candidate.providerId, model: candidate.model, transport: candidate.transport };
    } catch (error) {
      const failure = classifyExecutionFailure(error);
      attempts.push(failedAttempt(candidate, failure));
      log.warn('explicit utility text provider failed', {
        providerId: candidate.providerId,
        model: candidate.model,
        transport: candidate.transport,
        reason: failure.reason,
        httpStatus: failure.httpStatus,
      });
    }
  }
  const reason = aggregateFailureReason(attempts.filter((attempt) => attempt.status === 'failed'));
  return { ok: false, reason, attempts };
}

async function resolveCodexCandidate(
  maker: Maker,
  profile: UtilityModelProfile,
): Promise<UtilityTextCandidateResolution> {
  const agentKind: AgentKind = 'codex';
  if (!maker.listAvailableAgents().includes(agentKind)) {
    log.debug('utility text candidate skipped: codex agent unavailable', { providerId: profile.id });
    return { attempt: skippedAttempt(profile, 'agent_unavailable') };
  }
  try {
    const auth = await maker.getAgentAuthState(agentKind);
    if (!auth.authenticated) {
      log.debug('utility text candidate skipped: codex not authenticated', {
        providerId: profile.id,
        reason: auth.errorReason,
      });
      return { attempt: skippedAttempt(profile, 'not_authenticated') };
    }
  } catch (error) {
    log.debug('utility text candidate skipped: codex auth probe failed', {
      providerId: profile.id,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    return { attempt: skippedAttempt(profile, 'auth_probe_failed') };
  }
  return {
    candidate: {
      providerId: profile.id,
      model: profile.model,
      transport: profile.transport,
      profile,
      execute: (prompt, opts) => maker.oneShot(agentKind, prompt, {
        model: profile.model,
        maxTokens: opts?.maxTokens,
        timeoutMs: opts?.timeoutMs,
      }),
    },
  };
}

function resolveLiteLlmCandidate(profile: UtilityModelProfile): UtilityTextCandidateResolution {
  const apiKey = readClaudeApiKey();
  const baseUrl = claudeUpstreamEndpoint().trim();
  if (!apiKey || !baseUrl) {
    log.debug('utility text candidate skipped: LiteLLM credentials missing', {
      providerId: profile.id,
      apiKeyPresent: Boolean(apiKey),
      baseUrlPresent: Boolean(baseUrl),
    });
    return { attempt: skippedAttempt(profile, !apiKey ? 'api_key_missing' : 'endpoint_missing') };
  }
  return {
    candidate: {
      providerId: profile.id,
      model: profile.model,
      transport: profile.transport,
      profile,
      execute: (prompt, opts) => requestLiteLlmText({
        apiKey,
        baseUrl,
        model: profile.model,
        prompt,
        maxTokens: opts?.maxTokens,
        timeoutMs: opts?.timeoutMs,
        reasoningEffort: opts?.reasoningEffort,
        disableReasoning: opts?.disableReasoning,
        signal: opts?.signal,
        routeStillAllowed: () => !isUtilityRoutePaymentRequired(profile),
      }),
    },
  };
}

async function requestLiteLlmText(input: {
  apiKey: string;
  baseUrl: string;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  disableReasoning?: boolean;
  signal?: AbortSignal;
  /** Synchronous owner entitlement fence immediately before the HTTP request. */
  routeStillAllowed?: () => boolean;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 20_000;
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    if (input.routeStillAllowed && !input.routeStillAllowed()) {
      throw new UtilityTextExecutionError({ reason: 'request_failed' });
    }
    const response = await undiciFetch(joinProxyPath(input.baseUrl, '/v1/chat/completions'), {
      method: 'POST',
      signal: controller.signal,
      headers: {
        Authorization: `Bearer ${input.apiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: input.model,
        ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
        ...(input.disableReasoning
          ? { thinking: { type: 'disabled' } }
          : input.reasoningEffort
            ? { reasoning_effort: input.reasoningEffort }
            : {}),
        messages: [{ role: 'user', content: input.prompt }],
      }),
    });
    if (!response.ok) {
      // Do not retain or log upstream response bodies: gateways may echo request
      // metadata, while the HTTP status is sufficient for user recovery.
      await response.body?.cancel().catch(() => undefined);
      throw new UtilityTextExecutionError({ reason: 'http_error', httpStatus: response.status });
    }
    const parsed = await response.json() as {
      choices?: Array<{ message?: { content?: unknown } }>;
    };
    const text = (parsed.choices ?? [])
      .map((choice) => chatCompletionContentText(choice.message?.content))
      .join('')
      .trim();
    if (!text) {
      log.warn('utility text chat-completions empty content', chatCompletionEmptyFingerprint(parsed));
      throw new UtilityTextExecutionError({ reason: 'empty_response' });
    }
    return text;
  } catch (error) {
    if (error instanceof UtilityTextExecutionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UtilityTextExecutionError({ reason: 'timeout' });
    }
    throw new UtilityTextExecutionError({ reason: 'request_failed' });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

type ProviderWire = 'chat-completions' | 'anthropic-messages' | 'responses';

/** Look up runtime-specific metadata without borrowing another agent's model. */
function findProviderModel(
  provider: ReturnType<typeof getActiveCatalog>['providers'][number],
  agentKind: AgentKind,
  model: string,
) {
  return (provider.models[agentKind] ?? []).find((candidate) => candidate.id === model);
}

/**
 * Append an API path to a configured absolute URL while keeping its query
 * parameters in the URL query component. String concatenation would turn a
 * valid `...?tenant=foo` base into a path such as `...?tenant=foo/messages`.
 */
function appendProviderPath(baseUrl: string, suffix: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const normalizedSuffix = `/${suffix.replace(/^\/+|\/+$/g, '')}`;
  const lowerBasePath = basePath.toLowerCase();
  const lowerSuffix = normalizedSuffix.toLowerCase();
  if (lowerBasePath === lowerSuffix || lowerBasePath.endsWith(lowerSuffix)) {
    url.pathname = basePath || normalizedSuffix;
  } else {
    url.pathname = `${basePath}${normalizedSuffix}`;
  }
  // Fragments are client-side only and must not be sent as part of an API URL.
  url.hash = '';
  return url.toString();
}

/**
 * catalog model id → 内置 Anthropic `/v1/messages` 直连请求体的 API model id。
 *
 * `[1m]` 是 Claude Code SDK 的 beta 通道后缀(由 toSdkModelString 按目录
 * contextWindow 追加),不是 Anthropic API 模型名;直连 Messages API 时携带它
 * 会被上游以 404 not_found 拒绝,进而让 Auto-review 持续 fail-closed(#2429)。
 * 该转换仅用于内置 anthropic 直连分支——不对自定义供应商做全局字符串剥离,
 * 部分兼容网关可能把 `[1m]` 作为自己的路由 id。
 */
export function toAnthropicApiModelId(model: string): string {
  return model.endsWith('[1m]') ? model.slice(0, -'[1m]'.length) : model;
}

/** Claude providers may configure either the host root or an existing `/v1` base. */
function joinAnthropicMessagesPath(baseUrl: string): string {
  const url = new URL(baseUrl);
  const basePath = url.pathname.replace(/\/+$/, '');
  const lowerBasePath = basePath.toLowerCase();
  if (lowerBasePath.endsWith('/v1/messages')) {
    url.pathname = basePath || '/v1/messages';
  } else {
    const suffix = /\/v1$/i.test(basePath) ? '/messages' : '/v1/messages';
    url.pathname = `${basePath}${suffix}` || '/v1/messages';
  }
  url.hash = '';
  return url.toString();
}

/**
 * Execute one provider-native request and classify failures without retaining
 * arbitrary upstream response bodies. The wire controls both request shape and
 * response parser; callers remain responsible for provider fallback semantics.
 */
async function requestProviderHttpText(input: {
  wire: ProviderWire;
  endpoint: string;
  headers?: Record<string, string>;
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  disableReasoning?: boolean;
  /** Some coding-specialized models reject their wire's reasoning field. */
  supportsReasoning?: boolean;
  /** Unknown custom routes may reject optional fields from an otherwise compatible wire. */
  retryWithMinimalBodyOnInvalidRequest?: boolean;
  /** Some private Responses-compatible endpoints reject max_output_tokens. */
  supportsMaxOutputTokens?: boolean;
  /** Owning workflow cancellation; linked with the candidate timeout below. */
  signal?: AbortSignal;
  /** Provider-native system text, never concatenated with untrusted reference data. */
  systemPrompt?: string;
  /** Additional output-shape instructions. */
  responseInstructions?: string;
  /** Session/owner/config guard, evaluated immediately before each HTTP dispatch. */
  beforeDispatch?: () => Promise<boolean>;
  /** Re-read the credential captured by the request closure after the async guard. */
  credentialStillCurrent?: () => boolean | Promise<boolean>;
  /** Synchronous catalog/override snapshot guard. */
  routeStillCurrent?: () => boolean;
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 90_000;
  const abortFromParent = () => controller.abort();
  if (input.signal?.aborted) abortFromParent();
  else input.signal?.addEventListener('abort', abortFromParent, { once: true });
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const instructions = [input.systemPrompt, input.responseInstructions]
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .join('\n');
    // Responses-compatible routes do not have a reasoning "off" value. The
    // lowest common supported effort for the subscribed GPT models is `low`;
    // sending `minimal` to GPT-5.4 mini is rejected by ChatGPT with HTTP 400.
    const reasoningEffort = input.disableReasoning
      ? input.wire === 'responses' ? 'low' : 'minimal'
      : input.reasoningEffort;
    const supportsRequestedReasoning = Boolean(
      input.wire !== 'anthropic-messages'
      && reasoningEffort
      && input.supportsReasoning !== false,
    );
    const hasOptionalRequestFields = input.wire === 'responses'
      || input.maxTokens !== undefined
      || input.disableReasoning === true
      || supportsRequestedReasoning;
    const buildBody = (minimal: boolean) => input.wire === 'responses'
      ? {
        model: input.model,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
        ...(instructions ? { instructions } : {}),
        ...(!minimal ? {
          store: false,
          stream: true,
        } : {}),
        ...(!minimal && input.maxTokens !== undefined && input.supportsMaxOutputTokens !== false
          ? { max_output_tokens: input.maxTokens }
          : {}),
        ...(!minimal && supportsRequestedReasoning
          ? { reasoning: { effort: reasoningEffort } }
          : {}),
      }
      : input.wire === 'anthropic-messages'
        ? {
          model: input.model,
          // Anthropic API 协议必填 max_tokens。缺省由调用方以模型目录声明的
          // maxOutput 兜底(模型自身输出能力);81920 只是模型不在目录时的最后
          // 回退,不是宿主承诺的输出上限。
          max_tokens: input.maxTokens ?? 81_920,
          ...(instructions ? { system: instructions } : {}),
          ...(!minimal && input.disableReasoning ? { thinking: { type: 'disabled' } } : {}),
          messages: [{ role: 'user', content: input.prompt }],
        }
        : {
          model: input.model,
          ...(!minimal && input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          ...(!minimal && input.disableReasoning ? { thinking: { type: 'disabled' } } : {}),
          ...(!minimal && supportsRequestedReasoning
            ? { reasoning_effort: reasoningEffort }
            : {}),
          messages: [
            ...(instructions ? [{ role: 'system', content: instructions }] : []),
            { role: 'user', content: input.prompt },
          ],
        };
    const canDispatch = async (): Promise<boolean> => {
      if (input.routeStillCurrent && !input.routeStillCurrent()) return false;
      if (input.beforeDispatch && !(await input.beforeDispatch())) return false;
      if (input.credentialStillCurrent && !(await input.credentialStillCurrent())) return false;
      if (input.routeStillCurrent && !input.routeStillCurrent()) return false;
      if (input.beforeDispatch && !(await input.beforeDispatch())) return false;
      return !input.routeStillCurrent || input.routeStillCurrent();
    };
    const send = async (minimal: boolean) => {
      if (!(await canDispatch())) {
        throw new UtilityTextExecutionError({ reason: 'request_failed' });
      }
      return undiciFetch(input.endpoint, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          ...(input.headers ?? {}),
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(buildBody(minimal)),
      });
    };
    let response = await send(false);
    if (
      !response.ok
      && (response.status === 400 || response.status === 422)
      && input.wire !== 'anthropic-messages'
      && hasOptionalRequestFields
      && input.retryWithMinimalBodyOnInvalidRequest
    ) {
      await response.body?.cancel().catch(() => undefined);
      response = await send(true);
    }
    if (!response.ok) {
      await response.body?.cancel().catch(() => undefined);
      throw new UtilityTextExecutionError({ reason: 'http_error', httpStatus: response.status });
    }

    const raw = await response.text();
    const text = input.wire === 'responses'
      ? parseCodexResponseText(raw)
      : input.wire === 'anthropic-messages'
        ? parseAnthropicResponseText(raw)
        : parseChatCompletionText(raw);
    if (!text) {
      if (input.wire === 'chat-completions') {
        try {
          log.warn('utility text chat-completions empty content', chatCompletionEmptyFingerprint(JSON.parse(raw)));
        } catch {
          // 指纹尽力而为,解析不了就不记。
        }
      }
      throw new UtilityTextExecutionError({ reason: 'empty_response' });
    }
    return text;
  } catch (error) {
    if (error instanceof UtilityTextExecutionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UtilityTextExecutionError({ reason: 'timeout' });
    }
    throw new UtilityTextExecutionError({ reason: 'request_failed' });
  } finally {
    clearTimeout(timeout);
    input.signal?.removeEventListener('abort', abortFromParent);
  }
}

function parseChatCompletionText(raw: string): string {
  try {
    const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    return (json.choices ?? [])
      .map((choice) => chatCompletionContentText(choice.message?.content))
      .join('')
      .trim();
  } catch {
    return '';
  }
}

/**
 * chat-completions 的 message.content 归一:字符串直取;思考模型的 content 可能是
 * parts 数组([{type:'text',text:…}]),只拼正文段——type 为 'text' 或缺省(最老
 * 形态),字符串元素(旧网关偶见)直取。reasoning/thinking/tool_result 等带 text
 * 的非正文段刻意跳过,与顶层 reasoning_content 不取同一立场:思维链不是答案,
 * 拼进去 expectJson 必挂、普通调用被思维链污染。
 */
function chatCompletionContentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (typeof part !== 'object' || part === null) return '';
        const type = (part as { type?: unknown }).type;
        if (type !== undefined && type !== 'text') return '';
        const text = (part as { text?: unknown }).text;
        return typeof text === 'string' ? text : '';
      })
      .join('');
  }
  return '';
}

/**
 * 2xx 但取不到正文时的结构指纹:只记形状(content 类型/finish_reason/字段名),
 * 不记内容——错误响应体可能回显请求元数据,模型正文不落盘全文。
 * (2026-08-05 实证:deepseek-v4-flash 这类思考模型 200 空 content → empty_response,
 * 没有指纹时无从区分"思考烧光预算"与"返回结构不认"。)
 */
function chatCompletionEmptyFingerprint(parsed: unknown): Record<string, unknown> {
  if (typeof parsed !== 'object' || parsed === null) return { shape: 'non-object' };
  const choices = (parsed as { choices?: unknown }).choices;
  if (!Array.isArray(choices) || choices.length === 0) {
    return { shape: 'no-choices', topKeys: Object.keys(parsed).slice(0, 8) };
  }
  const first = choices[0] as { message?: unknown; finish_reason?: unknown };
  const message = (
    typeof first?.message === 'object' && first.message !== null ? first.message : {}
  ) as Record<string, unknown>;
  const content = message.content;
  return {
    contentType: Array.isArray(content) ? 'array' : content === null ? 'null' : typeof content,
    contentPartTypes: Array.isArray(content)
      ? content
          .slice(0, 6)
          .map((part) => (typeof part === 'object' && part !== null ? (part as { type?: unknown }).type : typeof part))
      : undefined,
    hasReasoningContent: typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0,
    finishReason: first?.finish_reason,
    messageKeys: Object.keys(message).slice(0, 8),
  };
}

/** Direct request for a user provider runtime selected by the schedule. */
async function requestCustomProviderText(input: {
  agentKind: AgentKind;
  baseUrl: string;
  requestPath?: string;
  wireProtocol?: 'anthropic-messages' | 'openai-responses' | 'openai-chat';
  headers?: Record<string, string>;
  credential: string;
  authStrategy: 'api-key-header' | 'oauth-token' | 'none';
  model: string;
  prompt: string;
  maxTokens?: number;
  timeoutMs?: number;
  reasoningEffort?: 'minimal' | 'low' | 'medium' | 'high';
  disableReasoning?: boolean;
  signal?: AbortSignal;
  systemPrompt?: string;
  responseInstructions?: string;
  beforeDispatch?: () => Promise<boolean>;
  credentialStillCurrent?: () => boolean | Promise<boolean>;
  routeStillCurrent?: () => boolean;
}): Promise<string> {
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    'Content-Type': 'application/json',
  };
  const wire: ProviderWire =
    input.agentKind === 'claude-code' || input.wireProtocol === 'anthropic-messages'
      ? 'anthropic-messages'
      : input.wireProtocol === 'openai-chat'
        ? 'chat-completions'
        : 'responses';
  // safeStorage 有当前凭证时覆盖历史 header；没有时仅 api-key 策略允许保留旧版
  // header-only 配置，以便用户升级后继续可用。OAuth 与 none 仍必须清掉复制进来的凭证头。
  const preserveLegacyApiKeyHeaders =
    input.authStrategy === 'api-key-header' && input.credential.length === 0;
  if (!preserveLegacyApiKeyHeaders) {
    for (const key of Object.keys(headers)) {
      const normalized = key.toLowerCase();
      if (normalized === 'x-api-key' || normalized === 'authorization') delete headers[key];
    }
  }
  if (input.credential) {
    headers.Authorization = `Bearer ${input.credential}`;
    if (wire === 'anthropic-messages' && input.authStrategy === 'api-key-header') {
      headers['x-api-key'] = input.credential;
    }
  }
  if (wire === 'anthropic-messages') {
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
  }
  return requestProviderHttpText({
    wire,
    endpoint: input.requestPath
      ? appendProviderRequestPath(input.baseUrl, input.requestPath)
      : wire === 'responses'
        ? joinProxyPath(input.baseUrl, '/responses')
        : wire === 'chat-completions'
          ? joinProxyPath(input.baseUrl, '/chat/completions')
          : joinAnthropicMessagesPath(input.baseUrl),
    headers,
    model: input.model,
    prompt: input.prompt,
    maxTokens: input.maxTokens,
    timeoutMs: input.timeoutMs,
    reasoningEffort: input.reasoningEffort,
    disableReasoning: input.disableReasoning,
    retryWithMinimalBodyOnInvalidRequest: true,
    signal: input.signal,
    systemPrompt: input.systemPrompt,
    responseInstructions: input.responseInstructions,
    beforeDispatch: input.beforeDispatch,
    credentialStillCurrent: input.credentialStillCurrent,
    routeStillCurrent: input.routeStillCurrent,
  });
}

function parseCodexResponseText(raw: string): string {
  // Responses-compatible gateways may return either SSE (the normal Codex
  // shape) or a buffered JSON response in test/dev deployments.
  if (raw.trimStart().startsWith('{')) {
    try {
      const json = JSON.parse(raw) as { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
      if (typeof json.output_text === 'string') return json.output_text.trim();
      return (json.output ?? [])
        .flatMap((item) => item.content ?? [])
        .map((part) => typeof part.text === 'string' ? part.text : '')
        .join('')
        .trim();
    } catch {
      return '';
    }
  }
  let delta = '';
  let final = '';
  for (const line of raw.split('\n')) {
    if (!line.startsWith('data:')) continue;
    const payload = line.slice(5).trim();
    if (!payload || payload === '[DONE]') continue;
    try {
      const event = JSON.parse(payload) as {
        type?: string;
        delta?: string;
        response?: { output_text?: unknown; output?: Array<{ content?: Array<{ text?: unknown }> }> };
      };
      if (event.type === 'response.output_text.delta' && typeof event.delta === 'string') delta += event.delta;
      if (event.type === 'response.completed' && event.response) {
        if (typeof event.response.output_text === 'string') final = event.response.output_text;
        else {
          final = (event.response.output ?? [])
            .flatMap((item) => item.content ?? [])
            .map((part) => typeof part.text === 'string' ? part.text : '')
            .join('');
        }
      }
    } catch {
      // Ignore keepalive / malformed SSE lines; the final empty check is fail-closed.
    }
  }
  return (final || delta).trim();
}

function parseAnthropicResponseText(raw: string): string {
  try {
    const json = JSON.parse(raw) as { content?: Array<{ type?: string; text?: unknown }> };
    return (json.content ?? [])
      .filter((part) => part.type === 'text')
      .map((part) => typeof part.text === 'string' ? part.text : '')
      .join('')
      .trim();
  } catch {
    return '';
  }
}

/** Build a safe diagnostic entry for a profile skipped before execution. */
function skippedAttempt(
  profile: UtilityModelProfile,
  reason: Extract<UtilityTextAttemptReason,
    | 'unsupported_transport'
    | 'agent_unavailable'
    | 'model_unavailable'
    | 'not_authenticated'
    | 'auth_probe_failed'
    | 'api_key_missing'
    | 'endpoint_missing'>,
): UtilityTextAttempt {
  return {
    providerId: profile.id,
    model: profile.model,
    transport: profile.transport,
    status: 'skipped',
    reason,
  };
}

/** Classify candidate failures without exposing arbitrary exception messages. */
function classifyExecutionFailure(error: unknown): UtilityTextExecutionFailure {
  if (error instanceof UtilityTextExecutionError) {
    return error.failure;
  }
  if (error instanceof Error && (error.name === 'AbortError' || /timed?\s*out|timeout/i.test(error.message))) {
    return { reason: 'timeout' };
  }
  return { reason: 'request_failed' };
}

/** Attach HTTP status only to the matching discriminated-union branch. */
function failedAttempt(
  candidate: UtilityTextCandidate,
  failure: UtilityTextExecutionFailure,
): UtilityTextAttempt {
  const base = {
    providerId: candidate.providerId,
    model: candidate.model,
    transport: candidate.transport,
    status: 'failed' as const,
  };
  return failure.reason === 'http_error'
    ? { ...base, reason: failure.reason, httpStatus: failure.httpStatus }
    : { ...base, reason: failure.reason };
}

/** Collapse homogeneous terminal failures while preserving per-candidate attempts. */
function aggregateFailureReason(failedAttempts: UtilityTextAttempt[]): UtilityTextFailureReason {
  if (failedAttempts.length > 0 && failedAttempts.every((attempt) => attempt.reason === 'empty_response')) {
    return 'empty_response';
  }
  if (failedAttempts.length > 0 && failedAttempts.every((attempt) => attempt.reason === 'timeout')) {
    return 'timeout';
  }
  return 'all_candidates_failed';
}

function joinProxyPath(baseUrl: string, suffix: string): string {
  return appendProviderPath(baseUrl, suffix);
}
