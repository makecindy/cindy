/**
 * Desktop 端 codex-proxy 生命周期管理 ——
 *
 * 负责为 Codex API 模式启动一个本地 loopback 代理,把产品级 system prompt
 * 从 codex thread history 里的 developerInstructions 挪到每次 Responses 请求的
 * 顶层 instructions 尾部。这样 prompt 不落历史,compact / cold resume 后仍能
 * 每请求重注入,也不会在未 compact resume 窗口重复 developer message。
 *
 * Layer 2 只提供 standalone 基础设施:
 *   - 启动 / 关闭 proxy
 *   - 按 threadId 注册已拼好的五段 prompt
 *
 * maker-core AgentDeps 接线、spawn 时记录 per-host active、session close cleanup 都在后续层做。
 */

import {
  createAnthropicCompatProxy,
  createActiveStripTransform,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createInstructionsInjectionTransform,
  createInstructionsRegistry,
  stripEncryptedContentFromBody,
  stripImageGenerationItemsWithoutIdFromBody,
  stripNonAnthropicFields,
  type ProxyHandle,
  type ResponseObserver,
  type ResponseObserverCtx,
  type RequestTransform,
  type RequestTransformCtx,
  type RoutingDecision,
  type RoutingTransform,
} from '@cindy/anthropic-compat-proxy';
import {
  createResponsesChatHandler,
  type ChatBridgeCapabilities,
} from '@cindy/responses-chat-bridge';
import fs from 'node:fs';
import path from 'node:path';

import { buildCodexGatewayBaseUrl, CODEX_OAUTH_UPSTREAM } from './codex-gateway-config.js';
import { getActiveCatalog } from './active-catalog.js';
import {
  gatewayDefaultRouteDecision,
  getSessionRoutingDescriptor,
  resolveSessionRoute,
  resolveSessionRouteDecision,
  buildLocalHandlerHeaders,
  inferProviderIdForModel,
  isHostInjectedAuthSession,
  isUserProviderSession,
  getUserProviderIdForSession,
  providerRoutingServesWireModel,
  resolveImplicitProviderOAuthRouteDecision,
  resolveProviderOAuthControlRouteDecision,
  rewriteImplicitModelIdForRoute,
  rewriteSessionModelIdForRoute,
} from './provider-route.js';
import { getSessionProvider } from './session-provider-store.js';
import { composeResponseObservers } from './claude-rate-limit-headers-observer.js';
import { createProviderUpstreamErrorObserver, reportProviderUpstreamError } from './provider-upstream-error-observer.js';
import { encryptedStripController, imageGenerationStripController } from './thread-strip-controllers.js';
import { createMakerLogger } from './logger-adapter.js';
import { resolveDesktopOutboundProxy } from './outbound-proxy-resolver.js';
import { readSilentEncryptedRetrySettings } from './silent-encrypted-retry-store.js';
import { getLogDir } from '../logger.js';
import { recordXaiRateLimitSnapshot } from '../usageBroadcaster.js';

// scope = 'codex-proxy'。保持独立 scope,方便后续 E2E 日志脚本按 codex proxy 过滤。
const log = createMakerLogger('codex-proxy');

const registry = createInstructionsRegistry();
const sessionToThread = new Map<string, string>();
const threadToSession = new Map<string, string>();

let _handle: ProxyHandle | null = null;
let _startPromise: Promise<void> | null = null;
let _disposeGeneration = 0;
let dumpSeq = 0;

const CODEX_RESPONSE_OBSERVER_MAX_BYTES = 2 * 1024 * 1024;

// codex 走 Responses API,每轮**全量重发**整个 thread 历史;导入的存量长会话
// (贴图 base64 + 加密 reasoning blob,字节数膨胀远快于 token 数)单次请求体可以
// 轻松越过 proxy 默认的 32MB —— 原生 codex 直连上游没有这道闸,曾导致导入会话
// 每轮报 "stream disconnected before completion" 且无日志(2026-07 实踩)。
// 放宽到 128MB 恢复与原生 codex 的对等;仍保留上限防内存被打爆(body 会整段
// 缓冲 + JSON.parse,该值同时是单请求的内存 / 解析停顿预算)。
const CODEX_PROXY_MAX_REQUEST_BODY_BYTES = 128 * 1024 * 1024;

export type CodexProxyAuthInjection = 'oauth-bearer' | 'env-key' | 'provider-oauth';

// proxy 路线 spawn 鉴权模式: codex 当前带的是 OAuth token(requires_openai_auth)还是 gateway key(env_key)。
// index.ts prepareCodexExtraSpawnConfig 在每次 spawn 前按本次会话 credentialMode set; routingTransform 据此决策。
// null 表示当前还没有本地 Codex app-server route 被 spawn 冻结;renderer 读 runtime route 时会按当前
// OAuth/API 状态合成展示口径,避免启动后未 spawn 前把 OAuth 用户误判成 env-key。
let _codexAuthInjection: CodexProxyAuthInjection | null = null;

/** spawn codex 前由 host 调用, 记录本次 codex 进程带的是 OAuth token 还是 gateway key。 */
export function setCodexProxyAuthInjection(mode: CodexProxyAuthInjection): void {
  _codexAuthInjection = mode;
}

/** 清掉当前本地 Codex app-server spawn-time 路由;下次 createHost 前会重新 set。 */
export function clearCodexProxyAuthInjection(): void {
  _codexAuthInjection = null;
}

/** 返回当前本地 Codex app-server spawn 时固定下来的鉴权注入方式;null 表示尚未 spawn。 */
export function getCodexProxyAuthInjectionState(): CodexProxyAuthInjection | null {
  return _codexAuthInjection;
}

/** 返回 proxy routing 使用的鉴权注入方式;未 spawn 时保守按 env-key 处理。 */
export function getCodexProxyAuthInjection(): CodexProxyAuthInjection {
  return _codexAuthInjection ?? 'env-key';
}

// gateway api key reader —— 由 host 注入(readClaudeApiKey), 避免 codex-proxy-host 直接 import
// auth-adapters(重模块, 会拖累单测加载 / 埋循环依赖)。proxy 给骨折 / api 流量换 gateway key 时调它。
let _readGatewayKey: () => string | null = () => null;
export function setCodexProxyGatewayKeyReader(fn: () => string | null): void {
  _readGatewayKey = fn;
}

function headerValue(headers: Readonly<Record<string, string>>, name: string): string {
  const direct = headers[name];
  if (typeof direct === 'string' && direct.trim()) return direct.trim();
  const lower = name.toLowerCase();
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === lower && value.trim()) return value.trim();
  }
  return '';
}

function selectedThreadIdFromHeaders(headers: Readonly<Record<string, string>>): string {
  return headerValue(headers, 'thread-id') ||
    headerValue(headers, 'x-client-request-id') ||
    'unknown';
}

