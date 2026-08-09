import { describe, expect, it } from 'vitest';

import { translateChatToResponsesRequest } from '../translate-chat-request.js';
import { translateResponsesRequest } from '../translate-request.js';
import type { ChatCompletionsRequest } from '../types.js';

function base(overrides: Partial<ChatCompletionsRequest> = {}): ChatCompletionsRequest {
  return {
    model: 'gpt-4o',
    messages: [{ role: 'user', content: 'hello' }],
    stream: true,
    ...overrides,
  };
}

describe('translateChatToResponsesRequest', () => {
  it('folds leading system/developer into instructions and maps a user message', () => {
    const out = translateChatToResponsesRequest(base({
      messages: [
        { role: 'system', content: 'be concise' },
        { role: 'developer', content: 'no markdown' },
        { role: 'user', content: 'hello' },
      ],
    }));
    expect(out.model).toBe('gpt-4o');
    expect(out.instructions).toBe('be concise\nno markdown');
    expect(out.input).toEqual([{ role: 'user', content: 'hello' }]);
    expect(out.stream).toBe(true);
  });

  it('keeps mid-conversation system/developer as message items', () => {
    const out = translateChatToResponsesRequest(base({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'system', content: 'switch tone' },
        { role: 'user', content: 'again' },
      ],
    }));
    expect(out.instructions).toBeUndefined();
    expect(out.input).toEqual([
      { role: 'user', content: 'hi' },
      { type: 'message', role: 'system', content: 'switch tone' },
      { role: 'user', content: 'again' },
    ]);
  });

  it('maps user content parts (text/image) to input_* parts', () => {
    const out = translateChatToResponsesRequest(base({
      messages: [{
        role: 'user',
        content: [
          { type: 'text', text: 'look' },
          { type: 'image_url', image_url: { url: 'https://x/y.png', detail: 'high' } },
        ],
      }],
    }));
    expect(out.input).toEqual([{
      role: 'user',
      content: [
        { type: 'input_text', text: 'look' },
        { type: 'input_image', image_url: { url: 'https://x/y.png', detail: 'high' } },
      ],
    }]);
  });

  it('maps assistant tool_calls to function_call items and tool result to function_call_output', () => {
    const out = translateChatToResponsesRequest(base({
      messages: [
        { role: 'user', content: 'run it' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [{
            id: 'call_1',
            type: 'function',
            function: { name: 'Bash', arguments: '{"cmd":"ls"}' },
          }],
        },
        { role: 'tool', tool_call_id: 'call_1', content: 'file.txt' },
      ],
    }));
    expect(out.input).toEqual([
      { role: 'user', content: 'run it' },
      { type: 'function_call', call_id: 'call_1', name: 'Bash', arguments: '{"cmd":"ls"}' },
      { type: 'function_call_output', call_id: 'call_1', output: 'file.txt' },
    ]);
  });

  it('records reasoning_content history as a downgrade instead of emitting it', () => {
    const downgrades: string[] = [];
    const out = translateChatToResponsesRequest(base({
      messages: [{
        role: 'assistant',
        content: 'answer',
        reasoning_content: 'my private chain of thought',
      }],
    }), { onDowngrade: (f) => downgrades.push(f) });
    expect(out.input).toEqual([{ role: 'assistant', content: 'answer' }]);
    expect(downgrades).toContain('assistant.reasoning_content');
  });

  it('maps tools, tool_choice, token limit, effort and passthrough sampling', () => {
    const out = translateChatToResponsesRequest(base({
      tools: [{
        type: 'function',
        function: { name: 'Bash', description: 'run', parameters: { type: 'object' }, strict: true },
      }],
      tool_choice: { type: 'function', function: { name: 'Bash' } },
      parallel_tool_calls: true,
      max_completion_tokens: 256,
      reasoning_effort: 'high',
      temperature: 0.4,
      top_p: 0.9,
    }));
    expect(out.tools).toEqual([{
      type: 'function',
      name: 'Bash',
      description: 'run',
      parameters: { type: 'object' },
      strict: true,
    }]);
    expect(out.tool_choice).toEqual({ type: 'function', name: 'Bash' });
    expect(out.parallel_tool_calls).toBe(true);
    expect(out.max_output_tokens).toBe(256);
    expect(out.reasoning).toEqual({ effort: 'high' });
    expect(out.temperature).toBe(0.4);
    expect(out.top_p).toBe(0.9);
  });

  it('prefers max_completion_tokens over max_tokens and reasoning.effort over reasoning_effort', () => {
    const out = translateChatToResponsesRequest(base({
      max_tokens: 100,
      max_completion_tokens: 200,
      reasoning_effort: 'low',
      reasoning: { effort: 'medium' },
    }));
    expect(out.max_output_tokens).toBe(200);
    expect(out.reasoning).toEqual({ effort: 'medium' });
  });

  // Responses API 没有顶层 response_format;照抄 Chat 字段会让透明转发到 Responses 供应商的路由
  // 以「未知参数」拒掉本来合法的结构化输出请求(#1666 review P1)。
  it('maps Chat response_format json_object to Responses text.format', () => {
    const out = translateChatToResponsesRequest(base({
      response_format: { type: 'json_object' },
    }));
    expect(out.text).toEqual({ format: { type: 'json_object' } });
    expect(out).not.toHaveProperty('response_format');
  });

  it('flattens Chat json_schema nesting into Responses text.format', () => {
    const out = translateChatToResponsesRequest(base({
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'answer',
          description: 'structured answer',
          schema: { type: 'object', properties: { value: { type: 'string' } } },
          strict: true,
        },
      },
    }));
    expect(out.text).toEqual({
      format: {
        type: 'json_schema',
        name: 'answer',
        description: 'structured answer',
        schema: { type: 'object', properties: { value: { type: 'string' } } },
        strict: true,
      },
    });
    expect(out).not.toHaveProperty('response_format');
  });

  it('passes response_format shapes it does not recognise through to text.format unchanged', () => {
    const out = translateChatToResponsesRequest(base({
      response_format: { type: 'text' },
    }));
    expect(out.text).toEqual({ format: { type: 'text' } });
  });

  it('omits text entirely when the Chat request has no response_format', () => {
    const out = translateChatToResponsesRequest(base());
    expect(out).not.toHaveProperty('text');
  });

  // 走 openai-chat 供应商时 body 会再被反向译回 Chat(自环 /responses → createLocalBridgeDecision),
  // 所以这对映射必须互逆,否则结构化输出会在第二跳丢形状。
  it('round-trips json_schema back to the original Chat response_format shape', () => {
    const responseFormat = {
      type: 'json_schema',
      json_schema: {
        name: 'answer',
        description: 'structured answer',
        schema: { type: 'object', properties: { value: { type: 'string' } } },
        strict: true,
      },
    };
    const responses = translateChatToResponsesRequest(base({ response_format: responseFormat }));
    const chat = translateResponsesRequest(responses, {
      capabilities: { passthroughFields: ['response_format'] },
    });
    expect(chat.response_format).toEqual(responseFormat);
  });

  it('treats stream:false as non-streaming and records n>1 downgrade', () => {
    const downgrades: string[] = [];
    const out = translateChatToResponsesRequest(
      { ...base(), stream: false, n: 3 } as ChatCompletionsRequest,
      { onDowngrade: (f) => downgrades.push(f) },
    );
    expect(out.stream).toBe(false);
    expect(downgrades).toContain('n>1');
  });
});
