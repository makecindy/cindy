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
 * Responses `input[]` 里的上下文压缩块 (OpenAI `/v1/responses/compact` 与 xAI 同名接口
 * 都回这个形态)。它的 `encrypted_content` 装的是**压缩 blob 本体** —— 压缩点之前的
 * 全部历史,不是可有可无的推理链。
 */
function isCompactionItem(node: Record<string, unknown>): boolean {
  return node.type === 'compaction' || node.type === 'context_compaction';
}

/**
 * Drop Codex agent-to-agent ciphertext at its protocol-defined location.
 *
 * A spawned Codex agent can call `send_message` from an otherwise ordinary
 * session; the resulting `agent_message` carries readable text and an optional
 * `{ type: 'encrypted_content', encrypted_content: '...' }` part. Deleting only
 * the field leaves a schema-invalid encrypted-content shell, so remove the
 * whole part before the generic recursive key strip. If the message contained
 * only ciphertext, the message itself has no replayable content and is dropped.
 *
 * This intentionally inspects only top-level Responses `input[]`; nested
 * business objects with a similarly shaped `content` array are not protocol
 * history and must not be interpreted by shape.
 */
function dropEncryptedAgentMessageContentParts(body: unknown): number {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return 0;

  let removed = 0;
  const input: unknown[] = [];
  for (const item of body.input) {
    if (!isPlainObject(item) || item.type !== 'agent_message' || !Array.isArray(item.content)) {
      input.push(item);
      continue;
    }

    const content = item.content.filter((part) => {
      if (!isPlainObject(part) || part.type !== 'encrypted_content') return true;
      removed += 1;
      return false;
    });
    if (content.length === item.content.length) {
      input.push(item);
    } else if (content.length > 0) {
      input.push({ ...item, content });
    }
  }

  if (removed > 0) body.input = input;
  return removed;
}

/**
 * 递归删除 body 里所有 `encrypted_content` 键, 返回删掉的个数。
 * 用于 invalid_encrypted_content 报错后的透明重试 (见 stripEncryptedContentFromBody)。
 *
 * **压缩块整块跳过**: 剥掉压缩 blob 换不回一个可用请求 —— 上游收到没有 blob 的
 * 压缩空壳会直接判 "Could not decode the compaction blob. Ensure it is unmodified
 * from the compact response." (xAI 实报, 2026-07 Grok 会话卡死)。压缩块该怎么处置
 * 由上层按目标上游决定 (codex-proxy 的跨来源压缩兼容 transform 会把读不懂的加密块
 * 换成明文占位), 而那条兼容路径正是以"encrypted_content 非空"为触发条件 —— 在这里
 * 先剥就等于把它一并绕过。
 */
