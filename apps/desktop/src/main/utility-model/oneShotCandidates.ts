import { randomUUID } from 'node:crypto';

import { fetch as undiciFetch } from 'undici';

import { toSdkModelString, type AgentKind, type Maker } from '@cindy/maker-core';
import { appendProviderRequestPath } from '@cindy/model-providers';

import { createLogger } from '../logger.js';
import { readClaudeApiKey } from '../maker-host/auth-adapters.js';
import { getChatgptBridgeAuth } from '../maker-host/anthropic-responses-bridge-host.js';
import { getValidClaudeAiOAuth } from '../maker-host/claude-oauth-refresh.js';
import { getGrokAccessToken } from '../maker-host/grok-oauth-login.js';
import { readCachedGenericOAuthAccessToken } from '../maker-host/generic-oauth.js';
import { claudeUpstreamEndpoint } from '../maker-host/runtime-configs.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import { effectiveXdGatewayBaseUrl } from '../model-access/effectiveEndpoint.js';
import { readCustomProviderKey } from '../secrets/providerSecretStore.js';
import { getUtilityModelChainProfiles } from './UtilityModelSelection.js';
import type { UtilityModelProfile, UtilityModelTransport } from '../../shared/utilityModelProfiles.js';
import type {
  UtilityTextAttempt,
  UtilityTextAttemptReason,
  UtilityTextFailureReason,
  UtilityTextResult,
} from '../../shared/utilityTextResult.js';

const log = createLogger('utility-model:one-shot');