function safeDumpName(threadId: string): string {
  return threadId.replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
}

function writeTransformedBodyDump(ctx: RequestTransformCtx, body: unknown): void {
  const logDir = getLogDir();
  if (!logDir) {
    log.warn('codex proxy transformed body dump skipped because log dir is not initialized');
    return;
  }

  const threadId = selectedThreadIdFromHeaders(ctx.headers);
  dumpSeq += 1;
  const seq = dumpSeq;
  const dumpDir = path.join(logDir, 'codex-proxy-dumps');
  const dumpPath = path.join(dumpDir, `${safeDumpName(threadId)}-${String(seq).padStart(6, '0')}.json`);

  try {
    fs.mkdirSync(dumpDir, { recursive: true });
    fs.writeFileSync(
      dumpPath,
      JSON.stringify({
        seq,
        threadId,
        method: ctx.method,
        url: ctx.url,
        body,
      }, null, 2),
      'utf8',
    );
  } catch (err) {
    log.warn('codex proxy transformed body dump failed', {
      threadId,
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

function createCodexTransform(): RequestTransform {
  return createInstructionsInjectionTransform({ registry, logger: log });
}

function sessionIdFromTransformCtx(ctx: RequestTransformCtx): string | undefined {
  const threadId = selectedThreadIdFromHeaders(ctx.headers);
  return threadId ? threadToSession.get(threadId) : undefined;
}

// 通用 Chat Completions 上游(DeepSeek/GLM/Kimi 等非 OpenAI o-series)的兼容默认。
// 依据 cc-switch / opencodex 的 per-provider 处理归纳:
//   - maxTokensField='max_tokens':只有 OpenAI o-series 用 max_completion_tokens,国产厂商用 max_tokens;
//   - toolCallReasoningPlaceholder:思考模型要求 tool_call assistant 消息带非空 reasoning_content;
//   - forceAutoToolChoice:思考模型拒绝强制 tool_choice(DeepSeek reasoner)。
const CHAT_BRIDGE_DEFAULT_CAPABILITIES: ChatBridgeCapabilities = {
  developerRole: 'system',
  parallelToolCalls: true,
  maxTokensField: 'max_tokens',
  reasoningField: 'none',
  streamUsage: true,
  toolCallReasoningPlaceholder: true,
  forceAutoToolChoice: true,
};

/**
 * Chat bridge 上游只收 host 明确构造的 header。绝不把 Codex/ChatGPT 请求 header
 * 原样透传，防止账号 id、OpenAI OAuth bearer 或内部 session 元数据泄漏给第三方。
 */
function createChatBridgeDecision(
  route: Awaited<ReturnType<typeof resolveSessionRoute>>,
  instructions: string | undefined,
): RoutingDecision | null {
  if (!route || route.routing.wireProtocol !== 'openai-chat') return null;
  const { headers } = buildLocalHandlerHeaders(route, 'codex');
  const stripPrefix = route.routing.modelIdRewrite?.stripPrefix;
  // localHandler 绕过 proxy 的 responseObserver,自定义(user)供应商的上游错误不会被
  // createProviderUpstreamErrorObserver 看到。这里显式把非 2xx 上游错误喂回同一广播通道,
  // 让 Chat 桥接会话与透明自定义供应商一样弹结构化 providerError.* 提示。内置来源不广播
  // (与 observer 的 user-only 语义一致)。
  const providerId = route.providerId;
  const providerName = getActiveCatalog().providers.find((p) => p.id === providerId)?.name ?? providerId;
  const onUpstreamError = route.providerSource === 'user'
    ? ({ status, body }: { status: number; body: string }): void => {
        reportProviderUpstreamError({ agent: 'codex', providerId, providerName, status, bodyText: body });
      }
    : undefined;
  const handler = createResponsesChatHandler({
    upstreamBase: route.routing.upstream,
    buildHeaders: async () => headers,
    rewriteModel: (model: string) => stripPrefix && model.startsWith(stripPrefix)
      ? model.slice(stripPrefix.length)
      : model,
    capabilities: CHAT_BRIDGE_DEFAULT_CAPABILITIES,
    ...(onUpstreamError ? { onUpstreamError } : {}),
  }, { logger: log });
  return {
    localHandler: ({ rawBody, parsedBody, res }) => {
      let body = parsedBody;
      const strippedBody = stripImageGenerationItemsWithoutIdFromBody(rawBody);
      if (strippedBody) {
        try {
          body = JSON.parse(strippedBody.toString('utf8'));
        } catch {
          // Keep the already parsed body if the defensive strip result cannot be parsed.
        }
      }
      if (instructions && isPlainObject(body)) {
        const existing = typeof body.instructions === 'string' ? body.instructions : '';
        body = {
          ...body,
          instructions: existing.includes(instructions)
            ? existing
            : [existing, instructions].filter(Boolean).join('\n\n'),
        };
      }
      // localHandler 在 transform 链**之前**执行(引擎按路由决策短路),跨来源恢复的
      // 加密压缩块不会被 createCrossProviderCompactionCompatTransform 处理;而 bridge
      // 的翻译层遇到 compaction 项会按不支持的输入 400(Greptile P1 第二轮)。Chat
      // bridge 目标上游定义上永远不是 ChatGPT,这里无条件做同一份替换。
      const compactionSafe = replaceEncryptedCompactionItems(body);
      if (compactionSafe) {
        log.info('replaced encrypted compaction history for chat-bridge upstream', {
          providerId,
          upstreamBase: route.routing.upstream,
        });
        body = compactionSafe;
      }
      return handler.handle({ parsedBody: body, res });
    },
  };
}

function moveInstructionsIntoInput(body: Record<string, unknown>): Record<string, unknown> | null {
  const instructions = body.instructions;
  if (typeof instructions !== 'string' || instructions.length === 0) return null;
  // xAI Responses examples/API schema carry system prompt through input messages, not top-level instructions.
  const systemMessage = { type: 'message', role: 'system', content: instructions };
  const next: Record<string, unknown> = { ...body };
  delete next.instructions;

  if (Array.isArray(body.input)) {
    next.input = [systemMessage, ...body.input];
    return next;
  }
  if (typeof body.input === 'string') {
    next.input = [systemMessage, { role: 'user', content: body.input }];
    return next;
  }
  if (body.input === undefined || body.input === null) {
    next.input = [systemMessage];
    return next;
  }
  log.warn('xAI Codex request has non-standard input while moving instructions', {
    inputType: typeof body.input,
  });
  next.input = [systemMessage, body.input];
  return next;
}

function xaiRealModelId(model: unknown): string | null {
  if (typeof model !== 'string' || model.length === 0) return null;
  return model.startsWith('xai/') ? model.slice('xai/'.length) : model;
}

function supportsXaiReasoning(model: string | null): boolean {
  if (!model) return true;
  const xaiProvider = getActiveCatalog().providers.find((provider) => provider.id === 'xai');
  const namespacedModel = `xai/${model}`;
  const catalogModel = (xaiProvider?.models.codex ?? []).find((candidate) => candidate.id === namespacedModel);
  return (catalogModel?.efforts.length ?? 0) > 0;
}

function stripUnsupportedXaiReasoning(body: Record<string, unknown>): Record<string, unknown> | null {
  if (supportsXaiReasoning(xaiRealModelId(body.model))) return null;

  let changed = false;
  const next: Record<string, unknown> = { ...body };
  if ('reasoning' in next) {
    delete next.reasoning;
    changed = true;
  }
  return changed ? next : null;
}

function isXaiUnsupportedInputItem(item: unknown, opts: { supportsReasoning: boolean }): boolean {
  if (!isPlainObject(item) || typeof item.type !== 'string') return false;
  if (item.type === 'reasoning') {
    return !opts.supportsReasoning || typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0;
  }
  return item.type.startsWith('image_generation') ||
    item.type.startsWith('imageGeneration');
}

/**
 * Codex code-mode / app-server 历史里会回放 `custom_tool_call*`，且 tool output 常是
 * `[{type:"input_text",text}]` 数组。xAI Responses 的 untagged `ModelInput` 只认
 * message / function_call / function_call_output / reasoning 等标准变体；原样转发会 422:
 * "data did not match any variant of untagged enum ModelInput"。
 * 仅在 xAI 路由里把这些历史 item 归一成 xAI 可反序列化的 function_call 形态。
 */
function textFromResponsesContent(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value == null) return '';
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === 'string') return part;
        if (!isPlainObject(part)) return '';
        if (typeof part.text === 'string') return part.text;
        if (typeof part.input_text === 'string') return part.input_text;
        if (typeof part.output_text === 'string') return part.output_text;
        return '';
      })
      .filter((part) => part.length > 0)
      .join('\n');
  }
  if (isPlainObject(value)) {
    if (typeof value.text === 'string') return value.text;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function argumentsFromCustomToolInput(value: unknown): string {
  if (value == null) return '{}';

  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return JSON.stringify(isPlainObject(parsed) ? parsed : { input: parsed });
    } catch {
      return JSON.stringify({ input: value });
    }
  }

  try {
    return JSON.stringify(isPlainObject(value) ? value : { input: value });
  } catch {
    return JSON.stringify({ input: String(value) });
  }
}

