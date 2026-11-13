import { issueModelSourceSnapshot, modelSourceRequestSignature, stampRecoveredModelSources } from './model-source-snapshots.js';
import { copilotModelsRequest, resolveCopilotAccountUrl } from './copilot-account-url.js';
import { collectModelDiscoveryPages } from './model-discovery-pages.js';
import { ModelSourceRecoveryCanceled } from './model-source-revalidation.js';
import type { DiscoveredModel } from '@cindy/model-providers';
/**
 * provider-model-fetch —— 供应商「获取模型列表」（自定义供应商表单消费）。
 *
 * 设计要点：
 *   - 与 OAuth 自动发现（generic-oauth.discoverGenericOAuthModels）同一套端点推导
 *     （`deriveModelsDiscoveryUrl`）与响应解析（`parseModelsListResponse`），差异只在
 *     鉴权：本模块吃表单透传的 API key（不落盘），头组合对齐 provider-diagnostics
 *     的 `buildProbeRequest`（cc 同时带 x-api-key + Bearer + anthropic-version，codex 只带 Bearer）。
 *   - 查询型结构化返回（规则 13 例外条款，同 test-connection）：renderer 需要 code
 *     渲染 providerError.* 分类文案。
 *   - fetch 可注入（单测不联网）。
 */

import {
  isLoopbackProviderUrl,
  isOpenRouterModelsUrl,
  type AgentKind,
  type ProviderWireProtocol,
  type Provider,
} from '@cindy/model-providers';

import { classifyProviderError, type ProviderErrorCode } from '../../shared/providerErrors.js';
import {
  deriveModelsDiscoveryUrl,
  readCachedGenericOAuthAccessToken,
  refreshGenericOAuthIfNeeded,
  type GenericOAuthRefreshResult,
} from './generic-oauth.desktop.js';
import { outboundFetch } from './outbound-fetch.desktop.js';

/** 拉取超时（与 test-connection 探测同量级）。 */
const FETCH_TIMEOUT_MS = 10_000;
/** 失败响应体最多读取的字节数（分类只看前几 KB）。 */
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const INVALID_DISCOVERY_URL = 'model discovery requires HTTP(S) URLs without embedded credentials';

// Share only an in-flight Hinoki HTTP read, not parsed models or agent-bound
// provenance receipts. Every caller keeps its own parsing/error policy below.
const hinokiReads = new WeakMap<typeof fetch, Map<string, {
  response: Promise<Response>;
  consumers: number;
}>>();

async function fetchModelsResponse(url: string, init: RequestInit, fetchImpl: typeof fetch): Promise<Response> {
  if (url !== 'https://inference.hinoki.security/v1/models') return fetchImpl(url, init);
  let reads = hinokiReads.get(fetchImpl);
  if (!reads) { reads = new Map(); hinokiReads.set(fetchImpl, reads); }
  // The existing process-local HMAC includes all effective headers (including
  // credentials) without retaining plaintext keys in the map key. Never share
  // across redirect policies or injected transport/credential-owner closures.
  const signature = `${modelSourceRequestSignature(url, init)}:${init.redirect ?? 'follow'}`;
  let read = reads.get(signature);
  if (!read) {
    read = { response: Promise.resolve().then(() => fetchImpl(url, init)), consumers: 0 };
    reads.set(signature, read);
  }
  read.consumers++;
  try {
    return (await read.response).clone();
  } finally {
    if (--read.consumers === 0) {
      reads.delete(signature);
      // Each consumer owns a clone. Release the unused original branch without
      // awaiting stream tee cancellation, which waits for the clones to finish.
      void read.response.then(response => response.body?.cancel().catch(() => undefined), () => undefined);
    }
  }
}