function deepDeleteEncryptedContent(node: unknown): number {
  let removed = 0;
  if (Array.isArray(node)) {
    for (const item of node) removed += deepDeleteEncryptedContent(item);
    return removed;
  }
  if (isPlainObject(node)) {
    if (isCompactionItem(node)) return 0;
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
 * 缺 blob 的 `compaction` 空壳 —— 上游无法解码, 留着必 400, 只能丢。
 *
 * **只认 `compaction`, 不认 `context_compaction`**: codex wire 上 `Compaction.encrypted_content`
 * 必填、`ContextCompaction.encrypted_content` 可选 —— 后者不带密文是合法的可读压缩变体
 * (codex-proxy 的跨来源压缩兼容 transform 同样只处理带密文的项, 明文变体原样透传)。
 * 把它当空壳删掉会静默丢掉真实的压缩上下文。
 */
function isCompactionShellWithoutBlob(item: unknown): boolean {
  if (!isPlainObject(item) || item.type !== 'compaction') return false;
  return typeof item.encrypted_content !== 'string' || item.encrypted_content.length === 0;
}

/**
 * 丢掉 Responses 请求体**协议层** `input[]` 里解不开也修不好的空壳 item:
 *   - 缺 blob 的 `compaction` (**恒丢**): 本模块不再制造这种空壳
 *     (见 deepDeleteEncryptedContent), 但请求体可能已经带着它进来, 兜底丢掉,
 *     别让它打到上游换一个 400;
 *   - 无 encrypted_content 的 reasoning (**仅 dropReasoningShells**): 只删
 *     encrypted_content 键时,xAI 会把残留 reasoning item 判成 ModelInput 反序列化失败
 *     (422)。这一条只在本轮确实剥掉过密文时才做 —— 没剥过的请求里,"reasoning 只带
 *     summary" 是合法形态, 不该顺手删掉。
 *
 * **只看顶层 `input`, 不递归**: Responses 请求体的协议历史只有顶层这一个 `input[]`;
 * 嵌套结构里同名的 `input` 数组(工具参数、业务对象等)不是协议历史, 按 `type` 形状
 * 猜着删会静默改坏别人的数据。删密文键可以全树递归(定向删键, 只会少发不会发错),
 * 判定"整项该不该留"必须锚在协议层。
 */
function dropEncryptedShellInputItems(body: unknown, dropReasoningShells: boolean): number {
  if (!isPlainObject(body) || !Array.isArray(body.input)) return 0;

  let removed = 0;
  const kept: unknown[] = [];
  for (const item of body.input) {
    if (
      isCompactionShellWithoutBlob(item) ||
      (dropReasoningShells && isReasoningItemWithoutEncryptedContent(item))
    ) {
      removed += 1;
      continue;
    }
    kept.push(item);
  }
  if (removed > 0) body.input = kept;
  return removed;
}

/**
 * 把请求体里所有 `encrypted_content` 键递归删掉 (压缩块除外), 并丢掉解不开也修不好的
 * 空壳 input item, 返回新的 Buffer。
 *
 * 背景: gpt-5.5 等模型经 litellm/Azure 走 OpenAI Responses API (/v1/responses) 时,
 * 请求体的 reasoning item 带 `encrypted_content` (gAAA... 加密推理)。多部署负载均衡把
 * 后续请求路由到另一部署时, 它解不开上一部署的加密推理 → 400 invalid_encrypted_content。
 * xAI 同类失败文案是 "Could not decrypt the provided encrypted_content" (400/422)。
 * 删掉 encrypted_content 再重发即可恢复 (代价: 模型丢失上一轮的加密推理链, 可见对话保留)。
 * 若只删键、保留 type=reasoning 空壳,xAI 会再报 ModelInput 422 —— 所以空壳一并丢掉。
 *
 * **上下文压缩块除外**: 它的 encrypted_content 是压缩 blob 本体, 剥掉只会把请求变成
 * 上游无法解码的空壳 (详见 deepDeleteEncryptedContent)。
 *
 * 仅在 server.ts 收到该 400/422 后的"透明重试"路径调用, 正常请求不经过此函数。
 *
 * @returns 删掉了至少一个键或空壳 → 新 Buffer; body 非 JSON / 无可剥内容 → null (调用方据此决定不重试)
 */
export function stripEncryptedContentFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  // agent_message 的密文是 content part；必须在通用递归删键之前整块移除，否则会留下
  // `{ type: 'encrypted_content' }` 并被 OpenAI 拒绝为 missing_required_parameter。
  const removedAgentMessageParts = dropEncryptedAgentMessageContentParts(parsed);
  const removedKeys = deepDeleteEncryptedContent(parsed);
  // 空壳清理独立计数: 请求体里可能只带着一个缺 blob 的 compaction 空壳 (没有任何
  // encrypted_content 键可删), 那一样是必须处理的坏 payload, 不能因 removedKeys=0 放行。
  // 这一步只扫顶层 input[] (单次线性扫描), 不是第二遍深度遍历。
  const removedShells = dropEncryptedShellInputItems(parsed, removedKeys > 0);
  if (removedAgentMessageParts === 0 && removedKeys === 0 && removedShells === 0) return null;
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

/**
 * 丢弃请求历史里的空 assistant 消息(含剥掉空 thinking 块后变空壳的),返回新 Buffer;
 * 没改动 / 非 JSON / 无 messages → null。
 *
 * 背景: moonshot/kimi-k3 经 LiteLLM 原生转发(/anthropic/v1/messages passthrough)时,
 * 其 Anthropic 兼容流首包是空 thinking 占位 {type:"thinking",thinking:"",signature:""}
 * (kimi 官方确认 by design);流被 429/中断切断后,客户端把未完成的占位 block 当成完整
 * assistant 持久化,回放时 moonshot 400:
 *   "Invalid request: the message at position 693 with role 'assistant' must not be empty"
 * (2026-07-28 线上实测,两个独立会话 position 693 / 275,重试 35+ 次全部失败,
 * 会话级永久卡死——每轮请求历史都带污染消息)。
 *
 * 处理(与 kimi code 官方客户端的兜底策略同构——发送出去的请求不允许带空 assistant):
 *   1. assistant 消息 content 为 string 且为空白 → 整条丢弃;
 *   2. assistant 消息 content 为数组:先剥空 thinking 块与空 text 块(判别式与
 *      stripEmptyThinkingFromBody / stripEmptyTextFromBody 一致,有内容/签名空的块
 *      保留),剥完为空(含原生 content:[])→ 整条丢弃;剥完仍有 text/tool_use →
 *      保留净化后的消息。空 text 块一并剥的原因:moonshot 的 must-not-be-empty 校验
 *      对 bridge 清理路径产出的 text-only 空块消息同样命中(PR #821 review 实测反馈),
 *      只剥 thinking 会让该形态 strip 不出东西、重试被跳过,会话继续卡死。
 *   user 消息一律不动(线上命中的只有 assistant;user 空消息无实测证据,不扩散)。
 *
 * 安全性: 空消息不含任何对话信息,丢弃不改变语义;含 tool_use 的轮次剥完非空,
 * tool_use/tool_result 配对不会被打破。
 *
 * @returns 丢弃/净化至少一条 → 新 Buffer; 无改动 → null (cache 安全契约:字节透传)。
 */
export function stripEmptyAssistantMessagesFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;

  let changed = false;
  const keptMessages: unknown[] = [];
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role !== 'assistant') {
      keptMessages.push(msg);
      continue;
    }
    const content = msg.content;
    if (typeof content === 'string') {
      if (content.trim().length === 0) {
        changed = true; // 空 string content → 整条丢弃
        continue;
      }
      keptMessages.push(msg);
      continue;
    }
    if (!Array.isArray(content)) {
      keptMessages.push(msg); // 异常形态不猜,原样保留
      continue;
    }
    const keptContent = content.filter((block) => !isEmptyThinkingBlock(block) && !isEmptyTextBlock(block));
    if (keptContent.length === 0) {
      changed = true; // 空壳(content:[] 或剥空 thinking/空 text 后为空)→ 整条丢弃
      continue;
    }
    if (keptContent.length !== content.length) {
      changed = true;
      keptMessages.push({ ...msg, content: keptContent });
      continue;
    }
    keptMessages.push(msg);
  }

  if (!changed) return null; // ← cache 安全契约:无改动 → null → 字节透传
  parsed.messages = keptMessages;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

