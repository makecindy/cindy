/**
 * 内置默认 transform —— 解决 "Claude Code SDK 在请求体里塞了 Anthropic-only 字段,
 * 但请求被路由到 OpenAI/Azure/litellm 后端,后端不认这些字段直接 400" 的问题。
 *
 * 设计: 每个有问题的 model 一个独立 handler 函数,自己决定怎么改写 body
 * (删字段 / 翻译字段 / 改值 / 条件改写 ...都可以)。字典里没有的 model 默认完全
 * 字节透传,proxy 对它们零干预。
 *
 * 加 handler 的判定标准: 该 model 在 XD.inc gateway 的实际请求被观察到 400
 * (典型: litellm.BadRequestError "Unknown parameter: 'XXX'") —— 截 maker.log
 * 留证据。不要凭"它跟 gpt-5.4 应该一样" 之类的推测扩。
 */

import { DEFAULT_THREAD_ID_HEADERS, selectedHeaderValue } from './headers.js';
import type { ThreadStripController } from './thread-strip-controller.js';
import type { RecoveryRule, RequestTransform, RequestTransformCtx } from './types.js';

/**
 * 单个 model 的请求改写 handler。
 *
 * @param body 已经 parse 好的 plain object,调用前已确认 typeof body === 'object'
 *             且 body.model 命中字典 key。handler 内部不需要再做这些校验。
 * @returns 新的 body 对象 → 代理用它替换原 body 转发上游;
 *          null → 显式表示"虽然命中我但不需要改",代理走透传。
 */
type ModelStripHandler = (body: Record<string, unknown>) => Record<string, unknown> | null;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 工具函数: 递归从对象 / 数组任意嵌套层级删除指定 key 集合。
 * handler 内部按需调用。
 *
 * 性能: 只对 plain object 和 array 递归,字符串/数字/null 直接返回。
 * keys 用 Set —— 每个对象的每个 key 都要查一次,O(1) 比 includes 更稳。
 */
function deepDeleteKeys(node: unknown, keys: ReadonlySet<string>): void {
  if (Array.isArray(node)) {
    for (const item of node) deepDeleteKeys(item, keys);
    return;
  }
  if (isPlainObject(node)) {
    for (const k of keys) {
      if (k in node) delete node[k];
    }
    for (const key of Object.keys(node)) {
      deepDeleteKeys(node[key], keys);
    }
  }
}

/**
 * 删除 Anthropic `tool_use` content block 上由 provider adapter 附加的
 * `provider_specific_fields`。只处理 tool_use 自身的字段，不触碰工具 input
 * 内同名的业务字段，避免把用户传给工具的参数误删。
 */
function deepDeleteToolUseProviderSpecificFields(node: unknown): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += deepDeleteToolUseProviderSpecificFields(item);
    return removed;
  }
  if (!isPlainObject(node)) return 0;

  if (node.type === 'tool_use') {
    if ('provider_specific_fields' in node) {
      delete node.provider_specific_fields;
      removed += 1;
    }
    // tool input is opaque user data. It may itself contain objects shaped like
    // Anthropic content blocks, so never recurse below an actual tool_use block.
    return removed;
  }
  for (const key of Object.keys(node)) {
    removed += deepDeleteToolUseProviderSpecificFields(node[key]);
  }
  return removed;
}

/**
 * 递归删除请求历史中 `tool_use.provider_specific_fields`，供主动 transform
 * 和 400 recovery 共用同一份字段清理逻辑。
 */
export function stripToolUseProviderSpecificFieldsFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (deepDeleteToolUseProviderSpecificFields(parsed) === 0) return null;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 请求 transform 版本：body 已经由 proxy 解析为 plain object。
 * 无命中时返回 null，保持 clean request 的字节级透传语义。
 */
export const stripToolUseProviderSpecificFields: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;
  return deepDeleteToolUseProviderSpecificFields(body) > 0 ? body : null;
};

/**
 * 递归删除 body 里所有 `encrypted_content` 键, 返回删掉的个数。
 * 用于 invalid_encrypted_content 报错后的透明重试 (见 stripEncryptedContentFromBody)。
 */
function deepDeleteEncryptedContent(node: unknown): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += deepDeleteEncryptedContent(item);
    return removed;
  }
  if (isPlainObject(node)) {
    if ('encrypted_content' in node) {
      delete node.encrypted_content;
      removed += 1;
    }
    for (const key of Object.keys(node)) {
      removed += deepDeleteEncryptedContent(node[key]);
    }
  }
  return removed;
}

