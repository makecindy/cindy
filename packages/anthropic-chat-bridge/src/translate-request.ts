/**
 * 请求翻译 —— Anthropic Messages API → OpenAI Chat Completions。
 *
 * 映射总览:
 *   system                    → 首条 { role: system|developer, content } 消息
 *   messages[]                → Chat 消息序列(按 block 顺序拆出 tool 消息)
 *   user text                 → { role:'user', content }
 *   user image                → user 消息 content 里的 image_url part(data URL)
 *   user tool_result          → { role:'tool', tool_call_id, content }(独立消息)
 *   assistant text            → { role:'assistant', content }
 *   assistant tool_use        → assistant 消息的 tool_calls[](同消息内与文本共存)
 *   assistant thinking        → assistant 消息的 reasoning_content(capability 开启时)
 *   tools[].input_schema      → Chat tools[].function.parameters
 *   tool_choice               → tool_choice(auto / required / 指名 function / none)
 *   thinking.budget_tokens    → reasoning 参数(capability.reasoningField 控制,默认不发)
 *   max_tokens                → max_tokens / max_completion_tokens(capability 控制)
 *   (恒定)                    → stream:true + stream_options.include_usage
 *
 * 消息形态差异处理:
 *   - Anthropic 的 tool_result 嵌在 user 消息里;Chat 需要独立 `tool` 角色消息。
 *     拆分后原 user 消息的剩余文本留在原 user 消息中(顺序保持:assistant(tool_calls)
 *     → tool → user(text) → ... 天然满足 Chat 的交替要求)。
 *   - 纯 tool_result 的 user 消息拆成 tool 消息后不再产生空 user 消息。
 *   - Chat 兼容端点普遍要求消息序列以 user/system 开头;极端情况下首条为
 *     assistant 时前插一条空 user 消息(防御,Claude Code 正常不会触发)。
 */

import type {
  AnthropicChatBridgeCapabilities,
  AnthropicContentBlock,
  AnthropicMessagesRequest,
  AnthropicToolChoice,
  ChatAssistantMessage,
  ChatCompletionsRequest,
  ChatMessage,
  ChatToolCall,
  ChatUserContentPart,
} from './types.js';

/** system(string 或 text block 数组)拍平成字符串。 */
function systemToText(system: AnthropicMessagesRequest['system']): string | undefined {
  if (system == null) return undefined;
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system
      .map((b) => (b && typeof b === 'object' && typeof b.text === 'string' ? b.text : ''))
      .filter(Boolean)
      .join('\n\n');
  }
  return undefined;
}

/** tool_result.content(string / block 数组)拍平成 Chat tool 消息需要的字符串。 */
function toolResultToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const rec = b as Record<string, unknown>;
          if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
          // 工具结果里嵌图片等非文本内容:Chat 的 tool 消息 content 只吃字符串,
          // 退化成占位描述,不丢整条(模型仍知道该工具产出过内容)。文案与
          // anthropic-responses-bridge 同构:不带说明的 '[image]' 会被模型当作
          // 空结果,诱发反复重读或臆测图像内容。
          if (rec.type === 'image') {
            return (
              '[image omitted: this tool returned an image, but tool results on this '
              + 'provider route are delivered as plain text only, so the image data could '
              + 'not be included. Do NOT guess or fabricate what the image contains. '
              + 'Tell the user the image could not be delivered on the current route, and '
              + 'ask them to paste the relevant content as text or attach the image '
              + 'directly to a chat message instead.]'
            );
          }
          return JSON.stringify(rec);
        }
        return String(b);
      })
      .join('\n');
  }
  try {
    return JSON.stringify(content);
  } catch {
    return String(content);
  }
}

/** Anthropic image block → Chat image_url part 的 data URL。 */
function imageToDataUrl(block: Extract<AnthropicContentBlock, { type: 'image' }>): string | null {
  const src = block.source;
  if (!src) return null;
  if (src.type === 'url' && src.url) return src.url;
  if (src.type === 'base64' && src.data) {
    const mt = src.media_type ?? 'image/png';
    return `data:${mt};base64,${src.data}`;
  }
  return null;
}

/** image 输入关闭时的占位文本:图片被丢弃必须显式告知模型,不能静默丢上下文。 */
const IMAGE_OMITTED_PLACEHOLDER =
  '[image omitted: this provider route does not accept image input, so the attached '
  + 'image could not be included. Do NOT guess what the image contains.]';

function imagePlaceholderText(block: Extract<AnthropicContentBlock, { type: 'image' }>): string {
  const src = block.source;
  if (src?.type === 'url' && src.url) return `${IMAGE_OMITTED_PLACEHOLDER} (image URL: ${src.url})`;
  return IMAGE_OMITTED_PLACEHOLDER;
}