// ───────────────────────────────────────────────────────────────────────────
// Tool exchange 结构修复 —— 与 kimi code 官方客户端的投影修复同构
// (kosong normalizeToolCallIdsForProvider + agent-core projector),移植到
// Anthropic Messages wire 格式:
//   - tool_use 块在 assistant 消息 content 内;tool_result 块在 user 消息
//     content 内(kimi 内部格式里 tool result 是独立的 role:'tool' 消息)。
//   - 两个 transform 都是**检测即修**:扫描发现协议级异常才改写,无异常返回
//     null(cache 安全契约:字节透传,正常会话零影响)。不需要 ThreadStripController
//     —— 重复 id / 配对断裂在请求体里可直接检测,不像 encrypted_content 要靠
//     撞 400 才能判定该剥。
// ───────────────────────────────────────────────────────────────────────────

function isToolUseBlock(block: unknown): block is Record<string, unknown> & { id: string } {
  return (
    isPlainObject(block) &&
    block.type === 'tool_use' &&
    typeof block.id === 'string' &&
    block.id.length > 0
  );
}

function isToolResultBlock(
  block: unknown,
): block is Record<string, unknown> & { tool_use_id: string } {
  return (
    isPlainObject(block) &&
    block.type === 'tool_result' &&
    typeof block.tool_use_id === 'string' &&
    block.tool_use_id.length > 0
  );
}

/**
 * 重复 tool_use id 唯一化(检测即修),返回新 messages;无重复 → null。
 *
 * 背景: moonshot/kimi 系的 tool_call id 是服务端按序号铸造的(`Edit_306` /
 * `Bash_256` 这类 `${name}_${index}` 形态,经 LiteLLM 字符清洗后冒号变下划线)。
 * 长会话里序号生成会卡住,同一个 id 被跨 turn 反复复用(2026-07 两个独立会话
 * 实测各复用 20+ 次)——模型看回放历史时工具交换错乱,表现为"工具调用凭空
 * 消失"、安静瘫痪。kimi code 官方对原始重复 id 的处理是 400 后 strict resend
 * 丢弃(agent-core projector dedupeDuplicateToolCalls),但 moonshot 容忍重复
 * id 不报 400,strict 路径永远触发不了 → 这里改为发送前检测即修。
 *
 * 与 kimi strict 的**丢弃**不同,这里选择**重写**(kosong normalize 思路):
 * 首现保留,第 N 次出现重写为 `${id}_${N}`(与现存 id 撞车时顺延后缀),
 * 顺序配对的第 N 个 tool_result 同步改写。每个重复对背后是不同的逻辑调用,
 * 丢弃会抹历史;重写保持配对完整,且 `_N` 后缀在 Anthropic id 合法字符集
 * (`[a-zA-Z0-9_-]`)内,对任何上游都是协议修复而非篡改。
 *
 * 配对规则: 按出现顺序,第 N 个 result 配第 N 个 call(正常历史里 result 紧跟
 * 其 call,顺序配对即真实配对)。result 比 call 多的尾部块保持原样(指向首现
 * call;超编残留的清理由 repairToolExchangeAdjacency 负责)。
 *
 * 边界(刻意不做): id 字符集 sanitize(kimi kosong 会把 `Edit:306` 的冒号洗成
 * 下划线)不在本 transform 范围 —— 本链路上游(LiteLLM)已做过清洗,非法字符
 * id 无实测证据;实测命中再扩。`_N` 后缀只含合法字符,不会把合法 id 改非法。
 *
 * rename key 用 ` ` 分隔 id 与出现序号:Anthropic 合法 id 字符集不含空格,
 * 不会与真实 id 撞 key;病态含空格 id 的重写结果仍由 usedIds 保证唯一。
 */
function dedupeToolUseIdsInMessages(messages: unknown[]): unknown[] | null {
  // pass 1: 统计每个 call id 出现次数。usedIds(后缀撞车判定)只在确有重复、
  // 进入改名阶段时才从 counts.keys() 构建 —— clean 请求(绝大多数)零 Set 分配。
  const counts = new Map<string, number>();
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolUseBlock(block)) continue;
      counts.set(block.id, (counts.get(block.id) ?? 0) + 1);
    }
  }
  let hasDuplicate = false;
  for (const n of counts.values()) {
    if (n > 1) {
      hasDuplicate = true;
      break;
    }
  }
  if (!hasDuplicate) return null; // cache 安全契约:无重复 → 透传

  // pass 2a: 给每个 call 的第 N(N≥2) 次出现分配全局唯一新 id。
  const usedIds = new Set(counts.keys());
  const renameByOccurrence = new Map<string, string>();
  const callSeen = new Map<string, number>();
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolUseBlock(block)) continue;
      const n = (callSeen.get(block.id) ?? 0) + 1;
      callSeen.set(block.id, n);
      if (n === 1) continue;
      let suffix = n;
      let candidate = `${block.id}_${suffix}`;
      while (usedIds.has(candidate)) {
        suffix += 1;
        candidate = `${block.id}_${suffix}`;
      }
      usedIds.add(candidate);
      renameByOccurrence.set(`${block.id} ${n}`, candidate);
    }
  }

  // pass 2b: 重写 call 与顺序配对的 result(第 N 个 result 查第 N 次 call 的改名;
  // 查不到 = 该 result 无对应第 N 个 call,保持原样)。
  const callWriteSeen = new Map<string, number>();
  const resultSeen = new Map<string, number>();
  const nextMessages = messages.map((msg) => {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
    let msgChanged = false;
    const nextContent = msg.content.map((block) => {
      if (msg.role === 'assistant' && isToolUseBlock(block)) {
        const n = (callWriteSeen.get(block.id) ?? 0) + 1;
        callWriteSeen.set(block.id, n);
        const renamed = renameByOccurrence.get(`${block.id} ${n}`);
        if (renamed === undefined) return block;
        msgChanged = true;
        return { ...block, id: renamed };
      }
      if (msg.role === 'user' && isToolResultBlock(block)) {
        const n = (resultSeen.get(block.tool_use_id) ?? 0) + 1;
        resultSeen.set(block.tool_use_id, n);
        const renamed = renameByOccurrence.get(`${block.tool_use_id} ${n}`);
        if (renamed === undefined) return block;
        msgChanged = true;
        return { ...block, tool_use_id: renamed };
      }
      return block;
    });
    return msgChanged ? { ...msg, content: nextContent } : msg;
  });
  return nextMessages;
}

