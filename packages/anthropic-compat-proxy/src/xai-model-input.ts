/**
 * xAI Responses `input[]` 归一化。
 *
 * Codex / PI / LiteLLM 历史里的 `agent_message`、`custom_tool_call`、
 * Chat 形态 `role:"tool"`、reasoning 空壳对不上 xAI 的 untagged
 * `ModelInput` 就会整包 422。但官方下一轮要 append 的 `response.output`
 * （`web_search_call` / `code_interpreter_call` / `file_search_call` 等）
 * 以及 `input_file` / `input_image.detail` 是合法回放，不能当未知项丢掉。
 *
 * 本模块是单一真相源：订阅直连、Gateway / LiteLLM 中转、PI 原生转发、
 * 以及 422 透明重试都走这里。只改顶层 `input[]`，不动 tools / messages。
 */

import type { RecoveryRule, RequestTransform } from "./types.js";

/**
 * xAI / OpenAI Responses 官方会回放的 server-side tool item。
 * 下一轮应原样 append `response.output`，不得当未知 type 丢掉。
 */
const XAI_PASSTHROUGH_INPUT_TYPES = new Set([
  "web_search_call",
  "file_search_call",
  "code_interpreter_call",
  "x_search_call",
  "computer_call",
  "computer_call_output",
  "mcp_call",
  "mcp_list_tools",
  "mcp_approval_request",
  "mcp_approval_response",
]);

/** 归一化后允许进入 xAI `input[]` 的 type。 */
const XAI_MODEL_INPUT_TYPES = new Set([
  "message",
  "function_call",
  "function_call_output",
  "reasoning",
  ...XAI_PASSTHROUGH_INPUT_TYPES,
]);

const XAI_MODEL_INPUT_RE =
  /did not match any variant of untagged enum ModelInput/i;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * 网关 `x-ai/grok-*`、订阅 `xai/grok-*`、裸 `grok-*` 都算 xAI Responses 上游。
 * 不依赖 catalog：本包零 runtime 依赖，判定只看 id 形态。
 */
export function looksLikeXaiResponsesModel(model: unknown): boolean {
  if (typeof model !== "string" || model.trim().length === 0) return false;
  const id = model.trim().toLowerCase();
  const bare = id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
  return (
    id.startsWith("xai/") || id.startsWith("x-ai/") || bare.startsWith("grok")
  );
}

/** 去掉 `xai/` / `x-ai/` / LiteLLM 命名空间后的裸 model id。 */
export function xaiBareModelId(model: unknown): string | null {
  if (typeof model !== "string" || model.trim().length === 0) return null;
  const id = model.trim();
  return id.includes("/") ? id.slice(id.lastIndexOf("/") + 1) : id;
}

/**
 * 与 anthropic-responses-bridge / oneShotCandidates 同源：
 * `grok-code*` / `grok-build*` 不支持 reasoning（带上会 400）。
 * 未知通用 Grok 默认当作支持，避免每出新模型就误剥回放。
 */
export function supportsXaiReasoningModel(model: unknown): boolean {
  const bare = xaiBareModelId(model)?.toLowerCase();
  if (!bare) return true;
  return !(bare.startsWith("grok-code") || bare.startsWith("grok-build"));
}

function isXaiUnsupportedInputItem(
  item: unknown,
  opts: { supportsReasoning: boolean },
): boolean {
  if (!isPlainObject(item) || typeof item.type !== "string") return false;
  if (item.type === "reasoning") {
    return (
      !opts.supportsReasoning ||
      typeof item.encrypted_content !== "string" ||
      item.encrypted_content.length === 0
    );
  }
  return (
    item.type.startsWith("image_generation") ||
    item.type.startsWith("imageGeneration")
  );
}