/** Responses `input[]` 里剥掉 encrypted_content 后已无密文的 reasoning 空壳。 */
function isReasoningItemWithoutEncryptedContent(item: unknown): boolean {
  if (!isPlainObject(item) || item.type !== 'reasoning') return false;
  return typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0;
}

/**
 * 从 Responses-style `input[]` 丢掉"无 encrypted_content 的 reasoning"空壳。
 * 只删 encrypted_content 键时,xAI 会把残留 reasoning item 判成 ModelInput 反序列化失败 (422)。
 */
function deepDropEmptyReasoningInputItems(node: unknown): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += deepDropEmptyReasoningInputItems(item);
    return removed;
  }
  if (!isPlainObject(node)) return 0;

  if (Array.isArray(node.input)) {
    const kept: unknown[] = [];
    for (const item of node.input) {
      if (isReasoningItemWithoutEncryptedContent(item)) {
        removed += 1;
        continue;
      }
      removed += deepDropEmptyReasoningInputItems(item);
      kept.push(item);
    }
    node.input = kept;
  }

  for (const key of Object.keys(node)) {
    if (key === 'input') continue;
    removed += deepDropEmptyReasoningInputItems(node[key]);
  }
  return removed;
}

/**
 * 把请求体里所有 `encrypted_content` 键递归删掉, 并丢掉因此变成空壳的 reasoning input item,
 * 返回新的 Buffer。
 *
 * 背景: gpt-5.5 等模型经 litellm/Azure 走 OpenAI Responses API (/v1/responses) 时,
 * 请求体的 reasoning item 带 `encrypted_content` (gAAA... 加密推理)。多部署负载均衡把
 * 后续请求路由到另一部署时, 它解不开上一部署的加密推理 → 400 invalid_encrypted_content。
 * xAI 同类失败文案是 "Could not decrypt the provided encrypted_content" (400/422)。
 * 删掉 encrypted_content 再重发即可恢复 (代价: 模型丢失上一轮的加密推理链, 可见对话保留)。
 * 若只删键、保留 type=reasoning 空壳,xAI 会再报 ModelInput 422 —— 所以空壳一并丢掉。
 *
 * 仅在 server.ts 收到该 400/422 后的"透明重试"路径调用, 正常请求不经过此函数。
 *
 * @returns 删掉了至少一个键或空壳 → 新 Buffer; body 非 JSON / 没有该键 → null (调用方据此决定不重试)
 */
export function stripEncryptedContentFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const removedKeys = deepDeleteEncryptedContent(parsed);
  if (removedKeys === 0) return null;
  deepDropEmptyReasoningInputItems(parsed);
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

function isImageGenerationType(type: unknown): boolean {
  if (typeof type !== 'string') return false;
  return type.startsWith('image_generation') || type.startsWith('imageGeneration');
}

function isImageGenerationItemWithoutId(item: unknown): boolean {
  if (!isPlainObject(item)) return false;
  if (!isImageGenerationType(item.type)) return false;
  const id = item.id;
  return typeof id !== 'string' || id.trim().length === 0;
}

function deepDeleteImageGenerationItemsWithoutId(node: unknown, inResponsesInputArray = false): number {
  let removed = 0;
  if (Array.isArray(node)) {
    let writeIndex = 0;
    for (const item of node) {
      if (inResponsesInputArray && isImageGenerationItemWithoutId(item)) {
        removed += 1;
        continue;
      }
      removed += deepDeleteImageGenerationItemsWithoutId(item);
      node[writeIndex] = item;
      writeIndex += 1;
    }
    node.length = writeIndex;
    return removed;
  }
  if (isPlainObject(node)) {
    for (const key of Object.keys(node)) {
      removed += deepDeleteImageGenerationItemsWithoutId(node[key], key === 'input');
    }
  }
  return removed;
}

/**
 * 删除 Responses 请求体里缺 `id` 的 image generation 历史 item。
 *
 * 背景: Codex rollout 会同时记录 event_msg:image_generation_end 和
 * response_item:image_generation_call。2026-07 实测 XD gateway → litellm/Azure
 * 会把缺 `id` 的 image_generation_end 回灌进下一轮 Responses input, Azure 直接 400:
 * "Image generation items without `id` are not supported for this request."
 *
 * 只删 Responses input 历史数组中 type 以 image_generation / imageGeneration 开头
 * 且缺 id 的对象;tools 里的 image_generation 工具声明、用户图片输入 input_image、
 * 已有 id 的 image_generation_call 都保留。
 */
export function stripImageGenerationItemsWithoutIdFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  const removed = deepDeleteImageGenerationItemsWithoutId(parsed);
  if (removed === 0) return null;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

