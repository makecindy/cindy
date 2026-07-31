import { describe, expect, it } from 'vitest';

import { translateRequest } from '../translate-request.js';
import type { AnthropicMessagesRequest } from '../types.js';

describe('translateRequest', () => {
  it('maps system → leading system message and user text → user message', () => {
    const req: AnthropicMessagesRequest = {
      model: 'deepseek/deepseek-chat',
      system: 'You are terse.',
      messages: [{ role: 'user', content: 'hi' }],
    };
    const out = translateRequest(req, { model: 'deepseek-chat' });
    expect(out.model).toBe('deepseek-chat');
    expect(out.stream).toBe(true);
    expect(out.stream_options).toEqual({ include_usage: true });
    expect(out.messages).toEqual([
      { role: 'system', content: 'You are terse.' },
      { role: 'user', content: 'hi' },
    ]);
  });

  it('joins array-form system blocks', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      system: [
        { type: 'text', text: 'A' },
        { type: 'text', text: 'B' },
      ],
      messages: [{ role: 'user', content: 'x' }],
    };
    expect(translateRequest(req, { model: 'm' }).messages[0]).toEqual({
      role: 'system',
      content: 'A\n\nB',
    });
  });

  it('maps assistant tool_use → tool_calls and user tool_result → tool message', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'weather?' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_weather', input: { city: 'beijing' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'sunny' },
            { type: 'text', text: 'thanks' },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.messages).toEqual([
      { role: 'user', content: 'weather?' },
      {
        role: 'assistant',
        content: 'let me check',
        tool_calls: [
          { id: 'tu_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"beijing"}' } },
        ],
      },
      { role: 'tool', tool_call_id: 'tu_1', content: 'sunny' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('pure tool_result user message emits only the tool message (no empty user)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content: 'ok' }] },
      ],
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.messages.map((m) => m.role)).toEqual(['user', 'assistant', 'tool']);
  });

  it('skips empty-string messages and empty assistant messages', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: '' },
        { role: 'assistant', content: '' },
        { role: 'user', content: 'real' },
      ],
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.messages).toEqual([{ role: 'user', content: 'real' }]);
  });

  it('maps image blocks to image_url parts (data URL) by default', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'what is this?' },
            { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'aGk=' } },
          ],
        },
      ],
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'what is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,aGk=' } },
        ],
      },
    ]);
  });

  it('replaces images with an explicit placeholder when imageInput is none', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'aGk=' } }] },
      ],
    };
    const out = translateRequest(req, { model: 'm', capabilities: { imageInput: 'none' } });
    const content = out.messages[0].content;
    expect(typeof content).toBe('string');
    expect(content).toContain('[image omitted');
  });

  it('maps tools and tool_choice', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [
        { name: 'get_weather', description: 'd', input_schema: { type: 'object', properties: { city: { type: 'string' } } } },
      ],
      tool_choice: { type: 'any' },
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.tools).toEqual([
      {
        type: 'function',
        function: {
          name: 'get_weather',
          description: 'd',
          parameters: { type: 'object', properties: { city: { type: 'string' } } },
        },
      },
    ]);
    expect(out.tool_choice).toBe('required');
    expect(out.parallel_tool_calls).toBe(true);
  });

  it('maps tool_choice tool → named function', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      tools: [{ name: 'a' }],
      tool_choice: { type: 'tool', name: 'a' },
    };
    expect(translateRequest(req, { model: 'm' }).tool_choice).toEqual({
      type: 'function',
      function: { name: 'a' },
    });
  });

  it('maps max_tokens to max_tokens by default and max_completion_tokens via capability', () => {
    const base: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      max_tokens: 4096,
    };
    expect(translateRequest(base, { model: 'm' }).max_tokens).toBe(4096);
    expect(translateRequest(base, { model: 'm', capabilities: { maxTokensField: 'max_completion_tokens' } }).max_completion_tokens).toBe(4096);
    const omitted = translateRequest(base, { model: 'm', capabilities: { maxTokensField: 'omit' } });
    expect(omitted.max_tokens).toBeUndefined();
    expect(omitted.max_completion_tokens).toBeUndefined();
  });

  it('maps thinking → upstream reasoning params per capability (default none)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'user', content: 'x' }],
      thinking: { type: 'enabled', budget_tokens: 8000 },
    };
    const defaultOut = translateRequest(req, { model: 'm' });
    expect(defaultOut.reasoning_effort).toBeUndefined();
    expect(defaultOut.reasoning).toBeUndefined();
    expect(defaultOut.thinking).toBeUndefined();
    const effort = translateRequest(req, { model: 'm', capabilities: { reasoningField: 'reasoning_effort' } });
    expect(effort.reasoning_effort).toBe('medium');
    const nested = translateRequest(req, { model: 'm', capabilities: { reasoningField: 'reasoning.effort' } });
    expect(nested.reasoning).toEqual({ effort: 'medium' });
    const thinking = translateRequest(req, { model: 'm', capabilities: { reasoningField: 'thinking.type' } });
    expect(thinking.thinking).toEqual({ type: 'enabled' });
  });

  it('maps assistant thinking → reasoning_content only when reasoningHistoryField enables it', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'answer' }] },
      ],
    };
    const dropped = translateRequest(req, { model: 'm' });
    expect((dropped.messages[1] as unknown as Record<string, unknown>).reasoning_content).toBeUndefined();
    const kept = translateRequest(req, { model: 'm', capabilities: { reasoningHistoryField: 'reasoning_content' } });
    expect((kept.messages[1] as unknown as Record<string, unknown>).reasoning_content).toBe('hmm');
  });

  it('injects reasoning placeholder for tool_call assistant messages when enabled', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [
        { role: 'user', content: 'x' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'a', input: {} }] },
      ],
    };
    const out = translateRequest(req, { model: 'm', capabilities: { toolCallReasoningPlaceholder: true } });
    const assistant = out.messages[1] as unknown as Record<string, unknown>;
    expect(assistant.reasoning_content).toBe(' ');
    expect(assistant.content).toBeNull();
  });

  it('prepends a user message when the sequence would start with assistant (defensive)', () => {
    const req: AnthropicMessagesRequest = {
      model: 'm',
      messages: [{ role: 'assistant', content: 'stray' }],
    };
    const out = translateRequest(req, { model: 'm' });
    expect(out.messages[0]).toEqual({ role: 'user', content: '' });
    expect(out.messages[1]).toEqual({ role: 'assistant', content: 'stray' });
  });
});