function textFromResponsesContent(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean")
    return String(value);
  if (value == null) return "";
  if (Array.isArray(value)) {
    return value
      .map((part) => {
        if (typeof part === "string") return part;
        if (!isPlainObject(part)) return "";
        if (typeof part.text === "string") return part.text;
        if (typeof part.input_text === "string") return part.input_text;
        if (typeof part.output_text === "string") return part.output_text;
        return "";
      })
      .filter((part) => part.length > 0)
      .join("\n");
  }
  if (isPlainObject(value)) {
    if (typeof value.text === "string") return value.text;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function argumentsFromCustomToolInput(value: unknown): string {
  if (value == null) return "{}";

  if (typeof value === "string") {
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

function callIdFrom(item: Record<string, unknown>, fallback = ""): string {
  if (typeof item.call_id === "string" && item.call_id.length > 0)
    return item.call_id;
  if (typeof item.tool_call_id === "string" && item.tool_call_id.length > 0)
    return item.tool_call_id;
  if (typeof item.id === "string" && item.id.length > 0) return item.id;
  return fallback;
}

function normalizeXaiInputItem(item: unknown): {
  item: unknown;
  changed: boolean;
} {
  if (typeof item === "string") {
    return {
      item: { type: "message", role: "user", content: item },
      changed: true,
    };
  }
  if (!isPlainObject(item)) {
    return { item, changed: false };
  }

  // EasyInput 兼容:只有 role/content、缺 type 的 message 先补 type。
  const base: Record<string, unknown> =
    !("type" in item) && typeof item.role === "string" && "content" in item
      ? { type: "message", ...item }
      : item;
  const typedFromEasy = base !== item;
  const type = typeof base.type === "string" ? base.type : undefined;

  if (type && XAI_PASSTHROUGH_INPUT_TYPES.has(type)) {
    return { item: base, changed: typedFromEasy };
  }

  if (type === "custom_tool_call") {
    const name = typeof base.name === "string" ? base.name : "";
    const next: Record<string, unknown> = {
      type: "function_call",
      name,
      arguments: argumentsFromCustomToolInput(base.input),
      call_id: callIdFrom(base),
    };
    if (typeof base.id === "string") next.id = base.id;
    return { item: next, changed: true };
  }

  if (type === "custom_tool_call_output" || type === "tool_result") {
    return {
      item: {
        type: "function_call_output",
        call_id: callIdFrom(base),
        output: textFromResponsesContent(base.output ?? base.content),
      },
      changed: true,
    };
  }

  // LiteLLM / Chat Completions 回放: `{type:"function"|"tool_call", function:{name,arguments}}`
  if (type === "function" || type === "tool_call") {
    const fn = isPlainObject(base.function) ? base.function : base;
    const name =
      typeof fn.name === "string"
        ? fn.name
        : typeof base.name === "string"
          ? base.name
          : "";
    const next: Record<string, unknown> = {
      type: "function_call",
      name,
      arguments: argumentsFromCustomToolInput(
        fn.arguments ?? base.arguments ?? base.input,
      ),
      call_id: callIdFrom(base),
    };
    if (typeof base.id === "string") next.id = base.id;
    return { item: next, changed: true };
  }

  // Codex multi-agent collab 历史项。OpenAI 会话里的 agent_message 带着 author/
  // recipient 和 content 里的 encrypted_content part；xAI ModelInput 不认这个 type，
  // 跨源 resume 到 grok 时整轮 422。降级成 assistant message，只保留可读文本
  // （collab 密文 part 解不开，丢掉）。
  if (type === "agent_message") {
    const bodyText = textFromResponsesContent(base.content).trim();
    const author =
      typeof base.author === "string" && base.author.length > 0
        ? base.author
        : "agent";
    const text =
      bodyText.length > 0
        ? `[collab ${author}]\n${bodyText}`
        : `[collab message from ${author}; encrypted payload omitted]`;
    return {
      item: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text }],
      },
      changed: true,
    };
  }

  if (type === "function_call") {
    const normalizedArguments = argumentsFromCustomToolInput(base.arguments);
    const next: Record<string, unknown> = {
      type: "function_call",
      name: typeof base.name === "string" ? base.name : "",
      arguments: normalizedArguments,
      call_id: callIdFrom(base),
    };
    if (typeof base.id === "string") next.id = base.id;
    const changed =
      typedFromEasy ||
      normalizedArguments !== base.arguments ||
      typeof base.call_id !== "string" ||
      typeof base.name !== "string" ||
      "status" in base ||
      Object.keys(base).some(
        (key) => !["type", "name", "arguments", "call_id", "id"].includes(key),
      );
    return changed
      ? { item: next, changed: true }
      : { item: base, changed: false };
  }

  if (type === "function_call_output") {
    const next: Record<string, unknown> = {
      type: "function_call_output",
      call_id: typeof base.call_id === "string" ? base.call_id : "",
      output:
        typeof base.output === "string"
          ? base.output
          : textFromResponsesContent(base.output),
    };
    const changed =
      typedFromEasy ||
      typeof base.output !== "string" ||
      typeof base.call_id !== "string" ||
      Object.keys(base).some(
        (key) => !["type", "call_id", "output"].includes(key),
      );
    return changed
      ? { item: next, changed: true }
      : { item: base, changed: false };
  }

  // 回放的 reasoning 项必须逐字回到上游签发时的形状 —— xAI 校验不过就整轮 400
  // "Could not decode the compaction blob. Ensure it is unmodified from the compact response."
  // codex 的结构体会把自己没用上的 `Option` 字段一并序列化(实测 `content: null`),
  // 那是 xAI 从没发过的键;带着它回放等于「被改过」。这里收敛成 Responses 契约里
  // reasoning 该有的四个键 —— 与 anthropic-responses-bridge 回放的形状同口径
  // (那条路上的 grok-4.5 一直是通的)。
  // encrypted_content / summary / id 原样搬,一个字节都不改写。
  if (type === "reasoning") {
    const next: Record<string, unknown> = { type: "reasoning" };
    if (typeof base.id === "string" && base.id.length > 0) next.id = base.id;
    next.summary = Array.isArray(base.summary) ? base.summary : [];
    if (typeof base.encrypted_content === "string")
      next.encrypted_content = base.encrypted_content;
    const changed =
      typedFromEasy ||
      !Array.isArray(base.summary) ||
      ("id" in base && next.id !== base.id) ||
      ("encrypted_content" in base &&
        next.encrypted_content !== base.encrypted_content) ||
      Object.keys(base).some(
        (key) => !["type", "id", "summary", "encrypted_content"].includes(key),
      );
    return changed
      ? { item: next, changed: true }
      : { item: base, changed: false };
  }

  if (type === "message") {
    // LiteLLM / Chat Completions 把 tool 结果写成 role=tool 的 message。
    // xAI message 变体不认这个 role，转成 function_call_output。
    if (base.role === "tool" || base.role === "function") {
      return {
        item: {
          type: "function_call_output",
          call_id: callIdFrom(base),
          output: textFromResponsesContent(base.content),
        },
        changed: true,
      };
    }

    let changed = typedFromEasy;
    const next: Record<string, unknown> = { type: "message" };
    const role = base.role === "developer" ? "system" : base.role;
    if (role !== base.role) changed = true;
    if (typeof role === "string") next.role = role;
    if ("content" in base) next.content = base.content;
    if (typeof base.id === "string") next.id = base.id;
    for (const key of Object.keys(base)) {
      if (key === "type" || key === "role" || key === "content" || key === "id")
        continue;
      changed = true;
    }
    if (Array.isArray(next.content)) {
      const parts: unknown[] = [];
      for (const part of next.content) {
        if (typeof part === "string") {
          parts.push({ type: "input_text", text: part });
          changed = true;
          continue;
        }
        if (!isPlainObject(part)) {
          changed = true;
          continue;
        }
        const partType = typeof part.type === "string" ? part.type : undefined;
        if (partType === "text") {
          parts.push({
            type: role === "assistant" ? "output_text" : "input_text",
            text: typeof part.text === "string" ? part.text : "",
          });
          changed = true;
          continue;
        }
        if (partType === "input_text" || partType === "output_text") {
          parts.push({
            type: partType,
            text: typeof part.text === "string" ? part.text : "",
          });
          if (Object.keys(part).some((k) => k !== "type" && k !== "text"))
            changed = true;
          continue;
        }
        if (partType === "input_image") {
          const nextPart: Record<string, unknown> = { type: "input_image" };
          if (typeof part.image_url === "string") {
            nextPart.image_url = part.image_url;
          } else if (isPlainObject(part.image_url)) {
            if (typeof part.image_url.url === "string") {
              nextPart.image_url = part.image_url.url;
            }
            if (
              !("detail" in part) &&
              typeof part.image_url.detail === "string"
            ) {
              nextPart.detail = part.image_url.detail;
            }
            changed = true;
          }
          if ("detail" in part) nextPart.detail = part.detail;
          if (typeof part.file_id === "string") nextPart.file_id = part.file_id;
          if (!("image_url" in nextPart) && !("file_id" in nextPart)) {
            changed = true;
            continue;
          }
          const allowed = ["type", "image_url", "detail", "file_id"];
          if (Object.keys(part).some((key) => !allowed.includes(key)))
            changed = true;
          parts.push(nextPart);
          continue;
        }
        if (partType === "input_file") {
          parts.push(part);
          continue;
        }
        changed = true;
      }
      next.content = parts;
    } else if (typeof next.content !== "string") {
      next.content = textFromResponsesContent(next.content);
      changed = true;
    }
    return changed
      ? { item: next, changed: true }
      : { item: base, changed: false };
  }

  // 未知 type 不透传：xAI untagged ModelInput 任一 item 对不上就整包 422。
  return {
    item: base,
    changed:
      typedFromEasy ||
      (typeof type === "string" && !XAI_MODEL_INPUT_TYPES.has(type)),
  };
}

export interface SanitizeXaiModelInputOptions {
  /**
   * false = 丢掉全部 reasoning（含带密文的）。
   * 省略时按 `supportsXaiReasoningModel(body.model)`：grok-code* / grok-build*
   * 为 false，其余 Grok 为 true。
   */
  supportsReasoning?: boolean;
}

export interface XaiModelInputCompatOptions {
  /** 覆盖默认的 grok-code / grok-build 判定；订阅直连可注入 catalog。 */
  supportsReasoningForModel?: (model: unknown) => boolean;
}

/**
 * 把 Responses 请求体的 `input[]` 收成 xAI 可反序列化的形态。
 * 无 input 数组 / 无需改写 → null。
 */
export function sanitizeXaiModelInputBody(
  body: Record<string, unknown>,
  opts: SanitizeXaiModelInputOptions = {},
): Record<string, unknown> | null {
  const supportsReasoning =
    opts.supportsReasoning ?? supportsXaiReasoningModel(body.model);
  let source = body;
  let wrappedSingleItem = false;
  if (isPlainObject(body.input) && !Array.isArray(body.input)) {
    source = { ...body, input: [body.input] };
    wrappedSingleItem = true;
  }
  if (!Array.isArray(source.input)) return null;

  let changed = wrappedSingleItem;
  const input: unknown[] = [];
  for (const raw of source.input) {
    if (isXaiUnsupportedInputItem(raw, { supportsReasoning })) {
      changed = true;
      continue;
    }
    const normalized = normalizeXaiInputItem(raw);
    if (normalized.changed) changed = true;
    if (
      !isPlainObject(normalized.item) ||
      typeof normalized.item.type !== "string" ||
      !XAI_MODEL_INPUT_TYPES.has(normalized.item.type)
    ) {
      changed = true;
      continue;
    }
    input.push(normalized.item);
  }
  if (!changed) return null;
  return { ...source, input };
}

function resolveSupportsReasoning(
  model: unknown,
  opts: {
    supportsReasoning?: boolean;
    supportsReasoningForModel?: (model: unknown) => boolean;
  } = {},
): boolean {
  if (typeof opts.supportsReasoning === "boolean")
    return opts.supportsReasoning;
  if (opts.supportsReasoningForModel)
    return opts.supportsReasoningForModel(model);
  return supportsXaiReasoningModel(model);
}

/** Recovery / active-strip 用：非 JSON 或无需改写 → null。 */
export function sanitizeXaiModelInputFromBody(
  rawBody: Buffer,
  opts: {
    supportsReasoning?: boolean;
    supportsReasoningForModel?: (model: unknown) => boolean;
  } = {},
): Buffer | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawBody.toString("utf8"));
  } catch {
    return null;
  }
  if (!isPlainObject(parsed)) return null;
  const sanitized = sanitizeXaiModelInputBody(parsed, {
    supportsReasoning: resolveSupportsReasoning(parsed.model, opts),
  });
  if (!sanitized) return null;
  try {
    return Buffer.from(JSON.stringify(sanitized), "utf8");
  } catch {
    return null;
  }
}

