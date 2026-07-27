import { describe, expect, it } from 'vitest';

import { translateResponsesRequest } from '../translate-request.js';
import { UnsupportedResponsesFeatureError, type ResponsesRequest } from '../types.js';

function base(overrides: Partial<ResponsesRequest> = {}): ResponsesRequest {
  return {
    model: 'deepseek-chat',
    input: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'hello' }] }],
    ...overrides,
  };
}

describe('translateResponsesRequest', () => {
  it('maps instructions, messages, tools and supported tuning fields', () => {
    const source = base({
      instructions: 'be concise',
      tools: [{ type: 'function', name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: true }],
      tool_choice: { type: 'function', name: 'Bash' },
      parallel_tool_calls: true,
      max_output_tokens: 128,
      reasoning: { effort: 'high' },
    });
    const out = translateResponsesRequest(source, {
      capabilities: {
        developerRole: 'developer',
        parallelToolCalls: true,
        maxTokensField: 'max_completion_tokens',
        reasoningField: 'reasoning_effort',
        streamUsage: true,
      },
    });
    expect(out).toEqual({
      model: 'deepseek-chat',
      messages: [
        { role: 'developer', content: 'be concise' },
        { role: 'user', content: 'hello' },
      ],
      stream: true,
      tools: [{
        type: 'function',
        function: { name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: true },
      }],
      tool_choice: { type: 'function', function: { name: 'Bash' } },
      parallel_tool_calls: true,
      max_completion_tokens: 128,
      reasoning_effort: 'high',
      stream_options: { include_usage: true },
    });
    expect(source.instructions).toBe('be concise');
  });

  it('downgrades developer-role input messages per capability (default system), not just instructions', () => {
    const source = base({
      instructions: 'top-level dev prompt',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'mid-conversation dev note' }] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    // 默认（未声明 developerRole）→ system：instructions 与 input 里的 developer 消息都降级为 system。
    const out = translateResponsesRequest(source);
    expect(out.messages).toEqual([
      { role: 'system', content: 'top-level dev prompt' },
      { role: 'system', content: 'mid-conversation dev note' },
      { role: 'user', content: 'hi' },
    ]);
    // 上游原生支持 developer 时（capability 显式声明）保留 developer。
    const keep = translateResponsesRequest(source, { capabilities: { developerRole: 'developer' } });
    expect(keep.messages[0]).toEqual({ role: 'developer', content: 'top-level dev prompt' });
    expect(keep.messages[1]).toEqual({ role: 'developer', content: 'mid-conversation dev note' });
  });

  it('converts assistant calls and tool outputs while keeping call ids', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'checking' }] },
        { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"pwd"}' },
        { type: 'function_call_output', call_id: 'call_1', output: { ok: true } },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    }));
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: 'checking',
        tool_calls: [{
          id: 'call_1',
          type: 'function',
          function: { name: 'Bash', arguments: '{"cmd":"pwd"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: '{"ok":true}' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('injects a reasoning_content placeholder on tool-call assistant messages for thinking models', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        { type: 'message', role: 'user', content: 'next' },
      ],
    }), { capabilities: { toolCallReasoningPlaceholder: true } });
    const assistant = out.messages[0] as { role: string; reasoning_content?: string; tool_calls?: unknown[] };
    // DeepSeek/Kimi 要求带 tool_calls 的 assistant 携带非空 reasoning_content,否则上游 400。
    expect(assistant.role).toBe('assistant');
    expect(assistant.reasoning_content).toBe('tool call');
    // 未开启该 capability 时不注入(标准 OpenAI 不需要)。
    const plain = translateResponsesRequest(base({
      input: [{ type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' }],
    }));
    expect((plain.messages[0] as { reasoning_content?: string }).reasoning_content).toBeUndefined();
  });

  it('injects the official Gemini thought-signature fallback on only the first call in each step', () => {
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'function_call',
          call_id: 'c1',
          name: 'Read',
          arguments: '{}',
          extra_content: {
            vendor: { cache_key: 'keep-me' },
            google: { other_extension: 'keep-me-too' },
          },
        },
        { type: 'function_call', call_id: 'c2', name: 'Search', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        { type: 'function_call_output', call_id: 'c2', output: 'ok' },
      ],
    }), { capabilities: { googleThoughtSignaturePlaceholder: true } });
    const assistant = out.messages[0] as {
      tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }>;
    };
    expect(assistant.tool_calls?.[0]?.extra_content).toEqual({
      vendor: { cache_key: 'keep-me' },
      google: {
        other_extension: 'keep-me-too',
        thought_signature: 'skip_thought_signature_validator',
      },
    });
    expect(assistant.tool_calls?.[1]?.extra_content).toBeUndefined();

    const plain = translateResponsesRequest(base({
      input: [{ type: 'function_call', call_id: 'c1', name: 'Read', arguments: '{}' }],
    }));
    expect(
      (plain.messages[0] as { tool_calls?: Array<{ extra_content?: unknown }> })
        .tool_calls?.[0]?.extra_content,
    ).toBeUndefined();
  });

  it.each([
    '',
    '   ',
    123,
    { malformed: true },
  ])('replaces an invalid Gemini thought signature: %j', (thoughtSignature) => {
    const out = translateResponsesRequest(base({
      input: [{
        type: 'function_call',
        call_id: 'c1',
        name: 'Read',
        arguments: '{}',
        extra_content: {
          google: { thought_signature: thoughtSignature as string },
        },
      }],
    }), { capabilities: { googleThoughtSignaturePlaceholder: true } });
    expect(
      (out.messages[0] as {
        tool_calls?: Array<{ extra_content?: { google?: { thought_signature?: string } } }>;
      }).tool_calls?.[0]?.extra_content?.google?.thought_signature,
    ).toBe('skip_thought_signature_validator');
  });

  it('drops malformed Google tool-call metadata instead of spreading it as an object', () => {
    const input = base({
      input: [{
        type: 'function_call',
        call_id: 'c1',
        name: 'Read',
        arguments: '{}',
        extra_content: {
          vendor: { cache_key: 'keep-me' },
          google: 'malformed',
        },
      }],
    });
    const plain = translateResponsesRequest(input);
    expect(
      (plain.messages[0] as { tool_calls?: Array<{ extra_content?: unknown }> })
        .tool_calls?.[0]?.extra_content,
    ).toEqual({ vendor: { cache_key: 'keep-me' } });

    const gemini = translateResponsesRequest(input, {
      capabilities: { googleThoughtSignaturePlaceholder: true },
    });
    expect(
      (gemini.messages[0] as { tool_calls?: Array<{ extra_content?: unknown }> })
        .tool_calls?.[0]?.extra_content,
    ).toEqual({
      vendor: { cache_key: 'keep-me' },
      google: { thought_signature: 'skip_thought_signature_validator' },
    });
  });

  it('normalizes custom tool history and flattens text-like tool output parts', () => {
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'custom_tool_call',
          call_id: 'custom_1',
          name: 'exec',
          input: 'console.log(1)',
        },
        {
          type: 'custom_tool_call_output',
          call_id: 'custom_1',
          output: [{ type: 'input_text', text: 'done' }, { type: 'input_text', text: 'ok' }],
        },
        {
          type: 'function_call_output',
          call_id: 'function_1',
          output: [{ type: 'input_text', text: '{"ok":true}' }],
        },
      ],
    }));
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'custom_1',
          type: 'function',
          function: { name: 'exec', arguments: '{"input":"console.log(1)"}' },
        }],
      },
      { role: 'tool', tool_call_id: 'custom_1', content: 'done\nok' },
      { role: 'tool', tool_call_id: 'function_1', content: '{"ok":true}' },
    ]);
  });

  it('omits tool_choice/parallel_tool_calls when all tools were dropped (empty-tools guard)', () => {
    const out = translateResponsesRequest(base({
      tools: [{ type: 'namespace', name: 'multi_agent_v1' }],
      tool_choice: 'auto',
      parallel_tool_calls: true,
    }));
    expect(out.tools).toBeUndefined();
    expect(out.tool_choice).toBeUndefined();
    expect(out.parallel_tool_calls).toBeUndefined();
  });

  it('downgrades forced tool_choice to auto for thinking models', () => {
    const forced = translateResponsesRequest(base({
      tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'Bash' },
    }), { capabilities: { forceAutoToolChoice: true } });
    expect(forced.tool_choice).toBe('auto');
    const required = translateResponsesRequest(base({
      tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
      tool_choice: 'required',
    }), { capabilities: { forceAutoToolChoice: true } });
    expect(required.tool_choice).toBe('auto');
    // 不开 forceAutoToolChoice 时保留具名强制。
    const kept = translateResponsesRequest(base({
      tools: [{ type: 'function', name: 'Bash', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'Bash' },
    }));
    expect(kept.tool_choice).toEqual({ type: 'function', function: { name: 'Bash' } });
  });

  it('normalizes unknown/latest_reminder roles to user and forces function parameters.type=object', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'latest_reminder', content: 'reminder text' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
      tools: [{ type: 'function', name: 'NoParams' }],
    }));
    expect(out.messages[0]).toEqual({ role: 'user', content: 'reminder text' });
    expect(out.tools?.[0].function.parameters).toEqual({ type: 'object', properties: {} });
  });

  it('ignores replayed reasoning but rejects unknown context-bearing items', () => {
    expect(translateResponsesRequest(base({
      input: [
        { type: 'reasoning', encrypted_content: 'opaque' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    })).messages).toEqual([{ role: 'user', content: 'hi' }]);

    expect(() => translateResponsesRequest(base({
      input: [{ type: 'computer_call', id: 'x' }],
    }))).toThrowError(UnsupportedResponsesFeatureError);
  });

  it('translates capability-gated Kimi user images and preserves replayed history order', () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U=';
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'before' },
            { type: 'input_image', image_url: imageUrl },
            { type: 'input_text', text: 'after' },
          ],
        },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'seen' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue' }] },
      ],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'before' },
          { type: 'image_url', image_url: { url: imageUrl } },
          { type: 'text', text: 'after' },
        ],
      },
      { role: 'assistant', content: 'seen' },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('keeps pure-text JSON shape unchanged when image capability is enabled', () => {
    const out = translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [
          { type: 'input_text', text: 'hello' },
          { type: 'input_text', text: ' world' },
        ],
      }],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  it('keeps invalid or non-user image inputs fail-closed even with image capability', () => {
    const capabilities = { imageInput: 'image_url' as const };
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
    }), { capabilities })).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image' }] }],
    }), { capabilities })).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==' }],
      }],
    }), { capabilities })).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', audio_url: 'x' }] }],
    }), { capabilities })).toThrow("input content part 'input_audio'");
  });

  it('allows normalized user-like roles such as latest_reminder to carry images', () => {
    const imageUrl = 'data:image/png;base64,eA==';
    const out = translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'latest_reminder',
        content: [{ type: 'input_image', image_url: imageUrl }],
      }],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: imageUrl } }],
    }]);
  });

  it('drops Codex built-in tools (namespace/web_search) but keeps standard function tools', () => {
    const dropped: Array<[string, number]> = [];
    const out = translateResponsesRequest(base({
      tools: [
        { type: 'function', name: 'Bash', parameters: { type: 'object' } },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'web_search' },
      ],
    }), { onDroppedTool: (type, index) => dropped.push([type, index]) });
    // 只保留标准 function 工具;Codex 内建工具剥掉(降级),不再让整条请求 fail。
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } },
    ]);
    expect(dropped).toEqual([['namespace', 1], ['web_search', 2]]);
  });

  it('omits the tools field entirely when every tool is a dropped built-in', () => {
    const out = translateResponsesRequest(base({ tools: [{ type: 'namespace', name: 'multi_agent_v1' }] }));
    expect(out.tools).toBeUndefined();
  });

  it('still fail-closes on unsupported input content (context must not be silently dropped)', () => {
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', image_url: 'x' }] }],
    }))).toThrow("input content part 'input_image'");
  });
});