/** thinking 块的 `thinking` 字段是否为空(空串 / 缺失 / 非字符串都算空)。 */
function isEmptyThinkingBlock(block: unknown): boolean {
  if (!isPlainObject(block)) return false;
  if (block.type !== 'thinking') return false;
  const t = block.thinking;
  return typeof t !== 'string' || t.trim().length === 0;
}

/**
 * 删除请求体里"空内容" thinking 块,返回新 Buffer;没改动 / 非 JSON / 无 messages → null。
 *
 * 背景: 跨厂商切模型时,Claude Code 会话历史累积了非 Anthropic 厂商产出的 thinking 块。
 * gpt-5.5 等"推理加密"模型产出空壳 {type:"thinking", thinking:"", signature:""}(真实推理在
 * encrypted_content 里,litellm 转 Anthropic 格式只留空壳)。切回真 Anthropic 模型时 API 400:
 * "messages.N.content.0.thinking: each thinking block must contain thinking"。
 *
 * 判别式只看 thinking 内容是否为空 —— deepseek 那种"有内容、签名空"的块被 gateway 容忍,
 * 不删;真 Anthropic 块有内容 + 有签名,更不会命中。删空块零代价(块里本就没内容)。
 *
 * 边界:
 *   - 某条 message 的 content 删空后 → 整条 message 丢弃(Anthropic 也拒空 content)。
 *   - 被删块所在轮若含 tool_use(开 thinking 时可能换来另一个 400)→ 保留不动 + 调用方按需记日志;
 *     该状态本就已坏,no-loop 保证下不会更糟,强行丢残轮风险更高。
 *
 * @returns 删掉至少一个空块 → 新 Buffer; body 非 JSON / messages 非数组 / 无空块 → null
 *          (返回 null 是 cache 安全契约:让代理字节透传,正常会话零影响)。
 */