/** 一次「获取模型列表」的完整参数（表单值内存透传，不落盘）。 */
export interface ProviderModelsFetchSpec {
  /** Add-flow callers distinguish an empty directory from an invalid response. */
  allowEmpty?: boolean;
  agent: AgentKind;
  /** 上游 wire protocol；用于区分 Codex 原生 OpenAI 与 Anthropic Messages 桥。 */
  wireProtocol?: ProviderWireProtocol;
  baseUrl: string;
  /** 表单态鉴权方式；main IPC 用它强制 none 只访问 loopback。 */
  authMethod?: 'apiKey' | 'oauth' | 'none';
  /** 显式列模型端点（预设 / 配置的 modelsUrl）；缺省由 baseUrl 推导 `…/v1/models`。 */
  modelsUrl?: string | null;
  /** 用户 API key；缺省 = 不注入鉴权头（端点可能靠自定义 headers 鉴权）。 */
  apiKey?: string | null;
  /** 附加请求头（自定义供应商的 headers 配置）。 */
  headers?: Record<string, string>;
  /**
   * 已保存自定义供应商 id：给出时 main 侧按 (id, agent) 读取已存的 main-only 鉴权请求头
   * 并并入 `headers`，无需 renderer 回读明文头（headers 是 main-only 密文，见
   * isRendererAccessibleSafeStorageKey）。仅用于“刷新模型”复用已存请求头鉴权的端点。
   */
  savedProviderId?: string;
  /** Main-only import constraints; ordinary settings discovery keeps its existing policy. */
  redirect?: 'error';
  responseByteLimit?: number;
  /** Main-only: partial pages must not authorize removal of saved provenance. */
  requireComplete?: boolean;
  /** Main-only background recovery: freshness stamp without a Settings receipt. */
  sourceRecovery?: boolean;
  /** Main-only owner/generation/provider/credential revision, for in-flight sharing. */
  sourceRecoveryScope?: string;
  /** Main-only: acquire a discovery slot after identical recovery reads join. */
  scheduleSourceRecovery?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** 结构化结果（查询型返回：renderer 需要 code 渲染分类文案，不走 throwIpcError）。 */
export interface ProviderModelsFetchResult {
  ok: boolean;
  /** Main-only recovery hint, absolute milliseconds since epoch. */
  retryAt?: number;
  /** 拉到的模型清单（ok=true 时给出；已按 id 去重;contextWindow 为端点声明的上下文长度,尽力提取）。 */
  models?: DiscoveredModel[];
  /** 失败分类码（ok=false 时给出）。 */
  code?: ProviderErrorCode;
  /** HTTP 状态码（网络层失败时缺省）。 */
  status?: number;
  /** 上游原始信息摘要（详情展开用，UI 主文案走 i18n）。 */
  detail?: string;
}

// Coalesce token refreshes before scheduling, just like model reads. Only
// in-flight work is retained; owner/generation/credentials and descriptor bind it.
const sourceRecoveryOAuthRefreshes = new Map<string, Promise<void | GenericOAuthRefreshResult>>();

/** Refresh a saved OAuth connection using only Main's route and credential snapshot. */
export async function fetchSavedOAuthProviderModels(
  provider: Provider | undefined,
  agent: AgentKind,
  storageProviderId: string,
  isCurrent: () => boolean,
  fetchImpl: typeof fetch = outboundFetch,
  headers?: Record<string, string>,
  options: Pick<ProviderModelsFetchSpec, 'requireComplete' | 'sourceRecovery' | 'sourceRecoveryScope' | 'scheduleSourceRecovery'> = {},
): Promise<ProviderModelsFetchResult> {
  const oauth = provider?.auth.oauth;
  const route = provider?.routing[agent];
  if (options.sourceRecovery && !isCurrent()) throw new ModelSourceRecoveryCanceled();
  if (provider?.source !== 'user' || provider.auth.method !== 'oauth' || !oauth || !route || route.disabled || !isCurrent()) {
    return { ok: false, code: 'AUTH_INVALID' };
  }
  let refreshResult: void | GenericOAuthRefreshResult;
  try {
    const refresh = async () => {
      if (options.sourceRecovery && !isCurrent()) throw new ModelSourceRecoveryCanceled();
      return refreshGenericOAuthIfNeeded(storageProviderId, oauth);
    };
    if (options.sourceRecovery && options.scheduleSourceRecovery) {
      const signature = modelSourceRequestSignature(JSON.stringify([options.sourceRecoveryScope, storageProviderId, oauth]), {});
      // An absent owner scope cannot authorize sharing across callers.
      if (!options.sourceRecoveryScope) refreshResult = await options.scheduleSourceRecovery(refresh);
      else {
        let pending = sourceRecoveryOAuthRefreshes.get(signature);
        if (!pending) {
          pending = options.scheduleSourceRecovery(refresh);
          sourceRecoveryOAuthRefreshes.set(signature, pending);
        }
        try { refreshResult = await pending; } finally {
          if (sourceRecoveryOAuthRefreshes.get(signature) === pending) sourceRecoveryOAuthRefreshes.delete(signature);
        }
      }
    } else refreshResult = await refresh();
  } catch (error) {
    if (error instanceof ModelSourceRecoveryCanceled) throw error;
    return { ok: false, code: 'UNKNOWN' };
  }
  // Preserve token-endpoint deadlines even after same-owner generation expiry.
  // The revalidator independently rejects changed owner/credential contexts.
  if (options.sourceRecovery && refreshResult?.retryAt) {
    return { ok: false, code: 'UNKNOWN', retryAt: refreshResult.retryAt };
  }
  // A token refresh can outlive logout, account switching, or edits to this connection.
  // Never use the old endpoint snapshot with credentials from the new owner/configuration.
  if (!isCurrent()) {
    if (options.sourceRecovery) throw new ModelSourceRecoveryCanceled();
    return { ok: false, code: 'AUTH_INVALID' };
  }
  // Recovery already awaited its bounded refresh. A failed refresh must not
  // trigger another unscheduled attempt through the ordinary hot-path reader.
  const token = readCachedGenericOAuthAccessToken(storageProviderId, options.sourceRecovery ? undefined : oauth);
  if (!token) return { ok: false, code: 'AUTH_INVALID' };
  const modelsUrl = route.modelsUrl ?? oauth.modelsDiscoveryUrl;
  const result = await fetchProviderModels({
    agent,
    baseUrl: resolveCopilotAccountUrl(route.upstream, token),
    modelsUrl: modelsUrl ? resolveCopilotAccountUrl(modelsUrl, token) : modelsUrl,
    wireProtocol: route.wireProtocol,
    authMethod: 'oauth',
    apiKey: token,
    headers,
    redirect: 'error',
    ...options,
  }, async (url, init) => {
    // Pagination and the separate speech catalog may run after the first reply.
    // Revoke the captured credentials before another request if ownership changed.
    if (!isCurrent()) throw new Error('Provider model refresh is no longer current');
    return fetchImpl(url, init);
  });
  if (isCurrent()) return result;
  // Never accept stale models. A failed recovery can still carry a server
  // deadline; the revalidator separately checks owner, request and credentials.
  return { ok: false, code: 'AUTH_INVALID',
    ...(options.sourceRecovery && !result.ok && result.retryAt ? { retryAt: result.retryAt } : {}),
  };
}

/** origin 不含 userinfo；先独立验证地址，错误中不带原始 URL 或解析器异常。 */
function parseModelsFetchUrl(value: string): URL {
  try {
    const url = new URL(value);
    if ((url.protocol === 'http:' || url.protocol === 'https:') && !url.username && !url.password) {
      return url;
    }
  } catch {
    // URL 解析器的异常可能包含凭据，只返回固定的校验说明。
  }
  throw new Error(INVALID_DISCOVERY_URL);
}

function withoutCredentialHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== 'authorization' && lower !== 'x-api-key' && lower !== 'xi-api-key' && lower !== 'x-goog-api-key') normalized[lower] = value;
  }
  return normalized;
}