function normalizeXaiInputItem(item: unknown): { item: unknown; changed: boolean } {
  if (!isPlainObject(item)) {
    return { item, changed: false };
  }

  // EasyInput 兼容:只有 role/content、缺 type 的 message 先补 type。
  const base: Record<string, unknown> = (!('type' in item) && typeof item.role === 'string' && 'content' in item)
    ? { type: 'message', ...item }
    : item;
  const typedFromEasy = base !== item;
  const type = typeof base.type === 'string' ? base.type : undefined;

  if (type === 'custom_tool_call') {
    const name = typeof base.name === 'string' ? base.name : '';
    const callId = typeof base.call_id === 'string'
      ? base.call_id
      : (typeof base.id === 'string' ? base.id : '');
    const next: Record<string, unknown> = {
      type: 'function_call',
      name,
      arguments: argumentsFromCustomToolInput(base.input),
      call_id: callId,
    };
    if (typeof base.id === 'string') next.id = base.id;
    return { item: next, changed: true };
  }

  if (type === 'custom_tool_call_output') {
    return {
      item: {
        type: 'function_call_output',
        call_id: typeof base.call_id === 'string' ? base.call_id : '',
        output: textFromResponsesContent(base.output),
      },
      changed: true,
    };
  }

  if (type === 'function_call') {
    const normalizedArguments = argumentsFromCustomToolInput(base.arguments);
    const next: Record<string, unknown> = {
      type: 'function_call',
      name: typeof base.name === 'string' ? base.name : '',
      arguments: normalizedArguments,
      call_id: typeof base.call_id === 'string'
        ? base.call_id
        : (typeof base.id === 'string' ? base.id : ''),
    };
    if (typeof base.id === 'string') next.id = base.id;
    const changed = typedFromEasy
      || normalizedArguments !== base.arguments
      || typeof base.call_id !== 'string'
      || typeof base.name !== 'string'
      || 'status' in base
      || Object.keys(base).some((key) => !['type', 'name', 'arguments', 'call_id', 'id'].includes(key));
    return changed ? { item: next, changed: true } : { item: base, changed: false };
  }

  if (type === 'function_call_output') {
    const next: Record<string, unknown> = {
      type: 'function_call_output',
      call_id: typeof base.call_id === 'string' ? base.call_id : '',
      output: typeof base.output === 'string' ? base.output : textFromResponsesContent(base.output),
    };
    const changed = typedFromEasy
      || typeof base.output !== 'string'
      || typeof base.call_id !== 'string'
      || Object.keys(base).some((key) => !['type', 'call_id', 'output'].includes(key));
    return changed ? { item: next, changed: true } : { item: base, changed: false };
  }

  if (type === 'message') {
    let changed = typedFromEasy;
    const next: Record<string, unknown> = { type: 'message' };
    const role = base.role === 'developer' ? 'system' : base.role;
    if (role !== base.role) changed = true;
    if (typeof role === 'string') next.role = role;
    if ('content' in base) next.content = base.content;
    if (typeof base.id === 'string') next.id = base.id;
    for (const key of Object.keys(base)) {
      if (key === 'type' || key === 'role' || key === 'content' || key === 'id') continue;
      // phase / internal_* / 其它扩展键一律丢掉。
      changed = true;
    }
    // content part 只保留 text 类;缺 type 的纯文本 part 补 input_text。
    if (Array.isArray(next.content)) {
      const parts: unknown[] = [];
      for (const part of next.content) {
        if (typeof part === 'string') {
          parts.push({ type: 'input_text', text: part });
          changed = true;
          continue;
        }
        if (!isPlainObject(part)) {
          changed = true;
          continue;
        }
        const partType = typeof part.type === 'string' ? part.type : undefined;
        if (partType === 'text') {
          parts.push({ type: role === 'assistant' ? 'output_text' : 'input_text', text: typeof part.text === 'string' ? part.text : '' });
          changed = true;
          continue;
        }
        if (partType === 'input_text' || partType === 'output_text') {
          parts.push({ type: partType, text: typeof part.text === 'string' ? part.text : '' });
          if (Object.keys(part).some((k) => k !== 'type' && k !== 'text')) changed = true;
          continue;
        }
        if (partType === 'input_image') {
          const imageUrl = typeof part.image_url === 'string' ? part.image_url : undefined;
          if (imageUrl) parts.push({ type: 'input_image', image_url: imageUrl });
          else changed = true;
          if (Object.keys(part).some((k) => k !== 'type' && k !== 'image_url')) changed = true;
          continue;
        }
        changed = true;
      }
      next.content = parts;
    } else if (typeof next.content !== 'string') {
      // 非法 content → 降级空字符串,避免整个 ModelInput 反序列化失败。
      next.content = textFromResponsesContent(next.content);
      changed = true;
    }
    return changed ? { item: next, changed: true } : { item: base, changed: false };
  }

  return { item: base, changed: typedFromEasy };
}