/**
 * Buffer 版: 重复 tool_use id 唯一化。供 400 recovery(``tool_use` ids must be
 * unique`)与主动 transform 共用同一份修复逻辑。
 */
export function dedupeDuplicateToolUseIdsFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;
  const nextMessages = dedupeToolUseIdsInMessages(messages);
  if (nextMessages === null) return null;
  parsed.messages = nextMessages;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 主动 transform 版: body 已由 proxy 解析为 plain object。
 * 无重复返回 null,保持 clean request 的字节级透传语义。
 */
export const dedupeDuplicateToolUseIds: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  const nextMessages = dedupeToolUseIdsInMessages(messages);
  if (nextMessages === null) return null;
  return { ...body, messages: nextMessages };
};

/**
 * 未配对 call 的合成占位 result 文本(与 kimi code projector 的
 * SYNTHETIC_TOOL_RESULT_TEXT 同文案同语义:明确告知结果缺失、禁止假设成功;
 * 不设 is_error —— "上下文里结果不可用"≠"工具执行失败",避免模型误重试)。
 */
const SYNTHETIC_TOOL_RESULT_TEXT =
  'Tool result is not available in the current context. Do not assume the tool completed successfully.';

/**
 * tool_use/tool_result 配对断裂修复(检测即修),返回新 messages;无断裂 → null。
 *
 * 与 kimi code projector 的 repairToolExchangeAdjacency + dropOrphanResults
 * 同构(consumed-scan),移植到 Anthropic 格式:
 *   1. 位置配对优先: 每个 call 先消费紧邻下一条消息里同 id 的未消费 result
 *      块(CC 投影的正常形态,位置证据最强的配对);全部 call(含 trailing)
 *      做完位置配对后才进入接力 —— 否则较早的同 id 缺口 call 会抢走较晚
 *      call 紧邻位置的真实 result,造成张冠李戴。
 *   2. 接力补缺 + 错位重排: 位置配对失败的 call 从结果池取**归属区间**(本
 *      assistant 消息到下一条含同 id call 的 assistant 消息之间 —— agentic
 *      loop 串行,出现在下一个同 id exchange 之后的 result 只属于后面的
 *      exchange,较早缺口不得越界抢走;同消息 parallel calls 的归属不可判定
 *      时按稳定 tie-breaker 沿 call 块顺序配序,该约定受典型 client
 *      serializer 支持但非 wire 可证明)内的第一个未消费块;不在合法位置
 *      (跨消息,或同消息内落在 text 之后)的前移至紧邻消息的前导
 *      tool_result 区间,原位置移除。Anthropic 要求 result 紧跟 call 所在
 *      assistant 且居于 text 前,留在错误位置仍是 400。
 *   3. 缺失合成: 非 trailing 的 call 无候选 → 紧邻位置合成占位(kimi 同文案
 *      同语义;不设 is_error —— "结果不可用"≠"执行失败")。插入规则与重排
 *      相同;string content 转等价数组,空白 string 不附加 text 块。
 *   4. 丢弃: 孤儿 result(全历史无匹配 call)、池中剩余(前置 result —— 引用
 *      未来 call 本身非法;同 id 超编残留 —— 一个 call 恰应有一个应答)全部
 *      移除;user 消息 content 因此清空 → 整条丢弃。
 *   5. trailing 豁免: 最后一个「对话推进点」处的 assistant(末尾交换)只消费
 *      不修复 —— 缺失 result 可能真在飞,不合成、不重排;其后的纯 result
 *      消息视为交换一部分,不会误判为残留丢弃。
 */
/**
 * 最后一个「对话推进点」下标: assistant 消息,或含非 tool_result 内容的 user
 * 消息(纯 tool_result 的 user 消息可能是 trailing 交换的一部分,不算推进点);
 * 异常形态(非 plain object / string content)保守按推进点计。无 → -1。
 */
function findLastConversationIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (!isPlainObject(msg)) return i;
    if (msg.role === 'assistant' || !Array.isArray(msg.content)) return i;
    if (msg.role === 'user' && msg.content.some((block) => !isToolResultBlock(block))) return i;
  }
  return -1;
}

/**
 * content 前导 tool_result 区间的长度(开头连续 tool_result 块数)。
 * Anthropic 惯例(CC 原生形态): 一条 user 消息里所有 tool_result 块在最前,
 * text 等其它块在后;result 落在 text 之后 = 块级错位,需重排进前导区间。
 */
function leadingToolResultCount(content: unknown[]): number {
  let k = 0;
  while (k < content.length && isToolResultBlock(content[k])) k += 1;
  return k;
}