function normalizedHeaders(headers: Record<string, string> | undefined): Record<string, string> {
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers ?? {})) {
    normalized[name.toLowerCase()] = value;
  }
  return normalized;
}

/** 构造列模型请求（纯函数，单测直断言）。鉴权头组合与 buildProbeRequest 同口径。 */
export function buildModelsFetchRequest(spec: ProviderModelsFetchSpec): {
  url: string;
  init: RequestInit;
} {
  const baseUrl = parseModelsFetchUrl(spec.baseUrl);
  const explicit = spec.modelsUrl?.trim();
  const modelsUrl = explicit ? parseModelsFetchUrl(explicit) : null;
  // Google's saved compatibility entry is an inference endpoint, not its catalog.
  // Resolve discovery independently, after Main has selected this connection's credentials.
  // The old bundled /openai/models address is normalized too. Other explicit
  // discovery URLs and private proxies remain user-owned.
  const googleCatalog = (!explicit || /^https:\/\/generativelanguage\.googleapis\.com\/v1(?:beta)?\/openai\/models\/?$/.test(explicit)) && baseUrl.origin === 'https://generativelanguage.googleapis.com'
    && /^\/v1(?:beta)?(?:\/openai)?\/?$/.test(baseUrl.pathname);
  const googleProtocol = googleCatalog || spec.wireProtocol === 'google-generative-ai';
  const configuredDiscoveryUrl = googleCatalog
    ? `${baseUrl.origin}${baseUrl.pathname.replace(/\/openai\/?$/, '').replace(/\/+$/, '')}/models`
    : explicit && modelsUrl?.origin === baseUrl.origin
    ? explicit : spec.wireProtocol === 'google-generative-ai'
      ? `${spec.baseUrl.replace(/\/+$/, '')}/models` : deriveModelsDiscoveryUrl(spec.baseUrl);
  const copilot = copilotModelsRequest(configuredDiscoveryUrl);
  const discoveryUrl = copilot?.url ?? configuredDiscoveryUrl;
  const mustStripCredentialHeaders =
    !!spec.apiKey || spec.authMethod === 'none' || spec.authMethod === 'oauth';
  const headers: Record<string, string> = mustStripCredentialHeaders
    ? withoutCredentialHeaders(spec.headers)
    : normalizedHeaders(spec.headers);
  const anthropicMessages =
    spec.wireProtocol === 'anthropic-messages' ||
    (spec.wireProtocol === undefined && spec.agent === 'claude-code');
  const discoveryEndpoint = new URL(discoveryUrl);
  const longcatOpenAiCatalog = discoveryEndpoint.origin === 'https://api.longcat.chat'
    && discoveryEndpoint.pathname.replace(/\/+$/, '') === '/openai/v1/models';
  if (copilot) {
    Object.assign(headers, copilot.headers);
    delete headers['anthropic-version'];
    delete headers['anthropic-beta'];
    delete headers['x-api-key'];
    if (spec.apiKey) headers.authorization = `Bearer ${spec.apiKey}`;
  } else if (discoveryEndpoint.origin === 'https://api.elevenlabs.io'
    && discoveryEndpoint.pathname.replace(/\/+$/, '') === '/v1/models') {
    // ElevenLabs discovery uses xi-api-key, independently of the chat runtime slot.
    delete headers.authorization;
    delete headers['x-api-key'];
    delete headers['anthropic-version'];
    delete headers['anthropic-beta'];
    if (spec.apiKey) headers['xi-api-key'] = spec.apiKey;
  } else if (isOpenRouterModelsUrl(discoveryUrl) || longcatOpenAiCatalog) {
    // Discovery is provider-specific, not the generation harness's wire format.
    // OpenRouter's Anthropic view rewrites IDs and defaults to only 20 results.
    // LongCat explicitly shares its OpenAI catalog with the Messages runtime.
    const discoveryKey = spec.apiKey ?? (longcatOpenAiCatalog && !headers.authorization ? headers['x-api-key'] : undefined);
    delete headers['anthropic-version'];
    delete headers['anthropic-beta'];
    delete headers['x-api-key'];
    if (discoveryKey) headers['authorization'] = `Bearer ${discoveryKey}`;
  } else if (googleProtocol) {
    if (spec.apiKey) headers['x-goog-api-key'] = spec.apiKey;
  } else if (anthropicMessages) {
    // Anthropic wire 的所有端点（含 GET /v1/models）都要求 anthropic-version，缺失直接 400。
    headers['anthropic-version'] = headers['anthropic-version'] ?? '2023-06-01';
    if (spec.apiKey) {
      headers['x-api-key'] = spec.apiKey;
      // `buildLocalHandlerHeaders` 已把 agent 自带凭证替换为 Provider-owned key。
      // 同时发送标准 Anthropic x-api-key 与兼容网关常用的 Bearer，和真实会话保持一致。
      headers['authorization'] = `Bearer ${spec.apiKey}`;
    }
  } else if (spec.apiKey) {
    headers['authorization'] = `Bearer ${spec.apiKey}`;
  }
  // modelsUrl 是用户不可见的隐藏字段（预设/配置快照）。只有与 baseUrl 同源才采用——
  // 防止用户改了 baseUrl 后，key 仍被发往快照里的旧主机 / 被降级成明文（现有预设全部同源）。
  return {
    url: discoveryUrl,
    init: { method: 'GET', headers, ...(spec.redirect ? { redirect: spec.redirect } : {}) },
  };
}