/**
 * 发送前主动清洗：只对 grok / xAI 形态的 model 动手，GPT / Claude 历史原样透传。
 */
export function createXaiModelInputSanitizeTransform(
  opts: XaiModelInputCompatOptions = {},
): RequestTransform {
  return (body) => {
    if (!isPlainObject(body) || !looksLikeXaiResponsesModel(body.model))
      return null;
    return sanitizeXaiModelInputBody(body, {
      supportsReasoning: resolveSupportsReasoning(body.model, {
        supportsReasoningForModel: opts.supportsReasoningForModel,
      }),
    });
  };
}

/**
 * 422 ModelInput 恢复规则：命中后按同一套清洗重发一次。
 * 模型 id 不像 grok 的自定义 LiteLLM 路由靠这条兜底；onRetry 后由
 * active-strip 在后续 turn 发送前预洗。
 */
export function createXaiModelInputRecoveryRule(
  opts: {
    enabled?: () => boolean;
    onRetry?: (threadId: string, model: string) => void;
    threadIdHeaders?: readonly string[];
    supportsReasoningForModel?: (model: unknown) => boolean;
  } = {},
): RecoveryRule {
  return {
    id: "xai_model_input",
    enabled: opts.enabled ?? (() => true),
    matches: (text) => XAI_MODEL_INPUT_RE.test(text),
    strip: (rawBody) =>
      sanitizeXaiModelInputFromBody(rawBody, {
        supportsReasoningForModel: opts.supportsReasoningForModel,
      }),
    onRetry: opts.onRetry,
    threadIdHeaders: opts.threadIdHeaders,
    applyOnUnmatchedRetry: false,
  };
}