function repairToolExchangeAdjacencyInMessages(messages: unknown[]): unknown[] | null {
  // pass A: 全历史 call id 集合 + result 块位置池(per id 按出现升序)。
  // 孤儿 result(无匹配 call)不入池,直接进丢弃清单。
  const callIds = new Set<string>();
  for (const msg of messages) {
    if (!isPlainObject(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (isToolUseBlock(block)) callIds.add(block.id);
    }
  }
  const resultPool = new Map<string, Array<{ msgIdx: number; blockIdx: number }>>();
  const drops: Array<{ msgIdx: number; blockIdx: number }> = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    if (!isPlainObject(msg) || msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (let b = 0; b < msg.content.length; b++) {
      const block = msg.content[b];
      if (!isToolResultBlock(block)) continue;
      if (!callIds.has(block.tool_use_id)) {
        drops.push({ msgIdx: i, blockIdx: b });
        continue;
      }
      const list = resultPool.get(block.tool_use_id) ?? [];
      list.push({ msgIdx: i, blockIdx: b });
      resultPool.set(block.tool_use_id, list);
    }
  }

  // pass B1: 位置配对 —— 每个 call 优先消费紧邻下一条消息里同 id 的未消费
  // result 块(CC 投影的正常形态,位置证据最强的配对)。**全部 call(含
  // trailing)先做完位置配对再做接力**:否则较早的同 id 缺口 call 会在接力时
  // 抢走较晚 call 紧邻位置的真实 result(张冠李戴,Greptile P1 实测反例:
  // call#1 缺 result、call#2 有真实 result → call#1 越权消费、call#2 反得
  // 合成占位)。trailing call 参与位置配对(消费合法尾部 result)但不做修复。
  const lastConversationIndex = findLastConversationIndex(messages);
  const consumed = new Set<string>(); // `${msgIdx}:${blockIdx}`
  // assistant 下标 → (call 块下标 → 要插入的 result 块),按 call 顺序组装。
  const insertPlans = new Map<number, Map<number, unknown>>();
  const recordInsert = (assistantIdx: number, callBlockIdx: number, block: unknown) => {
    const plan = insertPlans.get(assistantIdx) ?? new Map<number, unknown>();
    plan.set(callBlockIdx, block);
    insertPlans.set(assistantIdx, plan);
  };
  const missingCalls: Array<{ i: number; id: string; trailing: boolean; callBlockIdx: number }> = [];
  for (let i = 0; i <= lastConversationIndex; i++) {
    const msg = messages[i];
    if (!isPlainObject(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    const trailing = i >= lastConversationIndex;
    const nextMsg = messages[i + 1];
    const nextContent =
      isPlainObject(nextMsg) && nextMsg.role === 'user' && Array.isArray(nextMsg.content)
        ? nextMsg.content
        : null;
    for (let cb = 0; cb < msg.content.length; cb++) {
      const block = msg.content[cb];
      if (!isToolUseBlock(block)) continue;
      const id = block.id;
      let hit: { msgIdx: number; blockIdx: number } | undefined;
      if (nextContent !== null) {
        for (let b = 0; b < nextContent.length; b++) {
          const cand = nextContent[b];
          if (isToolResultBlock(cand) && cand.tool_use_id === id && !consumed.has(`${i + 1}:${b}`)) {
            hit = { msgIdx: i + 1, blockIdx: b };
            break;
          }
        }
      }
      if (hit !== undefined) {
        consumed.add(`${hit.msgIdx}:${hit.blockIdx}`);
        // 已邻接判定到块级: 位于前导 tool_result 区间则不动;落在 text 之后
        // = 块级错位 → 前移进前导区间( trailing 只消费不修复)。
        if (!trailing && hit.blockIdx >= leadingToolResultCount(nextContent!)) {
          drops.push(hit);
          recordInsert(i, cb, nextContent![hit.blockIdx]);
        }
      } else {
        missingCalls.push({ i, id, trailing, callBlockIdx: cb });
      }
    }
  }

  // pass B2: 接力 —— 位置配对失败的 call,从结果池取**归属区间**内的第一个
  // 未消费块前移(错位重排);无候选 → 非 trailing 合成占位。
  //
  // 归属区间 = (本 assistant 消息下标, 下一条含同 id call 的 assistant 消息
  // 下标) —— 即"同 id exchange"边界。依据 agentic loop 串行:下一个 exchange
  // 的同 id call 发出时,本 exchange 的同 id result 必已回来(或丢失),出现在
  // 下一个 exchange 之后的 result 只属于后面的 exchange;较早缺口 exchange
  // 不得越界抢较晚 exchange 的错位真实结果(Greptile 第二轮反例)。
  //
  // 边界粒度刻意是 exchange(消息)而非单个 call:同一条 assistant 消息内的
  // parallel 同 id calls 同批发出、result 同批回来,其中一个丢失时归属在
  // 原理上不可判定(信息论:两种归属的世界序列化后字节完全相同,缺失不留
  // 位置痕迹)—— 此时采用**稳定 tie-breaker**:区间内涵 call 块顺序配序。
  // 该约定受典型 client serializer 支持(CC SDK 的 Tool Runner 以
  // Promise.all 并发执行、但结果数组保持输入 tool_use 顺序),可复现且最大
  // 保留信息;但只是默认约定,不是 wire 可证明的归属 —— 真正消除歧义只能
  // 在丢失前由 source adapter 持久化 occurrence/call index(provenance),
  // 本层对已有 body 无法补造这个 bit。
  //
  // trailing missing call 同样消费区间内的块,但**只消费不修复**(不移、不
  // 合成)——保护 trailing 交换的合法尾部 result(如 parallel trailing calls
  // 的 result 分多条消息回来)不被下方"池剩余丢弃"误杀。
  const callIndicesById = new Map<string, number[]>();
  for (let i = 0; i <= lastConversationIndex; i++) {
    const msg = messages[i];
    if (!isPlainObject(msg) || msg.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (!isToolUseBlock(block)) continue;
      const list = callIndicesById.get(block.id) ?? [];
      list.push(i);
      callIndicesById.set(block.id, list);
    }
  }
  for (const mc of missingCalls) {
    const pool = resultPool.get(mc.id) ?? [];
    const indices = callIndicesById.get(mc.id) ?? [];
    let nextIdx = Number.POSITIVE_INFINITY;
    for (const idx of indices) {
      if (idx > mc.i) {
        nextIdx = idx;
        break;
      }
    }
    let hit: { msgIdx: number; blockIdx: number } | undefined;
    for (const cand of pool) {
      const key = `${cand.msgIdx}:${cand.blockIdx}`;
      if (consumed.has(key)) continue;
      if (cand.msgIdx <= mc.i || cand.msgIdx >= nextIdx) continue; // 区间外(前置/归后面的 call)
      hit = cand;
      break;
    }
    if (hit !== undefined) {
      consumed.add(`${hit.msgIdx}:${hit.blockIdx}`);
      if (!mc.trailing) {
        drops.push(hit);
        const srcMsg = messages[hit.msgIdx] as Record<string, unknown>;
        recordInsert(mc.i, mc.callBlockIdx, (srcMsg.content as unknown[])[hit.blockIdx]);
      }
      // trailing: 仅 consumed 保护,不动位置。
    } else if (!mc.trailing) {
      recordInsert(mc.i, mc.callBlockIdx, {
        type: 'tool_result',
        tool_use_id: mc.id,
        content: SYNTHETIC_TOOL_RESULT_TEXT,
      });
    }
  }
  // 池中剩余(前置 / 超编 / 永不配对)→ 全部丢弃。
  for (const pool of resultPool.values()) {
    for (const cand of pool) {
      const key = `${cand.msgIdx}:${cand.blockIdx}`;
      if (consumed.has(key)) continue;
      drops.push(cand);
      consumed.add(key);
    }
  }
  // 每个 assistant 的插入块按 call 块顺序拼装(位置配对与接力分两遍收集,
  // 顺序不一定与 call 顺序一致)。
  const insertBlocksAfter = new Map<number, unknown[]>();
  for (const [assistantIdx, plan] of insertPlans) {
    insertBlocksAfter.set(
      assistantIdx,
      [...plan.entries()].sort((a, b) => a[0] - b[0]).map(([, block]) => block),
    );
  }

  if (drops.length === 0 && insertBlocksAfter.size === 0) return null; // cache 安全契约

  // pass C: 单遍组装。drops 按消息分组过滤;插入计划落在 assistant 之后 ——
  // 下一条是 user 消息则标记 prepend(遍历到它时并入其 content 的前导
  // tool_result 区间末尾,保持 result 在前、与 call 顺序一致),否则就地新建
  // user 消息。user 消息过滤后(含 prepend)content 空 → 整条丢。
  const dropsByMsg = new Map<number, Set<number>>();
  for (const d of drops) {
    const set = dropsByMsg.get(d.msgIdx) ?? new Set<number>();
    set.add(d.blockIdx);
    dropsByMsg.set(d.msgIdx, set);
  }
  const prependByMsg = new Map<number, unknown[]>();
  const out: unknown[] = [];
  for (let i = 0; i < messages.length; i++) {
    const msg = messages[i];
    let current = msg;
    if (isPlainObject(msg) && msg.role === 'user') {
      const dropsHere = dropsByMsg.get(i);
      const prepend = prependByMsg.get(i);
      if (Array.isArray(msg.content) && (dropsHere !== undefined || prepend !== undefined)) {
        const filtered = dropsHere ? msg.content.filter((_, b) => !dropsHere.has(b)) : [...msg.content];
        const k = leadingToolResultCount(filtered);
        const content = [...filtered.slice(0, k), ...(prepend ?? []), ...filtered.slice(k)];
        if (content.length === 0) continue; // content 清空 → 整条丢
        current = { ...msg, content };
      } else if (typeof msg.content === 'string' && prepend !== undefined) {
        // string content 转等价数组并入;空白 string 不附加 text 块(避免新造
        // 空 text 块,转头命中 "text content blocks must be non-empty" 400)。
        const text = msg.content.trim().length > 0 ? [{ type: 'text', text: msg.content }] : [];
        current = { ...msg, content: [...prepend, ...text] };
      }
    }
    out.push(current);
    const inserts = insertBlocksAfter.get(i);
    if (inserts !== undefined && inserts.length > 0) {
      const next = messages[i + 1];
      if (isPlainObject(next) && next.role === 'user') {
        prependByMsg.set(i + 1, [...(prependByMsg.get(i + 1) ?? []), ...inserts]);
      } else {
        out.push({ role: 'user', content: inserts });
      }
    }
  }
  return out;
}

/**
 * Buffer 版: 配对断裂修复。供 400 recovery(tool_call_id not found /
 * unexpected tool_use_id / tool_use without tool_result)与主动 transform 共用。
 */
export function repairToolExchangeAdjacencyFromBody(rawBody: Buffer): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const messages = parsed.messages;
  if (!Array.isArray(messages)) return null;
  const nextMessages = repairToolExchangeAdjacencyInMessages(messages);
  if (nextMessages === null) return null;
  parsed.messages = nextMessages;
  try {
    return Buffer.from(JSON.stringify(parsed), 'utf8');
  } catch {
    return null;
  }
}

/**
 * 主动 transform 版: body 已由 proxy 解析为 plain object。
 * 无断裂返回 null,保持 clean request 的字节级透传语义。
 */
export const repairToolExchangeAdjacency: RequestTransform = (body) => {
  if (!isPlainObject(body)) return null;
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;
  const nextMessages = repairToolExchangeAdjacencyInMessages(messages);
  if (nextMessages === null) return null;
  return { ...body, messages: nextMessages };
};

/**
 * 组合结构修复: 先 adjacency 接力配对,再重复 id 唯一化 —— 顺序不可颠倒。
 *
 * 为什么必须 repair 在前: dedupe 的「第 N 个 result 配第 N 个 call」依赖
 * result 顺序与 call 顺序一一对应,而病态历史里的前置 result(在 call 之前)
 * 会白占一个序号,把本属前一个 call 的 result 改名给后一个 call,repair 再按
 * 改名后的 id 配对 → 张冠李戴(复审实测反例: call#1 收到 call#2 的真实结果、
 * call#1 自己的结果被丢)。repair 先跑会丢弃前置/超编块、把错位块归位,产出的
 * 结构合法历史上 result 与 call 严格同序,dedupe 的顺序配对才等于真实配对。
 *
 * 供两条 recovery rule 共用: server.ts 的透明重试是「命中规则先 strip,其余按
 * 数组顺序顺手应用」,命中顺序会打乱数组里声明的修复顺序,只有组合函数能强制
 * repair → dedupe。两步各自检测驱动,无对应异常时该步原样传递。
 */
export function repairToolExchangeStructureFromBody(rawBody: Buffer): Buffer | null {
  const afterRepair = repairToolExchangeAdjacencyFromBody(rawBody);
  const stage1 = afterRepair ?? rawBody;
  const afterDedupe = dedupeDuplicateToolUseIdsFromBody(stage1);
  if (afterRepair === null && afterDedupe === null) return null; // 两步都无改动
  return afterDedupe ?? stage1;
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

/**
 * 纯文本模型的 tool_result 图像降级(#794)。
 *
 * 实测(z-ai/glm-5.2,Anthropic 兼容直通):tool_result 里的 image block 原样发给
 * 上游,上游静默丢弃且不报错——模型把工具结果当成空,反复重读或直接臆造图片内容
 * (实测单任务空转 66 分钟并编造译文)。把 image block 替换为说明性占位文本:
 * 明确告知有图但当前模型收不到、禁止臆测、引导贴文本或换视觉模型。
 *
 * 只处理 tool_result 内嵌图像;user 消息图像走各桥接的 input_image 路径,不归这里。
 */
const TOOL_RESULT_IMAGE_OMITTED_TEXT =
  '[image omitted: this tool returned an image, but the current model is text-only, '
  + 'so the image could not be delivered. Do NOT guess or fabricate what the image '
  + 'contains. Tell the user the image could not be delivered to the current model, '
  + 'and ask them to paste the relevant content as text or switch to a vision-capable '
  + 'model.]';

export function replaceToolResultImagesWithNotice(
  body: Record<string, unknown>,
  noticeText = TOOL_RESULT_IMAGE_OMITTED_TEXT,
): Record<string, unknown> | null {
  const messages = body.messages;
  if (!Array.isArray(messages)) return null;

  let replaced = 0;
  const nextMessages = messages.map((msg) => {
    if (!isPlainObject(msg) || !Array.isArray(msg.content)) return msg;
    let msgChanged = false;
    const nextContent = msg.content.map((block) => {
      if (!isPlainObject(block) || block.type !== 'tool_result' || !Array.isArray(block.content)) {
        return block;
      }
      let blockChanged = false;
      const nextInner = block.content.map((inner) => {
        if (!isPlainObject(inner) || inner.type !== 'image') return inner;
        replaced += 1;
        blockChanged = true;
        return { type: 'text', text: noticeText };
      });
      if (!blockChanged) return block;
      msgChanged = true;
      return { ...block, content: nextInner };
    });
    return msgChanged ? { ...msg, content: nextContent } : msg;
  });

  if (replaced === 0) return null; // cache 安全契约:无改动 → null → 字节透传
  return { ...body, messages: nextMessages };
}

/** glm-5.2 (智谱,官方仅文本/代码模态) —— 直通与网关两条路由同一 model id。 */
const stripGlm52: ModelStripHandler = (body) => replaceToolResultImagesWithNotice(body);

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
  // 纯文本模型 tool_result 图像会被上游静默吞掉 (#794) —— 带/不带命名空间前缀,
  // 以及 claude-code SDK 按目录 1M 窗口追加 [1m] 后缀 (toSdkModelString) 的形态
  // 都登记 (直通路由 body.model 可能保留 z-ai/ 前缀与 [1m] 后缀)。
  'glm-5.2': stripGlm52,
  'z-ai/glm-5.2': stripGlm52,
  'glm-5.2[1m]': stripGlm52,
  'z-ai/glm-5.2[1m]': stripGlm52,
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

// moonshot 400 (经 LiteLLM /anthropic/v1/messages passthrough,2026-07-28 实测):
// "Invalid request: the message at position 693 with role 'assistant' must not be empty"
// 只匹配不变的 role + 校验短语,不锚定会变的 position 数字。
const EMPTY_ASSISTANT_MESSAGE_RE = /with role 'assistant' must not be empty/i;

// Azure/LiteLLM 400: "Image generation items without `id` are not supported for this request."
const IMAGE_GENERATION_WITHOUT_ID_RE =
  /image generation items without [`']?id[`']? are not supported/i;

const TOOL_USE_PROVIDER_SPECIFIC_FIELDS_RE =
  /\.tool_use\.provider_specific_fields[^"\r\n|]*extra inputs are not permitted|extra inputs are not permitted[^"\r\n|]*\.tool_use\.provider_specific_fields/i;

// Anthropic 400: "messages: `tool_use` ids must be unique"(kimi kosong
// STRUCTURAL_REQUEST 同族正则)。moonshot 实测容忍重复 id 不报错(静默错乱),
// 但 LiteLLM 版本差异 / 真 Anthropic 上游会报;命中时用与主动 transform
// 相同的唯一化 strip 重发。
const DUPLICATE_TOOL_USE_ID_RE = /tool_use[\s\S]*ids must be unique/i;

// tool 配对断裂 400 家族(kimi kosong TOOL_EXCHANGE_ADJACENCY 同族,按本链路
// 可见措辞收敛):
//   - Moonshot(chatcmpl 校验透出): "tool_call_id  is not found"(孤儿 result,
//     原文双空格;锚定 tool_call_id,404 类 "not found" 不会误命中)
//   - Anthropic 孤儿 result: "unexpected `tool_use_id` found in `tool_result`
//     blocks"(两个锚点都限定,避免命中非 tool_result 上下文的 unexpected)
//   - Anthropic 未配对 call: "`tool_use` ids were found without `tool_result`
//     blocks immediately after"
//   - OpenAI 系(LiteLLM 版本差异可能透出): 孤儿 tool 消息 "unexpected
//     `tool_result`" / "messages with role 'tool' must be a response to a
//     preceding message with 'tool_calls'";未配对 call "the following
//     tool_call_ids did not have response messages: ..."
// roles-must-alternate / first-message-must-be-user 不在此列: 本修复不处理
// 合并与 leading 裁剪,匹配了也 strip 不出东西(实测命中再扩)。
const TOOL_EXCHANGE_ADJACENCY_RE =
  /tool_call_id[\s\S]*not found|unexpected\s+`?tool_use_id`?[\s\S]*tool_result|unexpected\s+`?tool_result|`?tool_use`?\s+ids were found without|tool_call_ids? did not have response messages|role\s+['"`]?tool['"`]?\s+must be a response to a preceding message/i;

/**
 * invalid_encrypted_content 恢复规则: 剥掉请求体里所有 encrypted_content 重发。
 * 受 enabled() gate(由 host 接 silentEncryptedRetry 设置,默认开,用户可关闭)。
 */
export function createEncryptedContentRecoveryRule(opts: {
  enabled: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
}): RecoveryRule {
  return {
    id: 'encrypted_content',
    enabled: opts.enabled,
    matches: (text) => INVALID_ENCRYPTED_CONTENT_RE.test(text),
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
    matches: (text) => IMAGE_GENERATION_WITHOUT_ID_RE.test(text),
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
    matches: (text) => TOOL_USE_PROVIDER_SPECIFIC_FIELDS_RE.test(text),
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
    matches: (text) => EMPTY_THINKING_RE.test(text),
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
    matches: (text) => EMPTY_TEXT_RE.test(text),
    strip: stripEmptyTextFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * 空 assistant 消息恢复规则: moonshot/kimi 系(Anthropic 兼容流空 thinking 占位被
 * 客户端中断持久化后)回放 400 → 丢掉空 assistant 消息重发。
 * 默认 always-on(空消息不含对话信息,丢弃零代价)。背景详见
 * stripEmptyAssistantMessagesFromBody 头注。
 */
export function createEmptyAssistantMessageRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'empty_assistant_message',
    enabled: opts.enabled ?? (() => true),
    matches: (text) => EMPTY_ASSISTANT_MESSAGE_RE.test(text),
    strip: stripEmptyAssistantMessagesFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * 重复 tool_use id 恢复规则: 上游 400 ``tool_use` ids must be unique` →
 * 组合结构修复(先 adjacency 后唯一化,顺序约束见
 * repairToolExchangeStructureFromBody)后重发。默认 always-on(修复是协议
 * 级的,无异常时 strip 返回 null 自然跳过)。kimi code 的 strict resend 同族处理。
 */
export function createDuplicateToolUseIdRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'duplicate_tool_use_id',
    enabled: opts.enabled ?? (() => true),
    matches: (text) => DUPLICATE_TOOL_USE_ID_RE.test(text),
    strip: repairToolExchangeStructureFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}

/**
 * tool 配对断裂恢复规则: 孤儿 result / 未配对 call 的 400(moonshot
 * `tool_call_id is not found` / Anthropic `unexpected tool_use_id` /
 * `tool_use ids were found without tool_result` / OpenAI 系 wording)→
 * 组合结构修复后重发。默认 always-on(与 kimi code projector 的 adjacency
 * 修复同构)。
 */
export function createToolExchangeAdjacencyRecoveryRule(opts: {
  enabled?: () => boolean;
  onRetry?: (threadId: string, model: string) => void;
  threadIdHeaders?: readonly string[];
} = {}): RecoveryRule {
  return {
    id: 'tool_exchange_adjacency',
    enabled: opts.enabled ?? (() => true),
    matches: (text) => TOOL_EXCHANGE_ADJACENCY_RE.test(text),
    strip: repairToolExchangeStructureFromBody,
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
  };
}