function normalizeXaiInputItems(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.input)) return null;

  // xAI supports encrypted reasoning replay, but not Codex/OpenAI image replay items in `input[]`.
  // Codex custom_tool_call* must also be rewritten before xAI's ModelInput deserialize.
  const supportsReasoning = supportsXaiReasoning(xaiRealModelId(body.model));
  let changed = false;
  const input: unknown[] = [];
  for (const raw of body.input) {
    if (isXaiUnsupportedInputItem(raw, { supportsReasoning })) {
      changed = true;
      continue;
    }
    const normalized = normalizeXaiInputItem(raw);
    if (normalized.changed) changed = true;
    input.push(normalized.item);
  }
  if (!changed) return null;

  return { ...body, input };
}

const XAI_SUPPORTED_TOOL_TYPES = new Set([
  'function',
  'web_search',
  'x_search',
  'collections_search',
  'file_search',
  'code_execution',
  'code_interpreter',
  'mcp',
  'shell',
]);

function sanitizeXaiTools(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: unknown[] = [];
  for (const tool of body.tools) {
    if (!isPlainObject(tool) || typeof tool.type !== 'string' || !XAI_SUPPORTED_TOOL_TYPES.has(tool.type)) {
      changed = true;
      continue;
    }
    if (tool.type === 'web_search') {
      const nextTool: Record<string, unknown> = { type: 'web_search' };
      for (const key of ['filters', 'enable_image_understanding', 'enable_image_search']) {
        if (key in tool) nextTool[key] = tool[key];
      }
      if (Object.keys(nextTool).length !== Object.keys(tool).length) changed = true;
      tools.push(nextTool);
      continue;
    }
    tools.push(tool);
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) next.tools = tools;
  else delete next.tools;
  return next;
}

/**
 * ByteDance Seed accepts standard function tools and web search. Codex also
 * emits namespaced and other built-in descriptors that Volcengine rejects
 * before the request reaches the model. Its web-search descriptor must also
 * be reduced to the standard shape: Codex's `external_web_access` extension
 * is rejected as an unknown field.
 */
function isByteDanceSeedModel(model: unknown): boolean {
  return typeof model === 'string' && model.startsWith('bytedance-seed/');
}

function seedToolChoiceReferencesRemovedTool(
  toolChoice: unknown,
  tools: Record<string, unknown>[],
): boolean {
  if (!isPlainObject(toolChoice) || typeof toolChoice.type !== 'string') return false;

  return !tools.some((tool) => {
    if (tool.type !== toolChoice.type) return false;
    if (toolChoice.type !== 'function') return true;
    return typeof toolChoice.name === 'string' && tool.name === toolChoice.name;
  });
}

function sanitizeByteDanceSeedTools(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!isByteDanceSeedModel(body.model) || !Array.isArray(body.tools)) return null;

  let changed = false;
  const tools: Record<string, unknown>[] = [];
  for (const tool of body.tools) {
    if (!isPlainObject(tool)) {
      changed = true;
      continue;
    }
    if (tool.type === 'function') {
      tools.push(tool);
      continue;
    }
    if (tool.type === 'web_search') {
      // Seed cannot represent Codex's cache-only search policy. Dropping the
      // tool preserves the caller's explicit prohibition on live web access.
      if (tool.external_web_access === false) {
        changed = true;
        continue;
      }
      tools.push({ type: 'web_search' });
      if (Object.keys(tool).length !== 1) changed = true;
      continue;
    }
    changed = true;
  }
  if (!changed) return null;

  const next: Record<string, unknown> = { ...body };
  if (tools.length > 0) {
    next.tools = tools;
    if (seedToolChoiceReferencesRemovedTool(next.tool_choice, tools)) next.tool_choice = 'auto';
  } else {
    delete next.tools;
    delete next.tool_choice;
    delete next.parallel_tool_calls;
  }
  return next;
}

/** Volcengine requires replayed assistant messages to carry their output status. */
function normalizeByteDanceSeedInput(body: Record<string, unknown>): Record<string, unknown> | null {
  if (!isByteDanceSeedModel(body.model) || !Array.isArray(body.input)) return null;

  let changed = false;
  const input = body.input.map((item) => {
    if (
      !isPlainObject(item) ||
      item.type !== 'message' ||
      item.role !== 'assistant' ||
      typeof item.status === 'string'
    ) {
      return item;
    }
    changed = true;
    return { ...item, status: 'completed' };
  });
  return changed ? { ...body, input } : null;
}

function createByteDanceSeedResponsesCompatTransform(): RequestTransform {
  return (body) => {
    if (!isPlainObject(body)) return null;
    let changed = false;
    let current = body;
    const withSanitizedTools = sanitizeByteDanceSeedTools(current);
    if (withSanitizedTools) {
      current = withSanitizedTools;
      changed = true;
    }
    const withNormalizedInput = normalizeByteDanceSeedInput(current);
    if (withNormalizedInput) {
      current = withNormalizedInput;
      changed = true;
    }
    return changed ? current : null;
  };
}

function createXaiResponsesCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body)) return null;
    const sessionId = sessionIdFromTransformCtx(ctx);
    const explicitProviderId = sessionId ? getSessionProvider(sessionId) : null;
    const inferredProviderId =
      explicitProviderId ?? (typeof body.model === 'string' ? inferProviderIdForModel(body.model, 'codex') : null);
    if (inferredProviderId !== 'xai') return null;
    // 与路由的 scope 门同源:xai 会话里非 xai/ 前缀的请求会被 resolveSessionRouteDecision
    // 放回默认路由(ChatGPT/网关),body 不能再按 xAI 语义改写(挪 instructions / 剥
    // reasoning 会破坏默认上游的请求),transform 是否生效必须与路由是否捕获一致。
    const wireModel = typeof body.model === 'string' ? body.model : undefined;
    if (!providerRoutingServesWireModel('xai', 'codex', wireModel)) return null;
    let changed = false;
    let current = moveInstructionsIntoInput(body);
    if (current) changed = true;
    else current = body;

    const withSanitizedTools = sanitizeXaiTools(current);
    if (withSanitizedTools) {
      current = withSanitizedTools;
      changed = true;
    }

    const withoutUnsupportedReasoning = stripUnsupportedXaiReasoning(current);
    if (withoutUnsupportedReasoning) {
      current = withoutUnsupportedReasoning;
      changed = true;
    }

    const withNormalizedInputItems = normalizeXaiInputItems(current);
    if (withNormalizedInputItems) {
      current = withNormalizedInputItems;
      changed = true;
    }
    return changed ? current : null;
  };
}

