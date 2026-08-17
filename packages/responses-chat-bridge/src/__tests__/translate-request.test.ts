import { describe, expect, it } from 'vitest';

import {
  translateResponsesRequest,
  translateResponsesRequestWithContext,
} from '../translate-request.js';
import { ChatBridgeToolContext } from '../tool-context.js';
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

  it.each([
    { type: 'input_image', image_url: 'https://example.com/image.png' },
    { type: 'input_file', file_data: 'data:text/plain;base64,eA==' },
    { type: 'input_audio', input_audio: { data: 'YQ==', format: 'wav' } },
    { type: 'input_text' },
    { type: 'unknown_part' },
  ])('rejects unsupported or malformed instruction parts: $type', (part) => {
    expect(() => translateResponsesRequest(base({ instructions: [part] }))).toThrow(
      /instructions\[0\]/,
    );
  });

  it('keeps probing when a collision occupies the first custom fallback name', () => {
    const fallback = ChatBridgeToolContext.fromRequest({
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'foo' },
        { type: 'custom', name: 'foo' },
      ],
    }).chatNameForResponse('foo', undefined, 'custom');
    const context = ChatBridgeToolContext.fromRequest({
      model: 'm',
      input: [],
      tools: [
        { type: 'function', name: 'foo' },
        { type: 'function', name: fallback },
        { type: 'custom', name: 'foo' },
      ],
    });

    const customName = context.chatNameForResponse('foo', undefined, 'custom');
    expect(customName).not.toBe(fallback);
    expect(context.lookupChatName(customName)).toEqual(expect.objectContaining({ kind: 'custom' }));
    expect(context.chatTools).toHaveLength(3);
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

  it('degrades untranslatable tool-output media to a placeholder instead of failing the request (#2805)', () => {
    // 上下文压缩 / 历史重放会把此前被拦截的图片以 input_image 重新带进工具
    // 输出:纯文本路由(无 imageInput 能力)此前 fail-closed 拒绝整单,会话
    // 从此每轮都被拒 —— 应降级为占位文本,保会话可用。
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'call_img', name: 'ReadImage', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_img',
          output: [
            { type: 'input_text', text: 'here is the screenshot' },
            { type: 'input_image', image_url: 'data:image/png;base64,QUJD' },
          ],
        },
        { type: 'message', role: 'user', content: 'continue after compaction' },
      ],
    }));
    const tool = out.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content).toContain('here is the screenshot');
    expect(tool.content).toContain('[media omitted');
    expect(tool.content).not.toContain('base64');
    expect(out.messages.at(-1)).toEqual({ role: 'user', content: 'continue after compaction' });
  });

  it('still moves translatable tool-output media to a user message on image routes', () => {
    // 对照组:路由支持图片时维持既有「搬运到后续 user 消息」语义。
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'call_img', name: 'ReadImage', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_img',
          output: [{ type: 'input_image', image_url: 'https://img.example/a.png' }],
        },
        { type: 'message', role: 'user', content: 'go on' },
      ],
    }), { capabilities: { imageInput: 'image_url' } });
    const tool = out.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content).toContain('[media moved to the following user message]');
    const mediaMessage = out.messages.find(
      (m) => m.role === 'user' && Array.isArray((m as { content: unknown }).content),
    ) as { content: Array<{ type: string }> };
    expect(mediaMessage.content.some((part) => part.type === 'image_url')).toBe(true);
  });

  it('degrades untranslatable audio and file tool-output media the same way', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'call_m', name: 'Fetch', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'call_m',
          output: [
            { type: 'input_audio', input_audio: { data: 'QUJD', format: 'wav' } },
            { type: 'input_file', file_id: 'file_123' },
          ],
        },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    }));
    const tool = out.messages.find((m) => m.role === 'tool') as { content: string };
    expect(tool.content).toContain('[media omitted');
    expect(tool.content).not.toContain('QUJD');
    expect(tool.content).not.toContain('file_123');
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
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'function_1',
          type: 'function',
          function: { name: 'unknown_tool', arguments: '{}' },
        }],
      },
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

  it('converts replayed agent messages to assistant text', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'user', content: 'start' },
        {
          type: 'agent_message',
          author: 'researcher\r\nreviewer',
          content: [
            { type: 'output_text', text: '  Findings' },
            { type: 'encrypted_content', encrypted_content: 'opaque' },
          ],
        },
        {
          type: 'agent_message',
          author: 'reviewer',
          content: [{ type: 'encrypted_content', encrypted_content: 'opaque' }],
        },
        {
          type: 'agent_message',
          author: 'observer',
          content: [{ type: 'output_text', text: '   ' }],
        },
        { type: 'message', role: 'assistant', content: 'Final answer' },
        { type: 'message', role: 'user', content: 'finish' },
      ],
    }));

    expect(out.messages).toEqual([
      { role: 'user', content: 'start' },
      {
        role: 'assistant',
        content: [
          '[collab researcher reviewer]\n  Findings',
          '[collab message from reviewer; encrypted payload omitted]',
          '[collab message from observer; empty content]',
        ].join('\n'),
      },
      { role: 'assistant', content: 'Final answer' },
      { role: 'user', content: 'finish' },
    ]);
  });

  it.each(['input_text', 'output_text', 'text'])(
    'reports a malformed agent message %s part by path',
    (type) => {
      expect(() => translateResponsesRequest(base({
        input: [{ type: 'agent_message', content: [{ type }] }],
      }))).toThrow(`input[0].content.${type}`);
    },
  );

  it('reports an unknown agent message part by path', () => {
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'agent_message', content: [{ type: 'image_url' }] }],
    }))).toThrow('input[0].content.image_url');
  });

  it('keeps agent messages after the preceding tool result', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'call_1', name: 'shell', arguments: '{}' },
        {
          type: 'agent_message',
          author: 'researcher',
          content: [{ type: 'output_text', text: 'Findings' }],
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'done' },
      ],
    }));

    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
      { role: 'assistant', content: '[collab researcher]\nFindings' },
    ]);
  });

  it('round-trips replayed Codex tool_search items without breaking tool-call merging', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'tool_search_call', id: 'ts_1' },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
        { type: 'tool_search_output', id: 'ts_1', output: {} },
        { type: 'tool_search_call_output', call_id: 'ts_1', output: {} },
        { type: 'function_call_output', call_id: 'call_1', output: 'ok' },
      ],
    }));

    expect(out.messages).toEqual([
      { role: 'user', content: 'hi' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } },
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'ts_1', content: '{}' },
      { role: 'tool', tool_call_id: 'call_1', content: 'ok' },
    ]);
  });

  it('serializes tools from tool_search outputs when output is absent', () => {
    const tools = [{
      type: 'function',
      name: 'search_result',
      parameters: { type: 'object' },
    }];
    const out = translateResponsesRequest(base({
      input: [
        { type: 'tool_search_call', id: 'ts_1' },
        { type: 'tool_search_output', id: 'ts_1', tools },
      ],
    }));
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } },
        ],
      },
      {
        role: 'tool',
        tool_call_id: 'ts_1',
        content: JSON.stringify(tools),
      },
    ]);
  });

  it('does not let replayed tool_search items split assistant merging', () => {
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'assistant',
          content: 'planning',
        },
        { type: 'tool_search_call', id: 'ts_1' },
        { type: 'tool_search_output', id: 'ts_1', output: {} },
        {
          type: 'function_call',
          call_id: 'call_1',
          name: 'shell',
          arguments: '{"cmd":"ls"}',
        },
        { type: 'tool_search_call_output', call_id: 'ts_1', output: {} },
        {
          type: 'function_call',
          call_id: 'call_2',
          name: 'shell',
          arguments: '{"cmd":"pwd"}',
        },
        { type: 'function_call_output', call_id: 'call_1', output: 'a' },
        { type: 'function_call_output', call_id: 'call_2', output: 'b' },
      ],
    }));

    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: 'planning',
        tool_calls: [
          { id: 'ts_1', type: 'function', function: { name: 'tool_search', arguments: '{}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'ts_1', content: '{}' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'shell', arguments: '{"cmd":"ls"}' } },
          { id: 'call_2', type: 'function', function: { name: 'shell', arguments: '{"cmd":"pwd"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'a' },
      { role: 'tool', tool_call_id: 'call_2', content: 'b' },
    ]);
  });

  it('translates user images when the upstream capability is enabled and preserves replayed history order', () => {
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

  it('drops unsupported images from replayed user history so a later text turn can recover', () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U=';
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this' },
            { type: 'input_image', image_url: imageUrl },
          ],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue in text' }] },
      ],
    }));

    expect(out.messages).toEqual([
      { role: 'user', content: 'describe this' },
      { role: 'user', content: 'continue in text' },
    ]);
  });

  it('drops untranslatable file_id images from replayed history on image-url routes', () => {
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this' },
            { type: 'input_image', file_id: 'file_1' },
          ],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue in text' }] },
      ],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([
      { role: 'user', content: 'describe this' },
      { role: 'user', content: 'continue in text' },
    ]);
  });

  it('drops image-only replayed turns but keeps the newest unsupported image fail-closed', () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U=';
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: imageUrl }],
        },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'continue in text' }] },
      ],
    }));

    expect(out.messages).toEqual([{ role: 'user', content: 'continue in text' }]);
    expect(() => translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'history' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'describe this' },
            { type: 'input_image', image_url: imageUrl },
          ],
        },
      ],
    }))).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_image', image_url: imageUrl }],
        },
        { type: 'message', role: 'latest_reminder', content: 'current-turn reminder' },
      ],
    }))).toThrow("input content part 'input_image'");
  });

  it('drops empty user messages produced by auto-compact collapsing image-only turns', () => {
    // Codex auto-compact 的 replacement_history 把「无文字纯图片」用户消息折叠成单个
    // 空 input_text；桥接层若原样透传，Moonshot/Kimi 会以
    // "the message at position N with role 'user' must not be empty" 拒绝整次请求。
    const out = translateResponsesRequest(base({
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '第一条' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '   ' }] },
        { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: '继续' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '继续' }] },
      ],
    }));

    expect(out.messages).toEqual([
      { role: 'user', content: '第一条' },
      { role: 'assistant', content: '继续' },
      { role: 'user', content: '继续' },
    ]);
  });

  it('keeps image-only user messages (no text) as valid multimodal content', () => {
    const imageUrl = 'data:image/png;base64,aW1hZ2U=';
    const out = translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', image_url: imageUrl }],
      }],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([{
      role: 'user',
      content: [{ type: 'image_url', image_url: { url: imageUrl } }],
    }]);
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
    }));

    expect(out.messages).toEqual([{ role: 'user', content: 'hello world' }]);
  });

  it('keeps invalid or non-user image inputs fail-closed', () => {
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image', file_id: 'file_1' }] }],
    }))).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_image', file_id: 'file_1', image_url: 'https://example.com/image.png' }],
      }],
    }), { capabilities: { imageInput: 'image_url' } })).toThrow('input_image.file_id');
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_image' }] }],
    }))).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'assistant',
        content: [{ type: 'input_image', image_url: 'data:image/png;base64,eA==' }],
      }],
    }))).toThrow("input content part 'input_image'");
    expect(() => translateResponsesRequest(base({
      input: [{ type: 'message', role: 'user', content: [{ type: 'input_audio', audio_url: 'x' }] }],
    }))).toThrow("input content part 'input_audio'");
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

  it('flattens namespace tools, drops unsupported built-ins, and keeps standard functions', () => {
    const dropped: Array<[string, number]> = [];
    const out = translateResponsesRequest(base({
      tools: [
        { type: 'function', name: 'Bash', parameters: { type: 'object' } },
        { type: 'namespace', name: 'multi_agent_v1', tools: [{ type: 'function', name: 'close_agent' }] },
        { type: 'web_search' },
      ],
    }), { onDroppedTool: (type, index) => dropped.push([type, index]) });
    // namespace 子工具展平为 Chat function；真正没有 Chat 等价物的内建工具仍降级丢弃。
    expect(out.tools).toEqual([
      { type: 'function', function: { name: 'Bash', parameters: { type: 'object' } } },
      {
        type: 'function',
        function: {
          name: 'multi_agent_v1__close_agent',
          parameters: { type: 'object', properties: {} },
        },
      },
    ]);
    expect(dropped).toEqual([['web_search', 2]]);
  });

  it('omits the tools field entirely when every tool is a dropped built-in', () => {
    const out = translateResponsesRequest(base({ tools: [{ type: 'namespace', name: 'multi_agent_v1' }] }));
    expect(out.tools).toBeUndefined();
  });

  it('preserves image detail from Responses content parts', () => {
    const out = translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{
          type: 'input_image',
          image_url: { url: 'https://example.com/image.png', detail: 'high' },
        }],
      }],
    }), { capabilities: { imageInput: 'image_url' } });

    expect(out.messages).toEqual([{
      role: 'user',
      content: [{
        type: 'image_url',
        image_url: { url: 'https://example.com/image.png', detail: 'high' },
      }],
    }]);
  });

  it('maps custom, namespace, and tool-search declarations into reversible Chat tools', () => {
    const out = translateResponsesRequest(base({
      tools: [
        { type: 'custom', name: 'apply_patch', description: 'edit files' },
        {
          type: 'namespace',
          name: 'mcp',
          tools: [{ type: 'function', name: 'query', parameters: { type: 'object' } }],
        },
        { type: 'tool_search' },
      ],
      tool_choice: { type: 'custom', name: 'apply_patch' },
    }));
    expect(out.tools?.map((tool) => tool.function.name)).toEqual([
      'apply_patch',
      'mcp__query',
      'tool_search',
    ]);
    expect(out.tools?.[0].function.parameters).toEqual({
      type: 'object',
      properties: { input: { type: 'string', description: expect.any(String) } },
      required: ['input'],
    });
    expect(out.tool_choice).toEqual({
      type: 'function',
      function: { name: 'apply_patch' },
    });
  });

  it('keeps the built-in tool-search adapter distinct from a user tool_search name', () => {
    const out = translateResponsesRequest(base({
      tools: [
        { type: 'function', name: 'tool_search', parameters: { type: 'object' } },
        { type: 'tool_search' },
      ],
      input: [{ type: 'tool_search_call', id: 'ts_1' }],
    }));
    const toolNames = out.tools?.map((tool) => tool.function.name) ?? [];
    expect(toolNames).toHaveLength(2);
    expect(new Set(toolNames).size).toBe(2);
    expect(toolNames).toContain('tool_search');
    expect((out.messages[0] as {
      tool_calls?: Array<{ function: { name: string } }>;
    }).tool_calls?.[0]?.function.name).not.toBe('tool_search');
  });

  it('keeps function and custom tools with the same name distinct', () => {
    const { request, toolContext } = translateResponsesRequestWithContext(base({
      tools: [
        { type: 'function', name: 'shared', parameters: { type: 'object' } },
        { type: 'custom', name: 'shared' },
      ],
      tool_choice: { type: 'custom', name: 'shared' },
      input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'shared', input: 'raw' }],
    }));
    const toolNames = request.tools?.map((tool) => tool.function.name) ?? [];
    const customName = (request.tool_choice as {
      function: { name: string };
    }).function.name;
    expect(toolNames).toHaveLength(2);
    expect(new Set(toolNames).size).toBe(2);
    expect(toolNames).toContain('shared');
    expect(customName).not.toBe('shared');
    expect((request.messages[0] as {
      tool_calls?: Array<{ function: { name: string } }>;
    }).tool_calls?.[0]?.function.name).toBe(customName);
    expect(toolContext.lookupChatName(customName)?.kind).toBe('custom');
  });

  it('collects declarations only from top-level tool-search outputs', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: {
            nestedCall: { type: 'custom_tool_call', name: 'injected_custom' },
            nestedSearch: {
              type: 'tool_search_output',
              tools: [{ type: 'function', name: 'injected_function' }],
            },
          },
        },
        { type: 'tool_search_call', id: 'ts_1' },
        {
          type: 'tool_search_output',
          id: 'ts_1',
          tools: [{ type: 'function', name: 'loaded_function' }],
        },
      ],
    }));
    expect(out.tools?.map((tool) => tool.function.name)).toEqual([
      'tool_search',
      'loaded_function',
    ]);
  });

  it('preserves namespaces when cataloging custom tools from replayed history', () => {
    const { request, toolContext } = translateResponsesRequestWithContext(base({
      input: [{
        type: 'custom_tool_call',
        call_id: 'c1',
        namespace: 'mcp',
        name: 'exec',
        input: 'raw',
      }],
    }));
    expect(request.tools?.[0].function.name).toBe('mcp__exec');
    expect((request.messages[0] as {
      tool_calls?: Array<{ function: { name: string } }>;
    }).tool_calls?.[0]?.function.name).toBe('mcp__exec');
    expect(toolContext.lookupChatName('mcp__exec')).toMatchObject({
      kind: 'custom',
      name: 'exec',
      namespace: 'mcp',
    });
  });

  it('gates replayed reasoning history by provider capability', () => {
    const source = base({
      input: [
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 'plan ' }] },
        { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
        { type: 'reasoning', content: [{ type: 'reasoning_text', text: 'finish' }] },
        { type: 'message', role: 'assistant', content: 'done' },
      ],
    });
    expect(translateResponsesRequest(source).messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'Bash', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: 'done' },
    ]);

    const out = translateResponsesRequest(source, {
      capabilities: { reasoningHistoryField: 'reasoning_content' },
    });
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'plan ',
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'Bash', arguments: '{}' },
        }],
      },
      { role: 'tool', tool_call_id: 'c1', content: 'ok' },
      { role: 'assistant', content: 'done', reasoning_content: 'finish' },
    ]);
  });

  it('repairs a dangling tool round without moving the following user barrier ahead of results', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{}' },
        { type: 'message', role: 'user', content: 'continue' },
      ],
    }));
    expect(out.messages).toEqual([
      {
        role: 'assistant',
        content: null,
        tool_calls: [{
          id: 'c1',
          type: 'function',
          function: { name: 'Bash', arguments: '{}' },
        }],
      },
      {
        role: 'tool',
        tool_call_id: 'c1',
        content: expect.stringContaining('execution status is unknown'),
      },
      { role: 'user', content: 'continue' },
    ]);
  });

  it('keeps real tool outputs when a later assistant round reuses the same call id', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{"round":1}' },
        { type: 'function_call_output', call_id: 'c1', output: 'first result' },
        { type: 'function_call', call_id: 'c1', name: 'Bash', arguments: '{"round":2}' },
        { type: 'function_call_output', call_id: 'c1', output: 'second result' },
      ],
    }));

    expect(out.messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'c1', content: 'first result' },
      { role: 'tool', tool_call_id: 'c1', content: 'second result' },
    ]);
    expect(out.messages).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ content: expect.stringContaining('execution status is unknown') }),
    ]));
  });

  it('ignores a late duplicate from an older round while a deferred barrier opens a new round', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'old_1', name: 'Bash', arguments: '{"round":1}' },
        { type: 'function_call', call_id: 'old_2', name: 'Bash', arguments: '{"round":1,"part":2}' },
        { type: 'function_call_output', call_id: 'old_1', output: 'first result' },
        { type: 'message', role: 'user', content: 'continue' },
        { type: 'function_call', call_id: 'new_1', name: 'Bash', arguments: '{"round":2}' },
        { type: 'function_call_output', call_id: 'old_1', output: 'late duplicate' },
        { type: 'function_call_output', call_id: 'new_1', output: 'second result' },
      ],
    }));

    expect(out.messages.filter((message) => message.role === 'tool')).toEqual([
      { role: 'tool', tool_call_id: 'old_1', content: 'first result' },
      {
        role: 'tool',
        tool_call_id: 'old_2',
        content: expect.stringContaining('execution status is unknown'),
      },
      { role: 'tool', tool_call_id: 'new_1', content: 'second result' },
    ]);
    expect(out.messages).not.toEqual(expect.arrayContaining([
      { role: 'tool', tool_call_id: 'old_1', content: 'late duplicate' },
    ]));
  });

  it('ignores late results for synthesized missing calls without closing a newer tool round', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'old_1', name: 'Bash', arguments: '{"round":1}' },
        { type: 'message', role: 'user', content: 'continue' },
        { type: 'function_call', call_id: 'new_1', name: 'Bash', arguments: '{"round":2}' },
        { type: 'function_call_output', call_id: 'old_1', output: 'late result' },
        { type: 'function_call_output', call_id: 'new_1', output: 'new result' },
      ],
    }));

    expect(out.messages.filter((message) => message.role === 'tool')).toEqual([
      {
        role: 'tool',
        tool_call_id: 'old_1',
        content: expect.stringContaining('execution status is unknown'),
      },
      { role: 'tool', tool_call_id: 'new_1', content: 'new result' },
    ]);
    expect(out.messages).not.toEqual(expect.arrayContaining([
      { role: 'tool', tool_call_id: 'old_1', content: 'late result' },
      expect.objectContaining({
        role: 'tool',
        tool_call_id: 'new_1',
        content: expect.stringContaining('execution status is unknown'),
      }),
    ]));
  });

  it('normalizes synthesized orphan tool calls for reasoning and Gemini providers', () => {
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call_output', call_id: 'orphan_1', output: 'ok' },
      ],
    }), {
      capabilities: {
        toolCallReasoningPlaceholder: true,
        googleThoughtSignaturePlaceholder: true,
      },
    });
    expect(out.messages[0]).toMatchObject({
      role: 'assistant',
      content: null,
      reasoning_content: 'tool call',
      tool_calls: [{
        id: 'orphan_1',
        extra_content: {
          google: { thought_signature: 'skip_thought_signature_validator' },
        },
      }],
    });
  });

  it('converts file/audio input and moves tool-result media into a user multimodal message', () => {
    const out = translateResponsesRequest(base({
      input: [
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_file', file_data: 'BASE64_FILE', filename: 'notes.txt' },
            { type: 'input_audio', input_audio: { data: 'BASE64', format: 'wav' } },
          ],
        },
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_text', text: 'see' }, { type: 'input_image', image_url: 'data:image/png;base64,x' }],
        },
      ],
    }), {
      capabilities: {
        imageInput: 'image_url',
        fileInput: 'file',
        audioInput: 'input_audio',
      },
    });
    expect(out.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: 'see\n[media moved to the following user message]',
    });
    expect(out.messages).toContainEqual({
      role: 'user',
      content: [
        { type: 'text', text: 'Media returned by the preceding tool result:' },
        { type: 'image_url', image_url: { url: 'data:image/png;base64,x' } },
      ],
    });
    expect(out.messages[0]).toEqual({
      role: 'user',
      content: [
        { type: 'file', file: { file_data: 'BASE64_FILE', filename: 'notes.txt' } },
        { type: 'input_audio', input_audio: { data: 'BASE64', format: 'wav' } },
      ],
    });
  });

  it('rejects provider-scoped input_file ids instead of forwarding them cross-provider', () => {
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_id: 'file_1', filename: 'notes.txt' }],
      }],
    }), { capabilities: { fileInput: 'file' } })).toThrow('input_file.file_id');
  });

  it('fails closed for file and audio inputs unless each capability is enabled', () => {
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_file', file_data: 'BASE64', filename: 'notes.txt' }],
      }],
    }))).toThrow("input content part 'input_file'");
    expect(() => translateResponsesRequest(base({
      input: [{
        type: 'message',
        role: 'user',
        content: [{ type: 'input_audio', input_audio: { data: 'BASE64', format: 'wav' } }],
      }],
    }))).toThrow("input content part 'input_audio'");
  });

  it('rejects file-backed images in tool results instead of silently dropping the file id', () => {
    expect(() => translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_image', file_id: 'file_1', image_url: 'https://example.com/image.png' }],
        },
      ],
    }), { capabilities: { imageInput: 'image_url' } })).toThrow('input_image.file_id');
  });

  it('replaces unsupported media inside tool results with a placeholder instead of rejecting (#2805)', () => {
    // 行为变更(#2805):此前对工具结果里的不支持媒体 fail-closed 抛错,
    // 压缩 / 重放历史带回的媒体会让会话每轮被拒、彻底卡死 —— 改为占位
    // 降级,且不把原始媒体数据序列化进文本。
    for (const part of [
      { type: 'input_image', image_url: 'https://example.com/image.png' },
      { type: 'input_file', file_data: 'BASE64' },
      { type: 'input_audio', input_audio: { data: 'BASE64', format: 'wav' } },
    ]) {
      const out = translateResponsesRequest(base({
        input: [
          { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
          { type: 'function_call_output', call_id: 'c1', output: [part] },
          { type: 'message', role: 'user', content: 'continue' },
        ],
      }));
      const tool = out.messages.find((m) => m.role === 'tool') as { content: string };
      expect(tool.content).toContain('[media omitted');
      expect(tool.content).not.toContain('BASE64');
      expect(tool.content).not.toContain('example.com');
    }
  });

  it('does not reject non-media metadata with a media-like type', () => {
    const metadata = { type: 'image', description: 'output schema metadata' };
    const out = translateResponsesRequest(base({
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: { metadata } },
      ],
    }));
    expect(out.messages).toContainEqual({
      role: 'tool',
      tool_call_id: 'c1',
      content: JSON.stringify({ metadata }),
    });
  });

  it('forwards only capability-approved Chat tuning fields and maps reasoning dialects', () => {
    const out = translateResponsesRequest(base({
      temperature: 0.2,
      top_p: 0.8,
      response_format: { type: 'json_object' },
      reasoning: { effort: 'high' },
    }), {
      capabilities: {
        passthroughFields: ['temperature', 'top_p', 'response_format'],
        reasoningField: 'enable_thinking',
        reasoningEffortMap: { high: true },
      },
    });
    expect(out.temperature).toBe(0.2);
    expect(out.top_p).toBe(0.8);
    expect(out.response_format).toEqual({ type: 'json_object' });
    expect(out.enable_thinking).toBe(true);
    expect(out).not.toHaveProperty('frequency_penalty');
  });

  it('falls back to the original reasoning effort for string dialects when a boolean map is supplied', () => {
    const out = translateResponsesRequest(base({
      reasoning: { effort: 'high' },
    }), {
      capabilities: {
        reasoningField: 'reasoning_effort',
        reasoningEffortMap: { high: true },
      },
    });
    expect(out.reasoning_effort).toBe('high');
  });

  it('converts Responses json_schema text.format to Chat response_format shape', () => {
    const out = translateResponsesRequest(base({
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          description: 'structured answer',
          schema: { type: 'object', properties: { value: { type: 'string' } } },
          strict: true,
        },
      },
    }), { capabilities: { passthroughFields: ['response_format'] } });
    expect(out.response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        description: 'structured answer',
        schema: { type: 'object', properties: { value: { type: 'string' } } },
        strict: true,
      },
    });
  });
});