function toolChoiceToChat(tc: AnthropicToolChoice | undefined): unknown {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', function: { name: tc.name } };
    default:
      return undefined;
  }
}

/** thinking.budget_tokens → reasoning 档位(与 anthropic-responses-bridge 同口径)。 */
function budgetToEffort(thinking: AnthropicMessagesRequest['thinking']): 'low' | 'medium' | 'high' {
  if (!thinking || thinking.type !== 'enabled') return 'medium';
  const b = thinking.budget_tokens ?? 0;
  if (b <= 0) return 'medium';
  if (b <= 4096) return 'low';
  if (b <= 16384) return 'medium';
  return 'high';
}

export interface TranslateRequestOptions {
  /** 发给上游的真实 model id(已 strip 掉 bridge 前缀)。 */
  model: string;
  capabilities?: AnthropicChatBridgeCapabilities;
}

/**
 * Anthropic Messages 请求 → Chat Completions 请求。
 *
 * `opts.model` 是已去前缀的真实 model id(bridge 层负责 strip),不直接用 req.model。
 */
export function translateRequest(
  req: AnthropicMessagesRequest,
  opts: TranslateRequestOptions,
): ChatCompletionsRequest {
  const caps = opts.capabilities ?? {};
  const developerRole = caps.developerRole ?? 'system';
  // 图片是 Anthropic 输入的核心形态,Chat 兼容层普遍支持 image_url —— 默认开启。
  const imageInput = caps.imageInput ?? 'image_url';
  const messages: ChatMessage[] = [];

  // 顶层 system → 首条消息(合并置首,对齐 cc-switch 的 anthropic→openai 行为)。
  const systemText = systemToText(req.system);
  if (systemText) {
    messages.push({ role: developerRole, content: systemText });
  }

  for (const msg of req.messages ?? []) {
    if (typeof msg.content === 'string') {
      // 空字符串消息(Chat 端点会 400 空 content)直接跳过 —— 不丢语义。
      if (msg.content.length === 0) continue;
      if (msg.role === 'system') {
        messages.push({ role: developerRole, content: msg.content });
      } else {
        messages.push({ role: msg.role, content: msg.content });
      }
      continue;
    }

    if (msg.role === 'user') {
      const userParts: ChatUserContentPart[] = [];
      let pendingTool: { tool_use_id: string; content: string } | null = null;
      const flushTool = (): void => {
        if (!pendingTool) return;
        messages.push({
          role: 'tool',
          tool_call_id: pendingTool.tool_use_id,
          content: pendingTool.content,
        });
        pendingTool = null;
      };
      // 纯文本单 part 收敛成字符串 content(上游兼容性最好);含图片等多 part 才用数组。
      const flushUser = (): void => {
        if (userParts.length === 0) return;
        const content: string | ChatUserContentPart[] =
          userParts.length === 1 && userParts[0].type === 'text'
            ? userParts[0].text
            : [...userParts];
        messages.push({ role: 'user', content });
        userParts.length = 0;
      };
      for (const block of msg.content) {
        switch (block.type) {
          case 'text': {
            const text = (block as { text?: string }).text ?? '';
            if (text) userParts.push({ type: 'text', text });
            break;
          }
          case 'image': {
            if (imageInput === 'image_url') {
              const url = imageToDataUrl(block as Extract<AnthropicContentBlock, { type: 'image' }>);
              if (url) userParts.push({ type: 'image_url', image_url: { url } });
              else userParts.push({ type: 'text', text: imagePlaceholderText(block as Extract<AnthropicContentBlock, { type: 'image' }>) });
            } else {
              userParts.push({ type: 'text', text: imagePlaceholderText(block as Extract<AnthropicContentBlock, { type: 'image' }>) });
            }
            break;
          }
          case 'tool_result': {
            // tool_result 必须在当前 user 文本之前落位(Anthropic block 顺序即语义顺序):
            // 先 flush 已累积的 user parts,再发 tool 消息,保持 tool → user 交替。
            flushUser();
            flushTool();
            const tr = block as Extract<AnthropicContentBlock, { type: 'tool_result' }>;
            pendingTool = {
              tool_use_id: tr.tool_use_id,
              content: toolResultToString(tr.content),
            };
            break;
          }
          default:
            // 未知 block 类型:忽略(不阻断整条请求)。
            break;
        }
      }
      flushTool();
      flushUser();
      continue;
    }

    if (msg.role === 'assistant') {
      const textParts: string[] = [];
      let reasoning: string | undefined;
      const toolCalls: ChatToolCall[] = [];
      for (const block of msg.content) {
        switch (block.type) {
          case 'text': {
            const text = (block as { text?: string }).text ?? '';
            if (text) textParts.push(text);
            break;
          }
          case 'thinking': {
            if (caps.reasoningHistoryField === 'reasoning_content') {
              const th = block as Extract<AnthropicContentBlock, { type: 'thinking' }>;
              // 无可见文本的 thinking 不回放(占位无意义);有文本才带。
              if (th.thinking) reasoning = (reasoning ? `${reasoning}\n` : '') + th.thinking;
            }
            break;
          }
          case 'tool_use': {
            const tu = block as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
            toolCalls.push({
              id: tu.id,
              type: 'function',
              function: {
                name: tu.name,
                arguments: JSON.stringify(tu.input ?? {}),
              },
            });
            break;
          }
          default:
            // redacted_thinking(无可回放文本)及其它未知块:忽略。
            break;
        }
      }
      const hasContent = textParts.length > 0;
      const hasToolCalls = toolCalls.length > 0;
      if (!hasContent && !hasToolCalls && !reasoning) continue;
      const out: ChatAssistantMessage = { role: 'assistant' };
      // 带 tool_calls 时 content 置 null 而非空串 —— 严格端点对空字符串 content 400,
      // 对 null 则按「无文本」处理(OpenAI 官方行为)。
      if (hasContent) out.content = textParts.join('\n');
      else if (hasToolCalls) out.content = null;
      if (reasoning) out.reasoning_content = reasoning;
      else if (caps.toolCallReasoningPlaceholder && hasToolCalls) {
        // DeepSeek/Kimi 思考模型:带 tool_calls 的 assistant 消息必须有非空
        // reasoning_content,否则上游 400。注入占位。
        out.reasoning_content = ' ';
      }
      if (hasToolCalls) out.tool_calls = toolCalls;
      messages.push(out);
      continue;
    }
  }

  // 防御:Chat 兼容端点普遍要求消息序列以 user/system 开头。Anthropic 正常请求总是
  // 以 user 开头,但极端历史(截断/合成)可能以 assistant/tool 起首 —— 前插空 user。
  if (messages.length > 0 && messages[0].role !== 'user' && messages[0].role !== 'system' && messages[0].role !== 'developer') {
    messages.unshift({ role: 'user', content: '' });
  }

  const out: ChatCompletionsRequest = {
    model: opts.model,
    messages,
    // 恒 stream:handler 的响应翻译只解析 SSE(非流式 JSON 会被静默丢成空响应),
    // 与 anthropic-responses-bridge 同口径。
    stream: true,
  };

  if (caps.streamUsage !== false) out.stream_options = { include_usage: true };

  const tools = (req.tools ?? []).map((t) => ({
    type: 'function' as const,
    function: {
      name: t.name,
      ...(t.description ? { description: t.description } : {}),
      parameters: t.input_schema ?? { type: 'object', properties: {} },
      ...(t.input_schema?.strict === true ? { strict: true } : {}),
    },
  }));
  if (tools.length > 0) {
    out.tools = tools;
    out.parallel_tool_calls = true;
  }

  const toolChoice = toolChoiceToChat(req.tool_choice);
  if (toolChoice !== undefined && tools.length > 0) out.tool_choice = toolChoice;
  else if (req.tool_choice?.type === 'none') out.tool_choice = 'none';

  // thinking → 上游 reasoning 参数(reasoningField 控制;默认 'none' 不发)。
  const reasoningField = caps.reasoningField ?? 'none';
  if (reasoningField !== 'none' && req.thinking) {
    const enabled = req.thinking.type === 'enabled';
    switch (reasoningField) {
      case 'reasoning_effort':
        out.reasoning_effort = enabled ? budgetToEffort(req.thinking) : 'low';
        break;
      case 'reasoning.effort':
        out.reasoning = { effort: enabled ? budgetToEffort(req.thinking) : 'low' };
        break;
      case 'thinking.type':
        out.thinking = { type: enabled ? 'enabled' : 'disabled' };
        break;
      case 'enable_thinking':
        out.enable_thinking = enabled;
        break;
    }
  }

  const maxTokensField = caps.maxTokensField ?? 'max_tokens';
  if (maxTokensField !== 'omit' && typeof req.max_tokens === 'number' && req.max_tokens > 0) {
    if (maxTokensField === 'max_completion_tokens') out.max_completion_tokens = req.max_tokens;
    else out.max_tokens = req.max_tokens;
  }

  if (typeof req.temperature === 'number') out.temperature = req.temperature;

  return out;
}
