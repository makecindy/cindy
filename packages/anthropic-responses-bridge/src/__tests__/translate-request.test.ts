import { describe, expect, it } from 'vitest';

import { translateRequest } from '../translate-request.js';
import type { AnthropicMessagesRequest } from '../types.js';

describe('translateRequest', () => {
  it('maps system → instructions and user text → input_text', () => {
    const req: AnthropicMessagesRequest = {
      model: 'chatgpt/gpt-5.5',
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = translateRequest(req, { model: 'gpt-5.5' });
    expect(out.model).toBe('gpt-5.5');
    expect(out.instructions).toBe('You are terse.');
    expect(out.store).toBe(false);
    expect(out.include).toContain('reasoning.encrypted_content');
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hi' }] },
    ]);
  });

  it('joins array-form system blocks', () => {
    const req: AnthropicMessagesRequest = {
      model: 'gpt-5.5',
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
      messages: [{ role: 'user', content: 'x' }],
    };
    expect(translateRequest(req, { model: 'gpt-5.5' }).instructions).toBe('A\n\nB');
  });

  it('maps assistant tool_use → function_call and user tool_result → function_call_output', () => {
    const req: AnthropicMessagesRequest = {
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'checking' },
            { type: 'tool_use', id: 'call_1', name: 'get_weather', input: { city: 'Tokyo' } },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'sunny' }],
        },
      ],
    };
    const out = translateRequest(req, { model: 'gpt-5.5' });
    expect(out.input).toEqual([
      { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'weather?' }] },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
      { type: 'function_call', name: 'get_weather', arguments: JSON.stringify({ city: 'Tokyo' }), call_id: 'call_1' },
      { type: 'function_call_output', call_id: 'call_1', output: 'sunny' },
    ]);
  });

  it('round-trips thinking (signature→encrypted_content) and redacted_thinking (data→encrypted_content),按 provider 前缀剥壳', () => {
    const req: AnthropicMessagesRequest = {
      model: 'chatgpt/gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: [
            // signature 带出处前缀(translate-sse 发射时打的,见 signaturePrefix)。
            { type: 'thinking', thinking: 'let me think', signature: 'chatgpt/ENC_A' },
            { type: 'redacted_thinking', data: 'chatgpt/ENC_B' },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'gpt-5.5', providerPrefix: 'chatgpt/' });
    expect(out.input).toEqual([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'let me think' }], encrypted_content: 'ENC_A' },
      { type: 'reasoning', summary: [], encrypted_content: 'ENC_B' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ]);
  });

  it('blob 带 `#id=rs_...#` 头 → 回放时还原原始 reasoning item id(OpenAI stateless 约定);无头老 blob 兼容', () => {
    const req: AnthropicMessagesRequest = {
      model: 'chatgpt/gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: [
            // 新格式:translate-sse 把上游 item id 编进 blob 头。
            { type: 'thinking', thinking: 'step', signature: 'chatgpt/#id=rs_abc123#ENC_A' },
            { type: 'redacted_thinking', data: 'chatgpt/#id=rs_def456#ENC_B' },
            // 老格式(无 id 头):照旧回放,不带 id。
            { type: 'thinking', thinking: 'legacy', signature: 'chatgpt/ENC_LEGACY' },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'gpt-5.5', providerPrefix: 'chatgpt/' });
    expect(out.input).toEqual([
      { type: 'reasoning', id: 'rs_abc123', summary: [{ type: 'summary_text', text: 'step' }], encrypted_content: 'ENC_A' },
      { type: 'reasoning', id: 'rs_def456', summary: [], encrypted_content: 'ENC_B' },
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'legacy' }], encrypted_content: 'ENC_LEGACY' },
    ]);
  });

  it('无 signature 的 thinking 不回放(出处无法证明,与出处不匹配同样丢弃,不合成 summary-only item)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'chatgpt/gpt-5.5',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'visible thinking without signature' },
            { type: 'text', text: 'answer' },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'gpt-5.5', providerPrefix: 'chatgpt/' });
    expect(out.input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'answer' }] },
    ]);
  });

  it('出处不匹配的 reasoning blob 不回放(别家 provider / Anthropic 原生 thinking → 上游必 400)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'xai/grok-4.3',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: 'from codex', signature: 'chatgpt/ENC_A' }, // 别家 bridge provider
            { type: 'thinking', thinking: 'from opus', signature: 'AnthropicSigBase64' }, // Anthropic 原生
            { type: 'redacted_thinking', data: 'chatgpt/ENC_B' },
            { type: 'thinking', thinking: 'mine', signature: 'xai/ENC_C' }, // 本家:回放
            { type: 'text', text: 'done' },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'grok-4.3', providerPrefix: 'xai/' });
    expect(out.input).toEqual([
      { type: 'reasoning', summary: [{ type: 'summary_text', text: 'mine' }], encrypted_content: 'ENC_C' },
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'done' }] },
    ]);
  });

  it("reasoningEffort 'none' 时不回放任何 reasoning item(模型不支持 reasoning)", () => {
    const req: AnthropicMessagesRequest = {
      model: 'xai/grok-code-fast',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 't', signature: 'xai/ENC' }, { type: 'text', text: 'ok' }] },
      ],
    };
    const out = translateRequest(req, { model: 'grok-code-fast', providerPrefix: 'xai/', reasoningEffort: 'none' });
    expect(out.input).toEqual([
      { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ok' }] },
    ]);
  });

  it('maps tools + tool_choice and flattens tool_result content blocks', () => {
    const req: AnthropicMessagesRequest = {
      model: 'gpt-5.5',
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: { a: { type: 'string' } } } }],
      tool_choice: { type: 'any' },
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: [{ type: 'text', text: 'r1' }, { type: 'text', text: 'r2' }] }] },
      ],
    };
    const out = translateRequest(req, { model: 'gpt-5.5' });
    expect(out.tools).toEqual([
      { type: 'function', name: 'f', description: 'd', strict: false, parameters: { type: 'object', properties: { a: { type: 'string' } } } },
    ]);
    expect(out.tool_choice).toBe('required');
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.input).toEqual([{ type: 'function_call_output', call_id: 'c1', output: 'r1\nr2' }]);
  });

  it('serverSideTools 恒定追加在 function tools 之后(位置固定 → 前缀稳定)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'xai/grok-4.5',
      tools: [{ name: 'f', description: 'd', input_schema: { type: 'object', properties: {} } }],
      tool_choice: { type: 'auto' },
      messages: [],
    };
    const out = translateRequest(req, { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] });

    expect(out.tools).toEqual([
      { type: 'function', name: 'f', description: 'd', strict: false, parameters: { type: 'object', properties: {} } },
      { type: 'x_search' },
    ]);
    // 本地 function tool 仍在 → 调用策略字段照发。
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.tool_choice).toBe('auto');
  });

  it('tool_choice:any + 唯一 function tool → 收窄成指名该 function,工具声明不动', () => {
    // required 作用于整个 tools 数组:带上 x_search 的话上游可以只跑搜索就满足 required,
    // 调用方强制要的那次本地 function call 永远不发生。解法是收窄 tool_choice,
    // 而不是摘掉服务端工具——后者会让 tools 前缀在会话中途变动、prompt 缓存全程失效。
    const out = translateRequest(
      {
        model: 'xai/grok-4.5',
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'any' },
        messages: [],
      },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tool_choice).toEqual({ type: 'function', name: 'f' });
    // 服务端工具照常声明:它只由 model 决定,不因某一轮的 tool_choice 增删。
    expect(out.tools?.at(-1)).toEqual({ type: 'x_search' });
  });

  it('tool_choice:any + 多个 function tool → 保留 required,工具声明仍不动(前缀稳定优先)', () => {
    // Responses 无法表达「required 但只限这几个」;此时保留 required 并接受残余风险,
    // 不为它牺牲 tools 声明的跨轮稳定性。
    const out = translateRequest(
      {
        model: 'xai/grok-4.5',
        tools: [
          { name: 'f1', input_schema: { type: 'object', properties: {} } },
          { name: 'f2', input_schema: { type: 'object', properties: {} } },
        ],
        tool_choice: { type: 'any' },
        messages: [],
      },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tool_choice).toBe('required');
    expect(out.tools?.at(-1)).toEqual({ type: 'x_search' });
  });

  it('没有服务端工具时 tool_choice:any 原样保持 required(不做多余收窄)', () => {
    const out = translateRequest(
      {
        model: 'chatgpt/gpt-5.5',
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'any' },
        messages: [],
      },
      { model: 'gpt-5.5' },
    );
    expect(out.tool_choice).toBe('required');
  });

  it('tool_choice 指名具体 function / auto 时仍附加服务端工具(不会被顶替)', () => {
    const named = translateRequest(
      {
        model: 'xai/grok-4.5',
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'tool', name: 'f' },
        messages: [],
      },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(named.tool_choice).toEqual({ type: 'function', name: 'f' });
    expect(named.tools?.at(-1)).toEqual({ type: 'x_search' });

    const auto = translateRequest(
      {
        model: 'xai/grok-4.5',
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'auto' },
        messages: [],
      },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(auto.tools?.at(-1)).toEqual({ type: 'x_search' });
  });

  it('tool_choice:none 且没有 function tool → 仍下发 none(否则等于放开服务端工具)', () => {
    // none 是调用方显式禁止用工具;我们仍会声明 x_search(声明只由 model 决定),
    // 不把 none 传下去就等于把调用方的禁令反过来。
    const out = translateRequest(
      { model: 'xai/grok-4.5', tool_choice: { type: 'none' }, messages: [] },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tools).toEqual([{ type: 'x_search' }]);
    expect(out.tool_choice).toBe('none');
    // parallel_tool_calls 只描述本地 function tool 的并行策略,纯服务端工具轮不发。
    expect(out.parallel_tool_calls).toBeUndefined();
  });

  it('tool_choice:none 且有 function tool → 照常下发 none', () => {
    const out = translateRequest(
      {
        model: 'xai/grok-4.5',
        tools: [{ name: 'f', input_schema: { type: 'object', properties: {} } }],
        tool_choice: { type: 'none' },
        messages: [],
      },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tool_choice).toBe('none');
  });

  it('tool_choice:{type:tool} 但没有 function tool → 不下发(会指向不存在的 function)', () => {
    const out = translateRequest(
      { model: 'xai/grok-4.5', tool_choice: { type: 'tool', name: 'ghost' }, messages: [] },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tool_choice).toBeUndefined();
  });

  it('tool_choice:any 但请求没带 function tool → 服务端工具照常下发,且不发 tool_choice', () => {
    const out = translateRequest(
      { model: 'xai/grok-4.5', tool_choice: { type: 'any' }, messages: [] },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );
    expect(out.tools).toEqual([{ type: 'x_search' }]);
    expect(out.tool_choice).toBeUndefined();
  });

  it('纯服务端工具轮(请求没带 function tool)也下发 tools,但不发 tool_choice / parallel_tool_calls', () => {
    const out = translateRequest(
      { model: 'xai/grok-4.5', messages: [] },
      { model: 'grok-4.5', serverSideTools: [{ type: 'x_search' }] },
    );

    expect(out.tools).toEqual([{ type: 'x_search' }]);
    // tool_choice 只描述本地 function tool 的调用策略;没有 function tool 时发它会指向不存在的工具。
    expect(out.tool_choice).toBeUndefined();
    expect(out.parallel_tool_calls).toBeUndefined();
  });

  it('不传 serverSideTools 时 tools 行为与改造前一致(空数组不落 tools 字段)', () => {
    const out = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5' });
    expect(out.tools).toBeUndefined();

    const empty = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5', serverSideTools: [] });
    expect(empty.tools).toBeUndefined();
  });

  it('maps thinking budget → reasoning effort', () => {
    const low = translateRequest(
      { model: 'gpt-5.5', messages: [], thinking: { type: 'enabled', budget_tokens: 2000 } },
      { model: 'gpt-5.5' },
    );
    expect(low.reasoning?.effort).toBe('low');

    const high = translateRequest(
      { model: 'gpt-5.5', messages: [], thinking: { type: 'enabled', budget_tokens: 30000 } },
      { model: 'gpt-5.5' },
    );
    expect(high.reasoning?.effort).toBe('high');
  });

  it('max_tokens 默认不发(codex 端点不支持),置 maxOutputTokensSupported 才发', () => {
    const omitted = translateRequest({ model: 'gpt-5.5', messages: [], max_tokens: 4096 }, { model: 'gpt-5.5' });
    expect(omitted.max_output_tokens).toBeUndefined();

    const included = translateRequest(
      { model: 'gpt-5.5', messages: [], max_tokens: 4096 },
      { model: 'gpt-5.5', maxOutputTokensSupported: true },
    );
    expect(included.max_output_tokens).toBe(4096);
  });

  it('role:"system" 消息 → developer(codex 拒绝 system 角色);string / block 内容都覆盖', () => {
    // CC 会在 messages 里塞 role:"system"(ToolSearch 提醒等),content 常是 string。
    const strForm = translateRequest(
      { model: 'gpt-5.5', messages: [{ role: 'system', content: 'deferred tools available' }] },
      { model: 'gpt-5.5' },
    );
    expect(strForm.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'deferred tools available' }] },
    ]);
    // block-array 形式的 system 消息同样映射到 developer + input_text。
    const blockForm = translateRequest(
      { model: 'gpt-5.5', messages: [{ role: 'system', content: [{ type: 'text', text: 'note' }] }] },
      { model: 'gpt-5.5' },
    );
    expect(blockForm.input).toEqual([
      { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'note' }] },
    ]);
  });

  it('reasoningEffort 控制:具体档 / none(不发)/ 默认', () => {
    const high = translateRequest({ model: 'grok-4.3', messages: [] }, { model: 'grok-4.3', reasoningEffort: 'high' });
    expect(high.reasoning).toEqual({ effort: 'high', summary: 'auto' });

    // grok-code-fast 这类不支持 reasoning 的模型 → 完全不发 reasoning 字段(否则上游 400)
    const none = translateRequest({ model: 'grok-code-fast', messages: [] }, { model: 'grok-code-fast', reasoningEffort: 'none' });
    expect(none.reasoning).toBeUndefined();

    // 省略 → 回退默认(medium)
    const dflt = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5' });
    expect(dflt.reasoning).toEqual({ effort: 'medium', summary: 'auto' });
  });

  it('passes promptCacheKey through', () => {
    const out = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5', promptCacheKey: 'sess-1' });
    expect(out.prompt_cache_key).toBe('sess-1');
  });

  it('serviceTier(Fast)传入才发 service_tier,省略不发', () => {
    const fast = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5', serviceTier: 'priority' });
    expect(fast.service_tier).toBe('priority');

    const normal = translateRequest({ model: 'gpt-5.5', messages: [] }, { model: 'gpt-5.5' });
    expect(normal.service_tier).toBeUndefined();
  });
});