export function stripEmptyThinkingFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;

  let removed = 0;
  const keptMessages: unknown[] = [];
  for (const msg of messages) {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) {
      keptMessages.push(msg);
      continue;
    }
    const keptContent = msg.content.filter((block) => {
      if (isEmptyThinkingBlock(block)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (keptContent.length === msg.content.length) {
      keptMessages.push(msg); // 该 message 没动
    } else if (keptContent.length === 0) {
      // content 被清空 → 整条 message 丢弃(边界 a);removed 已累加,下方仍判定有改动。
    } else {
      keptMessages.push({ ...msg, content: keptContent });
    }
  }

  if (removed === 0) return null; // ← cache 安全契约:无改动 → null → 字节透传
  parsed.messages = keptMessages;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

/** text 块的 `text` 字段是否为空(空串 / 纯空白 / 缺失 / 非字符串都算空)。 */
function isEmptyTextBlock(block: unknown): boolean {
  if (!isPlainObject(block)) return false;
  if (block.type !== 'text') return false;
  const t = block.text;
  return typeof t !== 'string' || t.trim().length === 0;
}

/**
 * 删除请求体里空内容 text 块,返回新 Buffer;没改动 / 非 JSON / 无 messages → null。
 *
 * 背景: anthropic-responses-bridge 修复前会把纯工具轮的 message item 落成
 * `{type:"text", text:""}` 空块写进 Claude Code 会话历史(eager 开块被 function_call
 * 抢占强制关掉)。会话切到真 Anthropic 模型时历史原样回放,API 400:
 * "messages.N.content.M: text content blocks must be non-empty"。bridge 已改为惰性
 * 开块不再产出新空块;本函数负责修复期之前累积的存量脏历史 —— 命中 400 后剥掉
 * 空块透明重试(结构与 stripEmptyThinkingFromBody 一致)。
 *
 * 只处理 messages[].content 顶层块,不深入 tool_result 嵌套 content(实测命中的
 * 只有顶层;嵌套形态被打脸再扩)。
 *
 * 边界: 某条 message 的 content 删空后 → 整条 message 丢弃(Anthropic 也拒空 content)。
 *
 * @returns 删掉至少一个空块 → 新 Buffer; body 非 JSON / messages 非数组 / 无空块 → null
 *          (返回 null 是 cache 安全契约:让代理字节透传,正常会话零影响)。
 */
export function stripEmptyTextFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;

  let removed = 0;
  const keptMessages: unknown[] = [];
  for (const msg of messages) {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) {
      keptMessages.push(msg);
      continue;
    }
    const keptContent = msg.content.filter((block) => {
      if (isEmptyTextBlock(block)) {
        removed += 1;
        return false;
      }
      return true;
    });
    if (keptContent.length === msg.content.length) {
      keptMessages.push(msg); // 该 message 没动
    } else if (keptContent.length === 0) {
      // content 被清空 → 整条 message 丢弃;removed 已累加,下方仍判定有改动。
    } else {
      keptMessages.push({ ...msg, content: keptContent });
    }
  }

  if (removed === 0) return null; // ← cache 安全契约:无改动 → null → 字节透传
  parsed.messages = keptMessages;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Per-model handlers ——
// 每个 model 一个独立函数,内部自由实现 strip / 翻译 / 改值。
// 加新 case: 写一个 handler + 在下面 STRIP_HANDLERS 字典里登记。
// ───────────────────────────────────────────────────────────────────────────

/**
 * gpt-5.4 (XD.inc litellm → Azure OpenAI backend)
 *
 * 实测报错:
 *   AzureException BadRequestError - Unknown parameter: 'output_config'
 *
 * 处理: 只删 output_config 这一个实测命中的字段。其他 Anthropic-only 字段
 * (thinking / cache_control / betas) 暂不动 —— 实测被打脸再加。
 */
const stripGpt54: ModelStripHandler = (body) => {
  const next: Record<string, unknown> = { ...body };
  delete next.output_config;
  return next;
};

/**
 * gpt-5.4-mini (XD.inc litellm → Azure OpenAI backend)
 *
 * 实测报错:
 *   AzureException BadRequestError - Unknown parameter: 'output_config'
 *
 * 先与 gpt-5.4 保持同样的最小修复面,后续若 mini 需要单独兼容其它字段,
 * 直接在这个 handler 扩即可,不影响 gpt-5.4。
 */
const stripGpt54Mini: ModelStripHandler = (body) => {
  const next: Record<string, unknown> = { ...body };
  delete next.output_config;
  return next;
};

// ───────────────────────────────────────────────────────────────────────────
// 分发表
// ───────────────────────────────────────────────────────────────────────────

/**
 * Per-model handler 字典 —— key = model id (与 body.model 严格相等比较)。
 * 不在表里的 model 一律字节透传,proxy 零干预。
 */
const STRIP_HANDLERS: Readonly<Record<string, ModelStripHandler>> = {
  'gpt-5.4': stripGpt54,
  'gpt-5.4-mini': stripGpt54Mini,
  // 「折扣GPT」低价路由 —— 与 gpt-5.4 打同一个 Azure 后端, 同样会因 output_config 报 400,
  // 镜像 gpt-5.4 的 strip 行为 (复用同一 handler)。codex/gpt-5.5 暂不加, 与 gpt-5.5 一致。
  'codex/gpt-5.4': stripGpt54,
};

/**
 * 默认 transform —— 按 model 分发到对应 handler;查不到就透传。
 */
export const stripNonAnthropicFields: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;

  const model = body.model;
  if (typeof model !== 'string' || model.length === 0) return null;

  const handler = STRIP_HANDLERS[model];
  if (!handler) return null;

  return handler(body);
};

/**
 * 主动剥离 transform —— 某 thread 因对应 400 恢复过一次后(controller 已 markActive),
 * 后续请求发送前就提前剥,省掉每轮重撞 400。`strip` 决定剥什么(encrypted 传
 * stripEncryptedContentFromBody,thinking 传 stripEmptyThinkingFromBody);controller
 * 必须与对应 recovery rule 是同一实例,且每个剥离条件用各自独立实例(详见 ThreadStripController)。
 */
export function createActiveStripTransform(opts: {
  controller: ThreadStripController;
  enabled: () => boolean;
  /** 对已标记 thread 主动剥离用的函数(与对应 recovery rule 的 strip 一致)。 */
  strip: (rawBody: Buffer) => Buffer | null;
  threadIdHeaders?: readonly string[];
}): RequestTransform {
  const threadIdHeaders = opts.threadIdHeaders ?? DEFAULT_THREAD_ID_HEADERS;
  return (body: unknown, ctx: RequestTransformCtx): unknown | null => {
    if (!opts.enabled()) return null;
    if (!isPlainObject(body)) return null;

    const threadId = selectedHeaderValue(ctx.headers, threadIdHeaders);
    const model = body.model;
    if (!threadId || typeof model !== 'string' || model.length === 0) return null;
    opts.controller.reconcile(threadId, model);
    if (!opts.controller.shouldStrip(threadId)) return null;

    const stripped = opts.strip(Buffer.from(JSON.stringify(body), 'utf8'));
    if (!stripped) return null;

    try {
      return JSON.parse(stripped.toString('utf8'));
    } catch {
      return null;
    }
  };
}