/**
 * 跨来源恢复的加密压缩历史兼容(Greptile P1, PR #265):
 *
 * OpenAI 远端压缩会把早期历史替换成加密 compaction 块(只有 ChatGPT 后端能解)。
 * 该会话切到 XD / xAI / 自定义供应商后按原 thread id resume,持久化历史里的加密块
 * 会被逐请求重放给读不懂它的上游 → 请求被拒、会话卡死。客户端无法解密转换,
 * 唯一可行的降级是:发往**非 ChatGPT 上游**时把加密块替换成明文占位 user message,
 * 明确告知模型「压缩点之前的上下文不可用」,保留压缩点之后仍在历史里的对话继续跑。
 * 判断去向用 ctx.upstreamBase(引擎按最终路由注入),不复刻路由逻辑。
 * ChatGPT 路由(chatgpt.com)原样透传,远端压缩语义不受影响。
 */
const COMPACTION_UNAVAILABLE_NOTE =
  '[context note] Earlier conversation history was compacted into an encrypted snapshot by the ' +
  'OpenAI subscription backend and is not readable on the current model provider. Treat the ' +
  'conversation from this point on as the available context; ask the user if earlier details are needed.';

function isChatGptUpstreamBase(upstreamBase: string | undefined): boolean {
  if (!upstreamBase) return false;
  try {
    return new URL(upstreamBase).hostname === new URL(CODEX_OAUTH_UPSTREAM).hostname;
  } catch {
    return false;
  }
}

/**
 * 把 body.input 里**确实携带加密内容**的压缩项替换为明文占位 user message。
 * 返回 null = 无压缩项,零改写。透明转发路径(transform 链)与 Chat bridge
 * localHandler 路径共用——两条路都可能重放跨来源恢复的加密压缩历史。
 *
 * 只替换 encrypted_content 非空的项(codex wire 上 Compaction.encrypted_content
 * 必填、ContextCompaction 可选):未来若出现可读/非加密的 compaction 变体,
 * 不在「上游解不开」的问题域内,原样透传交给目标上游/翻译层自行处理。
 */
function replaceEncryptedCompactionItems(body: unknown): Record<string, unknown> | null {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return null;
  let changed = false;
  const input = body.input.map((item) => {
    if (
      isPlainObject(item) &&
      (item.type === 'compaction' || item.type === 'context_compaction') &&
      typeof item.encrypted_content === 'string' &&
      item.encrypted_content.length > 0
    ) {
      changed = true;
      return {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: COMPACTION_UNAVAILABLE_NOTE }],
      };
    }
    return item;
  });
  return changed ? { ...body, input } : null;
}

export function createCrossProviderCompactionCompatTransform(): RequestTransform {
  return (body, ctx) => {
    // upstreamBase 未注入(理论不发生)按非 ChatGPT 保守处理?否——保守方向是不改写:
    // 改写会丢加密块,误伤真 ChatGPT 请求的代价(远端压缩语义被破坏)高于维持现状。
    if (!ctx.upstreamBase || isChatGptUpstreamBase(ctx.upstreamBase)) return null;
    const replaced = replaceEncryptedCompactionItems(body);
    if (!replaced) return null;
    log.info('replaced encrypted compaction history for non-ChatGPT upstream', {
      reqId: ctx.reqId,
      upstreamBase: ctx.upstreamBase,
      threadId: selectedThreadIdFromHeaders(ctx.headers),
    });
    return replaced;
  };
}

const MINIMAX_RESPONSES_UPSTREAMS: ReadonlySet<string> = new Set([
  'https://api.minimaxi.com/v1',
  'https://api.minimax.io/v1',
]);

function isMiniMaxResponsesSession(ctx: RequestTransformCtx): boolean {
  const sessionId = sessionIdFromTransformCtx(ctx);
  const providerId = sessionId ? getSessionProvider(sessionId) : null;
  if (!providerId) return false;
  const upstream = getActiveCatalog().providers.find((provider) => provider.id === providerId)
    ?.routing.codex?.upstream.replace(/\/+$/, '');
  return upstream !== undefined && MINIMAX_RESPONSES_UPSTREAMS.has(upstream);
}

/** MiniMax Responses 不接受 xhigh 或 reasoning summary，路由前收敛到官方支持字段。 */
function createMiniMaxResponsesCompatTransform(): RequestTransform {
  return (body, ctx) => {
    if (!isPlainObject(body) || !isMiniMaxResponsesSession(ctx)) return null;
    const reasoning = body.reasoning;
    if (!isPlainObject(reasoning)) return null;
    let changed = false;
    const nextReasoning = { ...reasoning };
    if (nextReasoning.effort === 'xhigh') {
      nextReasoning.effort = 'high';
      changed = true;
    }
    if ('summary' in nextReasoning) {
      delete nextReasoning.summary;
      changed = true;
    }
    return changed ? { ...body, reasoning: nextReasoning } : null;
  };
}

function createProviderModelRewriteTransform(): RequestTransform {
  return (body, ctx) => {
    const sessionId = sessionIdFromTransformCtx(ctx);
    const explicitProviderId = sessionId ? getSessionProvider(sessionId) : null;
    if (sessionId && explicitProviderId) return rewriteSessionModelIdForRoute(sessionId, 'codex', body);
    return rewriteImplicitModelIdForRoute('codex', body);
  };
}