export type UtilityTextCapability = {
  transports: readonly UtilityModelTransport[];
};

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
  /** 显式任务来源；存在时禁止跨来源 fallback。 */
  providerId?: string;
  agentKind?: AgentKind;
  model?: string;
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
async function resolveUtilityTextCandidates(
  maker: Maker,
  capability: UtilityTextCapability,
): Promise<{ candidates: UtilityTextCandidate[]; attempts: UtilityTextAttempt[] }> {
  const profiles = getUtilityModelChainProfiles();
  const candidates: UtilityTextCandidate[] = [];
  const attempts: UtilityTextAttempt[] = [];
  for (const profile of profiles) {
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

/** Older remote/mobile callers may omit providerId; a model unique to one
 * non-XD provider is still enough to preserve the selected route. */
function inferUniqueProviderId(agentKind: AgentKind | undefined, model: string | undefined): string | undefined {
  const normalizedModel = model?.trim();
  if (!agentKind || !normalizedModel) return undefined;
  const matches = getActiveCatalog().providers.filter((provider) =>
    provider.agents.includes(agentKind)
    && (provider.models[agentKind] ?? []).some((candidate) => candidate.id === normalizedModel),
  );
  const nonXd = matches.filter((provider) => provider.id !== 'xd');
  if (nonXd.length === 1) return nonXd[0]?.id;
  return matches.length === 1 ? matches[0]?.id : undefined;
}

async function requestDefaultUtilityText(
  maker: Maker,
  prompt: string,
  opts?: UtilityTextRequestOptions & { capability?: UtilityTextCapability },
): Promise<UtilityTextResult> {
  const { candidates, attempts } = await resolveUtilityTextCandidates(
    maker,
    opts?.capability ?? { transports: ['codex-responses', 'litellm-chat-completions'] },
  );
  if (candidates.length === 0) {
    return { ok: false, reason: 'no_candidate', attempts };
  }

  for (const candidate of candidates) {
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
  const reason = aggregateFailureReason(attempts.filter((attempt) => attempt.status === 'failed'));
  log.warn('all utility text candidates failed', { reason, attempts: attempts.length });
  return { ok: false, reason, attempts };
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
  const model = requestedModel || configuredModels[0]?.id || '';
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
  if (requestedModel && !configuredModels.some((item) => item.id === requestedModel)) {
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

  if (provider.source !== 'user') {
    return requestBuiltinProviderText(prompt, {
      provider,
      agentKind,
      model,
      transport,
      maxTokens: opts.maxTokens,
      timeoutMs: opts.timeoutMs,
    });
  }

  const routing = provider.routing[agentKind];
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
    ? readCachedGenericOAuthAccessToken(provider.id, provider.auth.oauth)
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

async function requestBuiltinProviderText(
  prompt: string,
  input: {
    provider: ReturnType<typeof getActiveCatalog>['providers'][number];
    agentKind: AgentKind;
    model: string;
    transport: UtilityModelTransport;
    maxTokens?: number;
    timeoutMs?: number;
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
  const routing = input.provider.routing[input.agentKind];
  if (!routing) {
    return { ok: false, reason: 'no_candidate', attempts: [skippedAttempt(profile, 'agent_unavailable')] };
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
      }),
    }], prompt, [], input);
  }

  if (input.provider.id === 'anthropic') {
    const oauth = await getValidClaudeAiOAuth();
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
        model: toSdkModelString(input.model, findProviderModel(input.provider, input.agentKind, input.model)?.contextWindow),
        prompt: text,
        maxTokens: requestOpts?.maxTokens ?? input.maxTokens,
        timeoutMs: requestOpts?.timeoutMs ?? input.timeoutMs,
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
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 20_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
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
    const text = parsed.choices
      ?.map((choice) => typeof choice.message?.content === 'string' ? choice.message.content : '')
      .join('')
      .trim() ?? '';
    if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
    return text;
  } catch (error) {
    if (error instanceof UtilityTextExecutionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UtilityTextExecutionError({ reason: 'timeout' });
    }
    throw new UtilityTextExecutionError({ reason: 'request_failed' });
  } finally {
    clearTimeout(timeout);
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
}): Promise<string> {
  const controller = new AbortController();
  const timeoutMs = input.timeoutMs ?? 90_000;
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const body = input.wire === 'responses'
      ? {
        model: input.model,
        input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: input.prompt }] }],
        tools: [],
        tool_choice: 'auto',
        parallel_tool_calls: false,
        store: false,
        stream: true,
      }
      : input.wire === 'anthropic-messages'
        ? {
          model: input.model,
          max_tokens: input.maxTokens ?? 4096,
          messages: [{ role: 'user', content: input.prompt }],
        }
        : {
          model: input.model,
          ...(input.maxTokens !== undefined ? { max_tokens: input.maxTokens } : {}),
          messages: [{ role: 'user', content: input.prompt }],
        };
    const response = await undiciFetch(input.endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        ...(input.headers ?? {}),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
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
    if (!text) throw new UtilityTextExecutionError({ reason: 'empty_response' });
    return text;
  } catch (error) {
    if (error instanceof UtilityTextExecutionError) throw error;
    if (error instanceof Error && error.name === 'AbortError') {
      throw new UtilityTextExecutionError({ reason: 'timeout' });
    }
    throw new UtilityTextExecutionError({ reason: 'request_failed' });
  } finally {
    clearTimeout(timeout);
  }
}

function parseChatCompletionText(raw: string): string {
  try {
    const json = JSON.parse(raw) as { choices?: Array<{ message?: { content?: unknown } }> };
    return (json.choices ?? [])
      .map((choice) => typeof choice.message?.content === 'string' ? choice.message.content : '')
      .join('')
      .trim();
  } catch {
    return '';
  }
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
}): Promise<string> {
  const headers: Record<string, string> = {
    ...(input.headers ?? {}),
    'Content-Type': 'application/json',
  };
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
    if (input.agentKind === 'claude-code' && input.authStrategy === 'api-key-header') {
      headers['x-api-key'] = input.credential;
    }
  }
  if (input.agentKind === 'claude-code') {
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
  }
  const wire: ProviderWire =
    input.agentKind === 'claude-code'
      ? 'anthropic-messages'
      : input.wireProtocol === 'openai-chat'
        ? 'chat-completions'
        : 'responses';
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