// ───────────────────────────────────────────────────────────────────────────
// Recovery rules —— 上游 400 透明重试规则(server.ts 的 forward() 按序应用第一条命中的)。
// 每条规则把"错误体匹配正则 + 对应 strip 函数"绑在一起,正则与 strip 就近放,单一真相源。
// ───────────────────────────────────────────────────────────────────────────

// 上游 400/422 错误体命中以下任一 → 判定为"协议加密推理内容解不开"。
// litellm/Azure: code "invalid_encrypted_content" + "Encrypted content could not be decrypted or parsed."
// xAI Responses: code "invalid-argument" + "Could not decrypt the provided encrypted_content..."
const INVALID_ENCRYPTED_CONTENT_RE =
  /invalid_encrypted_content|invalid-argument[\s\S]{0,160}encrypted_content|could not decrypt(?: the provided)? encrypted_content|encrypted content could not be (?:decrypted|verified|parsed)/i;

// Anthropic 400: "messages.N.content.M.thinking: each thinking block must contain thinking"
// 只匹配不变的核心短语,不锚定会变的 messages.N.content.M 下标前缀。
const EMPTY_THINKING_RE = /each thinking block must contain thinking/i;

// Anthropic 400: "messages.N.content.M: text content blocks must be non-empty"
// (纯空白变体: "text content blocks must contain non-whitespace text")。
// 同样只匹配核心短语,不锚定下标前缀。
const EMPTY_TEXT_RE = /text content blocks must (?:be non-empty|contain non-whitespace text)/i;

// Azure/LiteLLM 400: "Image generation items without `id` are not supported for this request."
const IMAGE_GENERATION_WITHOUT_ID_RE =
  /image generation items without [`']?id[`']? are not supported/i;

const TOOL_USE_PROVIDER_SPECIFIC_FIELDS_RE =
  /\.tool_use\.provider_specific_fields[^"\r\n|]*extra inputs are not permitted|extra inputs are not permitted[^"\r\n|]*\.tool_use\.provider_specific_fields/i;

/**
 * invalid_encrypted_content 恢复规则: 剥掉请求体里所有 encrypted_content 重发。
 * 受 enabled() gate(由 host 接 silentEncryptedRetry 设置,默认关)。
 */
export function createEncryptedContentRecoveryRule(opts: {
  enabled: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
}): RecoveryRule {
  return {
    id: 'encrypted_content',
    enabled: opts.enabled,
    match: (text) => INVALID_ENCRYPTED_CONTENT_RE.test(text),
    strip: stripEncryptedContentFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * 缺 id 的 image generation item 恢复规则: 剥掉坏历史 item 后重发。
 * 默认 always-on;只在明确命中上游错误时触发,正常请求字节透传。
 */
export function createImageGenerationIdRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'image_generation_id',
    enabled: opts.enabled ?? (() => true),
    match: (text) => IMAGE_GENERATION_WITHOUT_ID_RE.test(text),
    strip: stripImageGenerationItemsWithoutIdFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * `tool_use.provider_specific_fields` 400 恢复规则：清理历史后透明重试一次。
 * 主动 transform 通常会先移除该字段；该规则覆盖 transform 未接入、旧会话
 * 或其它兼容链路绕过主动清理的情况。
 */
export function createToolUseProviderSpecificFieldsRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'tool_use_provider_specific_fields',
    enabled: opts.enabled ?? (() => true),
    match: (text) => TOOL_USE_PROVIDER_SPECIFIC_FIELDS_RE.test(text),
    strip: stripToolUseProviderSpecificFieldsFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * 空 thinking 块恢复规则: 跨厂商切回 Anthropic 模型时,剥掉历史里的空内容 thinking 块重发。
 * 默认 always-on(删空块零代价,无需用户权衡)。
 */
export function createEmptyThinkingRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'empty_thinking',
    enabled: opts.enabled ?? (() => true),
    match: (text) => EMPTY_THINKING_RE.test(text),
    strip: stripEmptyThinkingFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * 空 text 块恢复规则: 历史被 bridge 修复前的空 `{type:"text",text:""}` 块污染的会话,
 * 切到真 Anthropic 模型时 400 → 剥掉空块重发。默认 always-on(删空块零代价)。
 */
export function createEmptyTextRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'empty_text',
    enabled: opts.enabled ?? (() => true),
    match: (text) => EMPTY_TEXT_RE.test(text),
    strip: stripEmptyTextFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}
