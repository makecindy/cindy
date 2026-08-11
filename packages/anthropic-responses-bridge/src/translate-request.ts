/**
 * 请求翻译 —— Anthropic Messages API → OpenAI Responses API。
 *
 * 映射总览:
 *   system                    → instructions
 *   messages[]                → input[](按 block 顺序拆成 message / function_call /
 *                               function_call_output / reasoning 四种 item)
 *   tools[].input_schema      → function tools[].parameters
 *   (provider 声明)            → 追加在 function tools 之后的上游服务端工具(如 xAI x_search)
 *   tool_choice               → tool_choice
 *   thinking.budget_tokens    → reasoning.effort
 *   max_tokens                → max_output_tokens
 *   (恒定)                    → store:false + include:[reasoning.encrypted_content]
 *
 * reasoning 往返约定(与 translate-sse.ts 对称):
 *   - Anthropic `thinking` block  ↔ Responses `reasoning` item(summary=可见文本,
 *     encrypted_content 存在 thinking.signature 里)
 *   - Anthropic `redacted_thinking` block ↔ 无可见 summary 的 reasoning item
 *     (encrypted_content 存在 redacted_thinking.data 里)
 */

import type {
  AnthropicContentBlock,
  AnthropicMessage,
  AnthropicMessagesRequest,
  AnthropicToolChoice,
  ResponsesContentPart,
  ResponsesFunctionTool,
  ResponsesInputItem,
  ResponsesRequest,
  ResponsesServerTool,
  ResponsesTool,
  ResponsesToolChoice,
} from './types.js';