function createDumpTransform(): RequestTransform {
  return (body, ctx) => {
    writeTransformedBodyDump(ctx, body);
    return null;
  };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function responseStringField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseJsonObject(text: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(text);
    return isPlainObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function readRequestMeta(requestBody: Buffer): {
  model: string | null;
  requestServiceTier: string | null;
} {
  const body = parseJsonObject(requestBody.toString('utf8'));
  if (!body) return { model: null, requestServiceTier: null };
  const model = responseStringField(body, 'model');
  const serviceTier = responseStringField(body, 'service_tier') ?? responseStringField(body, 'serviceTier');
  return {
    model,
    requestServiceTier: serviceTier,
  };
}

function readProviderResponseMeta(body: Record<string, unknown>): {
  responseId: string | null;
  model: string | null;
  serviceTier: string | null;
} {
  const response = isPlainObject(body.response) ? body.response : body;
  return {
    responseId: responseStringField(response, 'id'),
    model: responseStringField(response, 'model'),
    serviceTier: responseStringField(response, 'service_tier') ?? responseStringField(response, 'serviceTier'),
  };
}

function selectedThreadIdFromObserver(ctx: ResponseObserverCtx): string {
  return selectedThreadIdFromHeaders(ctx.requestHeaders);
}

function logProviderServiceTier(ctx: ResponseObserverCtx, body: Record<string, unknown>): boolean {
  const request = readRequestMeta(ctx.requestBody);
  const upstream = readProviderResponseMeta(body);
  const threadId = selectedThreadIdFromObserver(ctx);
  const sessionId = threadToSession.get(threadId) ?? null;
  log.info('codex provider service tier observed', {
    reqId: ctx.reqId,
    threadId,
    sessionId,
    upstreamBase: ctx.upstreamBase,
    status: ctx.status,
    model: upstream.model ?? request.model,
    requestServiceTier: request.requestServiceTier,
    upstreamServiceTier: upstream.serviceTier,
    responseId: upstream.responseId,
  });
  return true;
}

function numericHeader(headers: Readonly<Record<string, string>>, name: string): number | undefined {
  const raw = headers[name.toLowerCase()];
  if (!raw) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function maybeRecordXaiRateLimit(ctx: ResponseObserverCtx): void {
  if (ctx.status < 200 || ctx.status >= 300) return;
  if (!ctx.upstreamBase.startsWith('https://api.x.ai')) return;
  const info = {
    limitRequests: numericHeader(ctx.responseHeaders, 'x-ratelimit-limit-requests'),
    remainingRequests: numericHeader(ctx.responseHeaders, 'x-ratelimit-remaining-requests'),
    limitTokens: numericHeader(ctx.responseHeaders, 'x-ratelimit-limit-tokens'),
    remainingTokens: numericHeader(ctx.responseHeaders, 'x-ratelimit-remaining-tokens'),
  };
  if (Object.values(info).every((v) => v === undefined)) return;
  recordXaiRateLimitSnapshot(info);
}

function tryReadSseEvent(line: string): { event: string | null; data: Record<string, unknown> | null } | null {
  const parts = line.split(/\r?\n/);
  let event: string | null = null;
  const dataLines: string[] = [];
  for (const part of parts) {
    if (part.startsWith('event:')) event = part.slice('event:'.length).trim();
    else if (part.startsWith('data:')) dataLines.push(part.slice('data:'.length).trimStart());
  }
  if (dataLines.length === 0) return null;
  const dataText = dataLines.join('\n').trim();
  if (!dataText || dataText === '[DONE]') return null;
  return { event, data: parseJsonObject(dataText) };
}

function createCodexResponseObserver(): ResponseObserver {
  return (ctx) => {
    maybeRecordXaiRateLimit(ctx);
    if (ctx.method !== 'POST') return null;
    const path = ctx.url.split('?', 1)[0] ?? ctx.url;
    if (!path.endsWith('/responses') && path !== '/responses') return null;
    if (ctx.status < 200 || ctx.status >= 300) return null;
    const contentType = ctx.responseHeaders['content-type'] ?? '';
    const isSse = contentType.toLowerCase().includes('text/event-stream');
    const isJson = contentType.toLowerCase().includes('application/json');
    if (!isSse && !isJson) return null;

    let done = false;
    let total = 0;
    let text = '';
    const processSseFrame = (item: string) => {
      const evt = tryReadSseEvent(item);
      if (!evt?.data) return;
      if (evt.event && evt.event !== 'response.completed') return;
      if (!evt.event) {
        const type = responseStringField(evt.data, 'type');
        if (type && type !== 'response.completed') return;
      }
      const response = isPlainObject(evt.data.response) ? evt.data.response : evt.data;
      const serviceTier = responseStringField(response, 'service_tier') ?? responseStringField(response, 'serviceTier');
      const type = responseStringField(evt.data, 'type');
      if (!serviceTier && evt.event !== 'response.completed' && type !== 'response.completed') return;
      done = logProviderServiceTier(ctx, evt.data);
    };

    const drainSse = (flush: boolean) => {
      const chunks = text.split(/\r?\n\r?\n/);
      text = chunks.pop() ?? '';
      for (const item of chunks) {
        processSseFrame(item);
        if (done) break;
      }
      if (!done && flush && text.trim()) {
        processSseFrame(text);
        text = '';
      }
    };

    const ingest = (chunk: Buffer) => {
      if (done) return;
      total += chunk.length;
      if (total > CODEX_RESPONSE_OBSERVER_MAX_BYTES) {
        done = true;
        log.warn('codex provider service tier observer skipped oversized response', {
          reqId: ctx.reqId,
          threadId: selectedThreadIdFromObserver(ctx),
          status: ctx.status,
          bytes: total,
          maxBytes: CODEX_RESPONSE_OBSERVER_MAX_BYTES,
        });
        return;
      }
      text += chunk.toString('utf8');
      if (isSse) drainSse(false);
    };

    return {
      onData: ingest,
      onEnd: () => {
        if (done) return;
        if (isSse) {
          drainSse(true);
          return;
        }
        const body = parseJsonObject(text);
        if (!body) return;
        done = logProviderServiceTier(ctx, body);
      },
      onError: (err) => {
        if (done) return;
        log.warn('codex provider service tier observer stream error', {
          reqId: ctx.reqId,
          threadId: selectedThreadIdFromObserver(ctx),
          err: err.message,
        });
      },
    };
  };
}

/**
 * 纯函数: 按 model(原始, 含 codex/ 前缀)+ spawn 鉴权注入方式决定 **默认** 上游 / 鉴权 override。
 * (会话显式选了供应商时由 resolveSessionRouteDecision 优先接管,不会走到这里。)
 *   - env-key spawn(codex 已带 gateway key): 全程 null(走默认上游 gateway, 不动 header)。
 *   - oauth-bearer spawn(codex 带 OAuth token):
 *       codex/ 骨折模型 → 换 gateway key, 默认上游(gateway); 无 key 则 null(passthrough, 上游会 401)。
 *       普通模型        → override 上游到 ChatGPT, 透传 OAuth token(不动 header)= 订阅默认。
 * 退役了全局 api 开关:「普通模型也走网关」改由 per-session 显式选 XD 来源触发,不再是全局默认。
 */
export function decideCodexRoute(opts: {
  model: string;
  authInjection: CodexProxyAuthInjection;
  gatewayKey: string | null;
}): RoutingDecision | null {
  if (opts.authInjection === 'env-key' || opts.authInjection === 'provider-oauth') return null;
  if (!opts.model) return null;
  const toGateway = opts.model.startsWith('codex/');
  if (toGateway) {
    if (!opts.gatewayKey) return null;
    return { headerOverride: { authorization: `Bearer ${opts.gatewayKey}` } };
  }
  // 普通模型 + oauth-bearer → ChatGPT 后端, 透传 codex 带的 OAuth token + chatgpt-account-id(订阅默认)。
  return { upstreamOverride: CODEX_OAUTH_UPSTREAM };
}

export function createModelRoutingTransform(): RoutingTransform {
  return (body, ctx) => {
    // body 可能为 undefined —— 无 body 的 GET(典型: codex models-manager 的 `GET /models` 轮询,
    // 引擎现在也会对它跑路由)。不再因 body 非对象就短路;会话解析只依赖 headers,model 字段可选。
    const model = isPlainObject(body) && typeof body.model === 'string' ? body.model : '';
    const gatewayKey = _readGatewayKey();
    const authInjection = getCodexProxyAuthInjection();
    const threadId = selectedThreadIdFromHeaders(ctx.headers);
    const sessionId = threadId ? threadToSession.get(threadId) : undefined;

    // ① 该会话显式选了供应商 → 据 catalog 统一路由。thread-id header → threadToSession 反解 xdt sessionId。
    //    oauth-bearer 态全量适用;env-key 态默认全量走网关、per-session 无意义(与 decideCodexRoute 的
    //    env-key 短路一致,内置三家保持旧行为)。例外:自定义(user)供应商和 host 注入鉴权的
    //    供应商(provider-oauth-header 如 xAI、通用 Runner 的 oauth-token)必须按会话路由,
    //    因为它们的鉴权由 proxy 覆盖,不依赖 Codex 子进程凭证。
    if (sessionId && (
      authInjection === 'oauth-bearer' ||
      isUserProviderSession(sessionId) ||
      isHostInjectedAuthSession(sessionId, 'codex')
    )) {
      const selectedRouting = getSessionRoutingDescriptor(sessionId, 'codex', model || undefined);
      if (selectedRouting?.wireProtocol === 'openai-chat' && ctx.method === 'POST' && model) {
        return resolveSessionRoute(sessionId, 'codex', model).then((localRoute) =>
          createChatBridgeDecision(localRoute, threadId ? registry.get(threadId) : undefined));
      }
      // model 传给 scope 门(空串 = 控制面 GET,不受范围限制);声明了 modelPrefixes 的
      // 供应商(如 xai)只捕获自家命名空间的请求,其余回落默认路由。
      const perSession = resolveSessionRouteDecision(sessionId, 'codex', gatewayKey, model || undefined);
      if (perSession) return perSession;
      // scope 门放下来的请求在 provider-oauth spawn 下没有可用凭证兜底:子进程只带占位
      // env key,直落默认网关必 401(#890 Codex review 第二轮指出)。换网关 key 给它一条
      // 真正可用的默认路由(与 cc ② 段 oauth-spawn 默认换 key 同语义);没网关 key 时保持
      // 原 null(passthrough,上游 401),行为与占位 key 直发一致,不额外兜底。
      if (authInjection === 'provider-oauth' && model) {
        const fallback = gatewayDefaultRouteDecision('codex', gatewayKey);
        if (fallback) return fallback;
        log.warn('provider-oauth session out-of-scope model but no gateway key; passthrough (预期 401)', { model });
      }
    }

    // ①.5 隐式来源(providerId/sessionProvider=null)但 model 自带唯一供应商命名空间。
    // 典型:xai/grok-* 来自默认/调度/IM 路径时不写 sessionProvider,但仍必须走 api.x.ai
    // + SuperGrok OAuth + modelIdRewrite,不能掉到 Codex 默认 ChatGPT/XD 分支。
    const explicitProviderId = sessionId ? getSessionProvider(sessionId) : null;
    if (!explicitProviderId && model) {
      const implicitProviderOAuth = resolveImplicitProviderOAuthRouteDecision(model, 'codex', gatewayKey);
      if (implicitProviderOAuth) return implicitProviderOAuth;
    }

    // ③ 无会话且无 model = 不属于任何 session 的控制面请求(典型: codex models-manager 的
    //    `GET /models` 轮询)。它没有 provider 上下文可解析,默认会掉静态默认上游(网关)、带着子进程
    //    spawn 时那把凭证 —— oauth-bearer 揣的 OAuth token 在网关无效(要 sk-)→ 401。
    //    故按 spawn 凭证回它的原生后端: oauth-bearer → ChatGPT 订阅后端(只 override 上游、透传 OAuth
    //    token,等价 stock codex 订阅模式轮 /models 的去处); provider-oauth → 唯一 provider-oauth
    //    供应商的上游/令牌(当前 xAI),避免把占位 key 打到网关; env-key → null(留默认网关, sk- key 本就有效)。
    //    `!model` 这道闸确保真实 /responses(永远带 model)绝不落进此分支,杜绝注册时序竞争误伤推理请求。
    if (!sessionId && !model) {
      if (authInjection === 'oauth-bearer') return { upstreamOverride: CODEX_OAUTH_UPSTREAM };
      if (authInjection === 'provider-oauth') {
        return resolveProviderOAuthControlRouteDecision('codex', gatewayKey);
      }
      return null;
    }

    // ② 未显式选供应商 → 回落默认路由(decideCodexRoute,与未升级行为字节级一致)。
    const decision = decideCodexRoute({ model, authInjection, gatewayKey });
    // codex/ 骨折模型该走 gateway 换 key 但没配 key → null(passthrough), 上游大概率 401, 记一条诊断。
    if (decision === null && authInjection === 'oauth-bearer' && model
      && model.startsWith('codex/') && !gatewayKey) {
      log.warn('codex routing → gateway but no api key configured; passthrough (可能 401)', { model });
    }
    return decision;
  };
}

function createTransformRequestChain(): RequestTransform[] {
  const transforms: RequestTransform[] = [
    createActiveStripTransform({
      controller: encryptedStripController,
      enabled: () => readSilentEncryptedRetrySettings().enabled,
      strip: stripEncryptedContentFromBody,
    }),
    createActiveStripTransform({
      controller: imageGenerationStripController,
      enabled: () => true,
      strip: stripImageGenerationItemsWithoutIdFromBody,
    }),
    createCodexTransform(),
    // 必须先于 xAI/MiniMax 兼容改写:加密压缩块换成明文占位 message 后,后续
    // 针对具体供应商的 input 归一化才能按标准 message 处理它。
    createCrossProviderCompactionCompatTransform(),
    createXaiResponsesCompatTransform(),
    createByteDanceSeedResponsesCompatTransform(),
    createMiniMaxResponsesCompatTransform(),
    createProviderModelRewriteTransform(),
    stripNonAnthropicFields,
  ];
  if (process.env.XDT_CODEX_PROXY_DUMP_TRANSFORMED_BODY === '1') {
    transforms.push(createDumpTransform());
  }
  return transforms;
}

/**
 * 启动本地 Codex prompt proxy。幂等 —— 重复调用直接返回已缓存状态。
 *
 * `_startPromise` 去重并发启动;`_handle` 为空时 getCodexProxyEndpoint()
 * 直接 fallback 到真上游 URL。
 */
export async function ensureCodexProxyReady(): Promise<void> {
  if (_handle) return;
  if (_startPromise) return _startPromise;

  const generation = _disposeGeneration;
  _startPromise = (async () => {
    try {
      const handle = await createAnthropicCompatProxy({
        // 默认上游 = gateway(含 /v1); 「普通模型 + oauth」由 routingTransform override 到 ChatGPT。
        // 函数形态:model-access 下发切换网关 endpoint 后,常驻 proxy 每请求现取(按值 memoize)。
        upstream: () => buildCodexGatewayBaseUrl(),
        transformRequest: createTransformRequestChain(),
        routingTransform: createModelRoutingTransform(),
        // 组合两个只读观察器:service-tier 抽取 + 自定义供应商上游错误分类广播
        // (后者仅 status≥400 且会话路由到 user 供应商时才 tee,成功路径零开销)。
        responseObserver: composeResponseObservers(
          createCodexResponseObserver(),
          createProviderUpstreamErrorObserver({
            agent: 'codex',
            resolveUserProviderId: (requestHeaders) => {
              const threadId = selectedThreadIdFromHeaders(requestHeaders);
              const sessionId = threadId ? threadToSession.get(threadId) : undefined;
              return sessionId ? getUserProviderIdForSession(sessionId) : null;
            },
            resolveUserProviderName: (providerId) =>
              getActiveCatalog().providers.find((provider) => provider.id === providerId)?.name ?? null,
          }),
        ),
        maxRequestBodyBytes: CODEX_PROXY_MAX_REQUEST_BODY_BYTES,
        // 请求体 dump 默认关(dev trace 级别 + agent 高并发会刷爆 main event loop
        // 与日志盘);诊断请求体时设 XDT_PROXY_DUMP_REQUEST_BODY=1 显式开启。
        debugDumpRequestBody: process.env.XDT_PROXY_DUMP_REQUEST_BODY === '1',
        // Codex 走 OpenAI Responses API, 从不打 Anthropic Messages API, 不会出现空 thinking 块 400
        // → 挂 Responses 专属恢复规则, 不挂 thinking 规则。
        recoveryRules: [
          createEncryptedContentRecoveryRule({
            enabled: () => readSilentEncryptedRetrySettings().enabled,
            onRetry: (threadId, model) => encryptedStripController.markActive(threadId, model),
          }),
          createImageGenerationIdRecoveryRule({
            onRetry: (threadId, model) => imageGenerationStripController.markActive(threadId, model),
          }),
        ],
        logger: log,
        // 上游连接跟随代理环境变量 / 系统代理(非 TUN 的代理软件场景);无代理配置时直连,
        // 行为与之前字节级一致。见 outbound-proxy-resolver.ts。
        resolveOutboundProxy: resolveDesktopOutboundProxy,
      });
      if (generation !== _disposeGeneration) {
        await handle.dispose().catch((err) => {
          log.warn('codex proxy start raced with dispose; disposing fresh handle failed', {
            err: err instanceof Error ? err.message : String(err),
          });
        });
        return;
      }
      _handle = handle;
      log.info('codex proxy ready', { url: _handle.url, upstream: buildCodexGatewayBaseUrl() });
    } catch (err) {
      _handle = null;
      log.error('codex proxy failed to start, falling back to direct upstream', {
        err: err instanceof Error ? err.message : String(err),
        fallbackEndpoint: buildCodexGatewayBaseUrl(),
      });
    } finally {
      _startPromise = null;
    }
  })();
  return _startPromise;
}

/**
 * 给 Codex app-server 用的 provider base_url —— 永远是 loopback proxy 的 root。
 *
 * codex 向 `${base_url}/responses` 发请求 → proxy 收 `/responses`。proxy 默认上游
 * buildCodexGatewayBaseUrl()(含 /v1)→ 拼成 `/v1/responses` 转 gateway;routingTransform override 到
 * CODEX_OAUTH_UPSTREAM(含 /backend-api/codex)→ 拼成 `/backend-api/codex/responses` 转 ChatGPT。
 * proxy 没起来 → fallback 到 gateway base_url(codex 直连 gateway, 失去 ChatGPT 透传, 但不裸奔)。
 */
export function getCodexProxyEndpoint(): string {
  if (_handle) return _handle.url;
  const fallbackEndpoint = buildCodexGatewayBaseUrl();
  log.warn('codex proxy not ready, falling back to direct gateway', { fallbackEndpoint });
  return fallbackEndpoint;
}

/**
 * 登记某个业务 session 当前 thread 对应的完整产品 prompt。
 *
 * 这是同步内存 Map 写入,不做 IO / 网络,调用方可以把它当成不可失败的强时序步骤。
 */
export function registerComposed(sessionId: string, threadId: string, text: string): void {
  const previousThreadId = sessionToThread.get(sessionId);
  if (previousThreadId && previousThreadId !== threadId) {
    registry.delete(previousThreadId);
    threadToSession.delete(previousThreadId);
  }

  const previousSessionId = threadToSession.get(threadId);
  if (previousSessionId && previousSessionId !== sessionId) {
    sessionToThread.delete(previousSessionId);
  }

  sessionToThread.set(sessionId, threadId);
  threadToSession.set(threadId, sessionId);
  registry.set(threadId, text);
  log.debug('registered codex prompt for thread', {
    sessionId,
    threadId,
    bytes: Buffer.byteLength(text, 'utf8'),
    registrySize: registry.size,
  });
}

/**
 * 清理业务 session 对应的 thread prompt。由后续 Layer 4 接到 onClose 调用。
 */
export function unregister(sessionId: string): void {
  const threadId = sessionToThread.get(sessionId);
  if (!threadId) return;

  sessionToThread.delete(sessionId);
  threadToSession.delete(threadId);
  registry.delete(threadId);
  log.debug('unregistered codex prompt for session', {
    sessionId,
    threadId,
    registrySize: registry.size,
  });
}

/**
 * proxy handle 是否就绪(`_handle` 非空)。spawn 决策点用它**直接**判定 active,
 * 不要靠 `endpoint !== buildCodexGatewayBaseUrl()` 这类字符串比较——upstream / 常量
 * 任何一处加尾斜杠或改写都会让比较失真 → proxy 起不来却误判 active=true →
 * maker-core drop dev → 全员裸奔。这条路影响所有 API 用户,必须用显式就绪状态。
 */
export function isCodexProxyHandleReady(): boolean {
  return _handle !== null;
}

/**
 * 优雅关闭。注册到 bootstrap-electron 的 onQuit('async') 阶段。
 */
export async function disposeCodexProxy(): Promise<void> {
  _disposeGeneration += 1;
  dumpSeq = 0;
  for (const threadId of sessionToThread.values()) {
    registry.delete(threadId);
  }
  sessionToThread.clear();
  threadToSession.clear();

  if (_startPromise) {
    await _startPromise.catch(() => undefined);
  }

  if (!_handle) return;

  const h = _handle;
  _handle = null;
  try {
    await h.dispose();
  } catch (err) {
    log.warn('codex proxy dispose failed', { err: err instanceof Error ? err.message : String(err) });
  }
}