/** 从 Error（fetch 抛出）提取网络层错误码（同 provider-diagnostics）。 */
function networkErrorCode(err: unknown): string {
  if (err instanceof Error) {
    if (err.name === 'TimeoutError' || err.name === 'AbortError') return err.name;
    const cause = (err as { cause?: { code?: unknown } }).cause;
    if (cause && typeof cause.code === 'string') return cause.code;
    return err.name || 'UNKNOWN_NETWORK_ERROR';
  }
  return 'UNKNOWN_NETWORK_ERROR';
}

/** Count decoded stream bytes before buffering/parsing, including missing or false length headers. */
async function readLimitedBody(res: Response, limit: number, budget?: { remaining: number }): Promise<string> {
  limit = Math.min(limit, budget?.remaining ?? Infinity);
  if (Number(res.headers.get('content-length')) > limit) {
    await res.body?.cancel().catch(() => undefined);
    throw new Error('models response exceeds byte limit');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (budget) budget.remaining -= value.byteLength;
      if (total > limit) throw new Error('models response exceeds byte limit');
      chunks.push(value);
    }
    return Buffer.concat(chunks, total).toString('utf8');
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

/** 拉一次模型列表并分类结果。fetch 可注入（单测）。 */
const sourceRecoveryReads = new Map<string, Promise<ProviderModelsFetchResult>>();

export async function fetchProviderModels(
  spec: ProviderModelsFetchSpec,
  fetchImpl: typeof fetch = outboundFetch,
): Promise<ProviderModelsFetchResult> {
  if (
    spec.authMethod === 'none' &&
    (!isLoopbackProviderUrl(spec.baseUrl) ||
      (!!spec.modelsUrl?.trim() && !isLoopbackProviderUrl(spec.modelsUrl.trim())))
  ) {
    return {
      ok: false,
      code: 'UNKNOWN',
      detail: 'no-auth provider model discovery requires loopback URLs',
    };
  }
  let request: ReturnType<typeof buildModelsFetchRequest>;
  try {
    request = buildModelsFetchRequest(spec);
  } catch {
    return { ok: false, code: 'UNKNOWN', detail: INVALID_DISCOVERY_URL };
  }
  const read = () => fetchProviderModelsRequest(spec, fetchImpl, request);
  const scheduleRead = () => spec.sourceRecovery && spec.scheduleSourceRecovery
    ? spec.scheduleSourceRecovery(read) : read();
  if (!spec.sourceRecovery || !spec.sourceRecoveryScope) return scheduleRead();
  // Only background results are agent-independent; Settings receipts never share.
  // Hash the effective wire request, not runtime metadata, and retain it only in flight.
  const signature = modelSourceRequestSignature(JSON.stringify([spec.sourceRecoveryScope, request.url,
    request.init.method, request.init.redirect, spec.allowEmpty, spec.requireComplete, spec.responseByteLimit]), request.init);
  let pending = sourceRecoveryReads.get(signature);
  if (!pending) {
    pending = scheduleRead();
    sourceRecoveryReads.set(signature, pending);
  }
  try { return await pending; } finally {
    if (sourceRecoveryReads.get(signature) === pending) sourceRecoveryReads.delete(signature);
  }
}

async function fetchProviderModelsRequest(
  spec: ProviderModelsFetchSpec, fetchImpl: typeof fetch, request: ReturnType<typeof buildModelsFetchRequest>,
): Promise<ProviderModelsFetchResult> {
  const responseByteLimit = spec.responseByteLimit ?? (spec.requireComplete ? 8 * 1024 * 1024 : undefined);
  // Strict recovery shares one decoded-byte allowance across the whole catalog,
  // including auxiliary lists. Ordinary imports retain their per-page policy.
  const budget = spec.requireComplete ? { remaining: responseByteLimit! } : undefined;
  const { url, init } = request;
  let retryAt: number | undefined;
  const captureRetryAfter = (response: Response) => {
    if (!spec.requireComplete) return;
    if (response.status !== 429 && response.status !== 503) return;
    const value = response.headers.get('retry-after')?.trim();
    if (!value) return;
    const deadline = /^\d+$/.test(value) ? Date.now() + Number(value) * 1000 : Date.parse(value);
    if (Number.isFinite(deadline) && deadline > Date.now()) retryAt = Math.max(retryAt ?? 0, deadline);
  };
  let res: Response;
  try {
    res = await fetchModelsResponse(url, { ...init, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) }, fetchImpl);
  } catch (err) {
    const cls = classifyProviderError({ networkErrorCode: networkErrorCode(err) });
    return { ok: false, code: cls.code, detail: cls.detail };
  }
  if (!res.ok) {
    captureRetryAfter(res);
    // A configured Codex manifest may be unavailable on older compatible gateways.
    // Retry only the same endpoint without its manifest selector; never retry auth failures.
    const ordinaryUrl = new URL(url);
    if ((res.status === 404 || res.status === 405) && ordinaryUrl.searchParams.has('client_version')) {
      await res.body?.cancel().catch(() => undefined);
      ordinaryUrl.searchParams.delete('client_version');
      // This is still the same discovery: retain its slot through fallback,
      // just as for pagination. Re-entering the scheduler can deadlock all slots.
      return fetchProviderModelsRequest(spec, fetchImpl, { url: ordinaryUrl.toString(), init });
    }
    let bodyText = '';
    try {
      bodyText = responseByteLimit === undefined
        ? (await res.text()).slice(0, MAX_ERROR_BODY_BYTES)
        : await readLimitedBody(res, Math.min(responseByteLimit, MAX_ERROR_BODY_BYTES), budget);
    } catch {
      /* 读体失败按空体分类 */
    }
    const cls = classifyProviderError({ status: res.status, bodyText });
    return { ok: false, code: cls.code, status: res.status, detail: cls.detail, ...(retryAt ? { retryAt } : {}) };
  }
  let json: unknown;
  try {
    json = responseByteLimit === undefined
      ? await res.json()
      : JSON.parse(await readLimitedBody(res, responseByteLimit, budget));
  } catch {
    return {
      ok: false,
      code: 'UNKNOWN',
      status: res.status,
      detail: 'models response is not JSON or exceeds the response limit',
    };
  }
  const pageDeadline = Date.now() + 30_000;
  const models = await collectModelDiscoveryPages(json, url, async nextUrl => {
    if (Date.now() >= pageDeadline) throw new Error('catalog deadline exceeded');
    if (budget && budget.remaining <= 0) throw new Error('catalog byte budget exhausted');
    const page = await fetchImpl(nextUrl, { ...init, redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.min(FETCH_TIMEOUT_MS, pageDeadline - Date.now()))) });
    if (!page.ok) { captureRetryAfter(page); await page.body?.cancel(); throw new Error('catalog page failed'); }
    return JSON.parse(await readLimitedBody(page, responseByteLimit ?? 8 * 1024 * 1024, budget));
  }, { requireComplete: spec.requireComplete });
  // These exact OpenAI-compatible catalog views can legitimately be empty. Keep
  // that success distinct in every consumer (wizard, edit and saved refresh),
  // without treating an error envelope as an empty catalog or an account grant.
  const emptyCatalogAllowed = url === 'https://ollama.com/v1/models'
    || url === 'https://inference.hinoki.security/v1/models';
  const catalogError = emptyCatalogAllowed && json !== null && typeof json === 'object'
    && 'error' in json && json.error != null && json.error !== '';
  // The parser can drop invalid members; only an originally empty data array is empty success.
  const rawCatalogEmpty = emptyCatalogAllowed && json !== null && typeof json === 'object'
    && 'data' in json && Array.isArray(json.data) && json.data.length === 0;
  // Magpie's enabled-model catalog can be empty. Identify the gateway rather
  // than guessing from a user-editable port/name; never send credentials to hello.
  let magpieEmpty = false;
  const endpoint = new URL(url);
  if (models?.length === 0 && !spec.allowEmpty && !emptyCatalogAllowed
    && endpoint.pathname === '/v1/models' && !endpoint.search
    && json !== null && typeof json === 'object' && !Array.isArray(json)
    && 'data' in json && Array.isArray(json.data) && json.data.length === 0
    && (!('error' in json) || json.error == null || json.error === '')
    && (!('error_code' in json) || json.error_code === 0)) {
    try {
      const hello = await fetchImpl(new URL('/api/hello', endpoint).toString(), {
        method: 'GET', redirect: 'error', signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (hello.ok) {
        const identity = JSON.parse(await readLimitedBody(hello, 16 * 1024));
        magpieEmpty = identity?.name === 'magpie' && !identity.error;
      } else await hello.body?.cancel();
    } catch { /* An unconfirmed gateway keeps the existing conservative result. */ }
  }
  if (!models || catalogError || (models.length === 0 && (emptyCatalogAllowed ? !rawCatalogEmpty : !spec.allowEmpty && !magpieEmpty))) {
    // 端点 200 但响应不是可识别的模型列表（或为空）——按「模型不存在」类引导用户手填。
    return {
      ok: false,
      code: 'UNKNOWN',
      status: res.status,
      detail: 'no models found in response',
      ...(retryAt ? { retryAt } : {}),
    };
  }
  return { ok: true, models: spec.sourceRecovery ? stampRecoveredModelSources(models)
    : issueModelSourceSnapshot(models, spec.agent, modelSourceRequestSignature(url, init)) };
}