/** system(string 或 text block 数组)拍平成 instructions 字符串。 */
function systemToInstructions(system: AnthropicMessagesRequest['system']): string | undefined {
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

/** tool_result.content(string / block 数组)拍平成 function_call_output 需要的字符串。 */
function toolResultToString(content: unknown): string {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (b && typeof b === 'object') {
          const rec = b as Record<string, unknown>;
          if (rec.type === 'text' && typeof rec.text === 'string') return rec.text;
          // 工具结果里嵌图片等非文本内容:Responses 的 function_call_output 只吃字符串,
          // 退化成占位描述,不丢整条(模型仍知道该工具产出过内容)。
          // 占位文案必须说明「有图但送不到、不要猜」:字符串限制是协议层的,与模型
          // 是否具备视觉能力无关;不带说明的 '[image]' 会被模型当作空结果,诱发反复
          // 重读或臆测图像内容。图像走 user 消息路径仍可正常送达(input_image)。
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

/** Anthropic image block → Responses input_image 的 data URL。 */
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

/**
 * reasoning 回放控制:encrypted blob 是各上游私有状态,只回放「出处 = 当前 provider」的
 * (signature 带 provider 前缀,见 translate-sse 的 signaturePrefix);别家的(其它 bridge
 * provider / Anthropic 原生 thinking)整个 item 丢弃 —— 回放过去必被上游 400 拒收,
 * 丢 reasoning 不破坏会话正文。dropAll:模型不支持 reasoning(effort 'none')时全部不回放。
 */
interface ReasoningReplayOpts {
  providerPrefix: string;
  dropAll: boolean;
}

/**
 * 解 signature blob(去 provider 前缀后):可选 `#id=<rs_...>#` 头 + encrypted_content。
 * id 头由 translate-sse 发射时编入 —— OpenAI stateless 回放约定要求把完整 output item
 * (含原始 reasoning item id)带回 input,丢 id 上游可能拒收/忽略回放的 reasoning 状态。
 * 无头 blob(老会话 / 上游没给 id)向后兼容:整段即 encrypted_content。
 */
function splitReasoningBlob(blob: string): { id?: string; encrypted: string } {
  if (blob.startsWith('#id=')) {
    const end = blob.indexOf('#', 4);
    if (end > 4) return { id: blob.slice(4, end), encrypted: blob.slice(end + 1) };
  }
  return { encrypted: blob };
}

/**
 * 单条 message 的 content blocks → 有序的 Responses input items。
 *
 * text/image 会累积进一个「待 flush」的 content-part 缓冲,遇到 tool_use / tool_result /
 * thinking 这类需要独立 item 的 block 时先 flush,保证 item 间的时序与原始 block 顺序一致。
 */
function messageToInputItems(msg: AnthropicMessage, reasoning: ReasoningReplayOpts): ResponsesInputItem[] {
  const items: ResponsesInputItem[] = [];
  // codex /responses 拒绝 role:"system" → 映射到 "developer"(OpenAI 的 system 等价角色,实测 200)。
  const role: 'user' | 'assistant' | 'developer' = msg.role === 'system' ? 'developer' : msg.role;
  const isAssistant = role === 'assistant';

  // string content → 单一 message item
  if (typeof msg.content === 'string') {
    if (msg.content.length === 0) return items;
    const part: ResponsesContentPart = isAssistant
      ? { type: 'output_text', text: msg.content }
      : { type: 'input_text', text: msg.content };
    items.push({ type: 'message', role, content: [part] });
    return items;
  }

  let pending: ResponsesContentPart[] = [];
  const flush = () => {
    if (pending.length === 0) return;
    items.push({ type: 'message', role, content: pending });
    pending = [];
  };

  for (const block of msg.content) {
    switch (block.type) {
      case 'text': {
        const text = (block as { text?: string }).text ?? '';
        pending.push(isAssistant ? { type: 'output_text', text } : { type: 'input_text', text });
        break;
      }
      case 'image': {
        const url = imageToDataUrl(block as Extract<AnthropicContentBlock, { type: 'image' }>);
        if (url) pending.push({ type: 'input_image', image_url: url });
        break;
      }
      case 'tool_use': {
        flush();
        const tu = block as Extract<AnthropicContentBlock, { type: 'tool_use' }>;
        items.push({
          type: 'function_call',
          name: tu.name,
          arguments: JSON.stringify(tu.input ?? {}),
          call_id: tu.id,
        });
        break;
      }
      case 'tool_result': {
        flush();
        const tr = block as Extract<AnthropicContentBlock, { type: 'tool_result' }>;
        items.push({
          type: 'function_call_output',
          call_id: tr.tool_use_id,
          output: toolResultToString(tr.content),
        });
        break;
      }
      case 'thinking': {
        flush();
        if (reasoning.dropAll) break;
        const th = block as Extract<AnthropicContentBlock, { type: 'thinking' }>;
        // signature 里回存的是上游给的 encrypted_content(带出处前缀,见 translate-sse)。
        // 出处不匹配(别家 provider / Anthropic 原生 thinking)→ 整个 item 不回放。
        // 无 signature 的 thinking(Anthropic 兼容源的可见思考 / 上游没给 encrypted_content)
        // 出处无法证明,与出处不匹配同样处理:整个 item 不回放,不合成 summary-only reasoning。
        if (!th.signature) break;
        if (!reasoning.providerPrefix || !th.signature.startsWith(reasoning.providerPrefix)) break;
        {
          const blob = splitReasoningBlob(th.signature.slice(reasoning.providerPrefix.length));
          items.push({
            type: 'reasoning',
            ...(blob.id ? { id: blob.id } : {}),
            summary: th.thinking ? [{ type: 'summary_text', text: th.thinking }] : [],
            encrypted_content: blob.encrypted,
          });
        }
        break;
      }
      case 'redacted_thinking': {
        flush();
        if (reasoning.dropAll) break;
        const rt = block as Extract<AnthropicContentBlock, { type: 'redacted_thinking' }>;
        if (!reasoning.providerPrefix || !rt.data.startsWith(reasoning.providerPrefix)) break;
        const blob = splitReasoningBlob(rt.data.slice(reasoning.providerPrefix.length));
        items.push({
          type: 'reasoning',
          ...(blob.id ? { id: blob.id } : {}),
          summary: [],
          encrypted_content: blob.encrypted,
        });
        break;
      }
      default:
        // 未知 block 类型:忽略(不阻断整条请求)。
        break;
    }
  }
  flush();
  return items;
}

function toolChoiceToResponses(tc: AnthropicToolChoice | undefined): ResponsesToolChoice | undefined {
  if (!tc) return undefined;
  switch (tc.type) {
    case 'auto':
      return 'auto';
    case 'any':
      return 'required';
    case 'none':
      return 'none';
    case 'tool':
      return { type: 'function', name: tc.name };
    default:
      return undefined;
  }
}

/** thinking.budget_tokens → reasoning effort 档位。无 thinking / 无 budget 时默认 medium。 */
function budgetToEffort(thinking: AnthropicMessagesRequest['thinking']): 'low' | 'medium' | 'high' {
  if (!thinking || thinking.type !== 'enabled') return 'medium';
  const b = thinking.budget_tokens ?? 0;
  if (b <= 0) return 'medium'; // enabled 但没给 budget:不知深浅,保持默认档,别烧 high
  if (b <= 4096) return 'low';
  if (b <= 16384) return 'medium';
  return 'high';
}

/**
 * 解析最终下发的 `tool_choice`,在**不动摇工具声明**的前提下尽量保住「强制调用本地工具」语义。
 *
 * Anthropic `tool_choice:{type:'any'}` → Responses `required`,意为「必须调用所提供工具之一」。
 * 但 Responses 的 required 作用于**整个** tools 数组:同时声明了服务端工具(如 x_search)时,
 * 上游可以靠跑一次搜索就满足 required,调用方强制要的那次本地 function call 永远不发生。
 *
 * 处理方式是收窄 tool_choice、而不是把服务端工具摘掉(摘掉会破坏 tools 前缀的跨轮稳定性):
 *   - 恰好只有一个 function tool → 直接指名它,语义完全等价且不可能被服务端工具顶替;
 *   - 有多个 function tool → Responses 无法表达「required 但只限这几个」,保留 required。
 *     残余风险:模型可能用服务端工具满足 required。相比让 tools 声明在会话中途变动(缓存全程
 *     失效、且违反 §3.1),这里选择保留声明稳定性并接受该残余风险。
 *   - `{type:'tool',name}` / `auto` / `none` 本就不会被服务端工具顶替,原样透传。
 */
function resolveToolChoice(
  raw: AnthropicToolChoice | undefined,
  functionTools: ResponsesFunctionTool[],
  hasServerSideTools: boolean,
): ResponsesToolChoice | undefined {
  const choice = toolChoiceToResponses(raw);
  if (choice !== 'required' || !hasServerSideTools) return choice;
  if (functionTools.length === 1) return { type: 'function', name: functionTools[0].name };
  return choice;
}

/** Responses 端点接受的 reasoning effort 档(codex / api.x.ai 通用)。 */
export type ResponsesReasoningEffort = 'low' | 'medium' | 'high' | 'xhigh';

export interface TranslateRequestOptions {
  /** 发给上游的真实 model id(已 strip 掉 bridge 前缀)。 */
  model: string;
  /** 稳定的 prompt cache key(同一会话跨轮复用,提升命中率);省略则不发。 */
  promptCacheKey?: string;
  /**
   * 上游是否支持 `max_output_tokens`。默认 false —— ChatGPT 订阅的
   * chatgpt.com/backend-api/codex 端点会对该参数返回 "Unsupported parameter: max_output_tokens" 400
   * (它自行管理输出长度)。标准 OpenAI Responses / 其它上游支持时可置 true。
   */
  maxOutputTokensSupported?: boolean;
  /**
   * reasoning 档控制:
   *   - 具体档('low'|'medium'|'high'|'xhigh')→ 发 `reasoning: { effort, summary:'auto' }`(用户选的思维深度经此流入);
   *   - `'none'` → **完全不发** reasoning 字段(某些模型如 xAI grok-code-fast 会对 reasoningEffort 报 400);
   *   - 省略(undefined)→ 回退到按 thinking.budget_tokens 推断(默认 medium),与旧行为一致。
   */
  reasoningEffort?: ResponsesReasoningEffort | 'none';
  /**
   * Fast 模式的 `service_tier` 值(如 codex 的 'priority');省略 = 不发该字段。
   * 由 bridge 层按「fast 头 × provider.fastServiceTier」解析后传入。
   */
  serviceTier?: string;
  /**
   * 当前 provider 的 model 前缀(如 'chatgpt/'),用于 reasoning blob 出处过滤(见
   * ReasoningReplayOpts):只回放本 provider 发出的 encrypted_content,别家的丢弃。
   * 省略 = 不回放任何带 signature 的 reasoning(保守:无法证明出处即不回放)。
   */
  providerPrefix?: string;
  /**
   * 上游自带的服务端工具声明(如 xAI 的 `{ type: 'x_search' }`),由 provider 配置按 model 决定。
   * 恒定追加在 function tools **之后**,顺序稳定,保证请求前缀在会话内逐轮一致。
   * 请求本身没有任何 function tool 时也会单独下发(纯服务端工具轮)。
   */
  serverSideTools?: ResponsesServerTool[];
}

/**
 * Anthropic Messages 请求 → Responses 请求。
 *
 * `opts.model` 是已去前缀的真实 model id(bridge 层负责 strip),不直接用 req.model。
 */
export function translateRequest(
  req: AnthropicMessagesRequest,
  opts: TranslateRequestOptions,
): ResponsesRequest {
  const input: ResponsesInputItem[] = [];
  const reasoningReplay: ReasoningReplayOpts = {
    providerPrefix: opts.providerPrefix ?? '',
    dropAll: opts.reasoningEffort === 'none',
  };
  for (const msg of req.messages ?? []) {
    input.push(...messageToInputItems(msg, reasoningReplay));
  }

  // 显式用 ResponsesFunctionTool(而非放宽后的 ResponsesTool 联合):function tool 的
  // name / parameters 等必填字段要在编译期被校验,别被服务端工具那个 `type: string`
  // 兜底分支放过去。
  const functionTools: ResponsesFunctionTool[] = (req.tools ?? []).map((t) => ({
    type: 'function',
    name: t.name,
    description: t.description,
    strict: false,
    parameters: t.input_schema ?? { type: 'object', properties: {} },
  }));
  // 服务端工具的声明**只由 model 决定**,不受任何单轮请求态(含 tool_choice)影响 ——
  // 这是 BridgeProviderConfig.serverSideTools 的契约,也是 prompt 前缀稳定性的前提:
  // 若某一轮因 tool_choice 把它摘掉、下一轮又装回来,同一会话的 tools 前缀就会来回变化,
  // 缓存全程失效(见 docs/dev-rules/maker-core-and-agent-behavior.md §3.1)。
  // 恒定排在 function tools 之后,位置固定。
  const serverSideTools = opts.serverSideTools ?? [];
  const tools: ResponsesTool[] = [...functionTools, ...serverSideTools];
  const toolChoice = resolveToolChoice(req.tool_choice, functionTools, serverSideTools.length > 0);

  const out: ResponsesRequest = {
    model: opts.model,
    input,
    store: false,
    // 上游**恒流式**,与调用方的 stream 无关。chatgpt.com/backend-api/codex 对
    // stream:false 直接 400 `{"detail":"Stream must be set to true"}`(2026-08-10 实测,
    // gpt-5.5 与 gpt-5.6-sol 一致),SSE 是这些订阅上游唯一可用的响应形态。
    // 调用方的非流式需求(Claude Code stream watchdog 的 fallback)由 handler 在**下游**
    // 把整流缓冲成单个 Anthropic Message JSON 满足,不靠上游换模式。
    stream: true,
    include: ['reasoning.encrypted_content'],
  };

  // reasoning:'none' → 完全不发(模型不支持 reasoningEffort);具体档 → 用它;undefined → 回退 budget 推断。
  if (opts.reasoningEffort !== 'none') {
    out.reasoning = { effort: opts.reasoningEffort ?? budgetToEffort(req.thinking), summary: 'auto' };
  }
  if (opts.serviceTier) out.service_tier = opts.serviceTier;

  const instructions = systemToInstructions(req.system);
  if (instructions) out.instructions = instructions;
  if (tools.length > 0) out.tools = tools;
  // parallel_tool_calls 只描述**本地 function tool** 的并行策略,纯服务端工具轮不发。
  if (functionTools.length > 0) out.parallel_tool_calls = true;
  // tool_choice:
  //   - 有 function tool → 原样下发(含 required / 指名 function / auto / none);
  //   - 没有 function tool → 只下发 `none`。`none` 是调用方**显式禁止用工具**,而我们仍会
  //     声明服务端工具(声明只由 model 决定,见上),不把 none 传下去就等于放开 x_search、
  //     把调用方的禁令反过来了。其余档在无 function tool 时不发:指名 function 会指向不存在
  //     的工具;required 则会把「必须用工具」落到服务端工具上,等于替调用方决定去搜一次。
  if (toolChoice && (functionTools.length > 0 || toolChoice === 'none')) {
    out.tool_choice = toolChoice;
  }
  if (opts.maxOutputTokensSupported && typeof req.max_tokens === 'number' && req.max_tokens > 0) {
    out.max_output_tokens = req.max_tokens;
  }
  if (opts.promptCacheKey) out.prompt_cache_key = opts.promptCacheKey;

  return out;
}
