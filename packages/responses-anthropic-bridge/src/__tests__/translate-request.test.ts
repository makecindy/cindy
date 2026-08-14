import { describe, expect, it } from 'vitest';

import {
  decodeThinkingBlock,
  encodeThinkingBlock,
  translateResponsesRequest,
} from '../translate-request.js';

describe('Responses → Anthropic request translation', () => {
  it('moves instructions/developer messages to system and preserves text/image order', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      instructions: 'system one',
      input: [
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: 'system two' }] },
        {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: 'look' },
            { type: 'input_image', image_url: 'data:image/png;base64,abc' },
            { type: 'input_text', text: 'at this' },
          ],
        },
      ],
      prompt_cache_key: 'session-1',
    });
    expect(result.request.system?.[0].text).toBe('system one\n\nsystem two');
    expect(result.request.messages[0]).toMatchObject({
      role: 'user',
      content: [
        { type: 'text', text: 'look' },
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } },
        { type: 'text', text: 'at this' },
      ],
    });
    expect(JSON.stringify(result.request)).not.toContain('prompt_cache_key');
    expect(JSON.stringify(result.request)).toContain('cache_control');
  });

  it('parses text and refusal content parts from top-level instructions', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      instructions: [
        { type: 'input_text', text: 'system one' },
        { type: 'refusal', refusal: '\n\nsystem two' },
      ],
      input: 'hello',
    });
    expect(result.request.system?.[0].text).toBe('system one\n\nsystem two');

    expect(() => translateResponsesRequest({
      model: 'claude',
      instructions: [{ type: 'input_image', image_url: 'https://example.com/a.png' }],
      input: 'hello',
    })).toThrowError('instructions[0].input_image');
  });

  it('replays collab agent messages as Anthropic assistant text', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { role: 'user', content: 'delegate this' },
        {
          type: 'agent_message',
          author: '/root/\r\n researcher',
          content: [
            { type: 'input_text', text: 'first finding' },
            { type: 'encrypted_content', data: 'provider-secret' },
            { type: 'output_text', text: 'second finding' },
          ],
        },
        {
          role: 'user',
          content: [{ type: 'input_image', image_url: 'data:image/png;base64,abc' }],
        },
      ],
    });

    expect(result.request.messages[1]).toEqual({
      role: 'assistant',
      content: [{
        type: 'text',
        text: '[collab /root/ researcher]\nfirst finding\nsecond finding',
      }],
    });
    expect(result.request.messages[2].content).toEqual([{
      type: 'image',
      source: { type: 'base64', media_type: 'image/png', data: 'abc' },
    }]);
    expect(JSON.stringify(result.request)).not.toContain('agent_message');
    expect(JSON.stringify(result.request)).not.toContain('encrypted_content');
    expect(JSON.stringify(result.request)).not.toContain('provider-secret');
  });

  it('keeps collab string, empty, and encrypted-only history distinguishable', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { role: 'user', content: 'delegate this' },
        { type: 'agent_message', content: 'plain result' },
        { type: 'agent_message', author: '', content: [] },
        {
          type: 'agent_message',
          author: 'worker',
          content: [{ type: 'encrypted_content', data: 'opaque' }],
        },
        { role: 'user', content: 'continue' },
      ],
    });

    expect(result.request.messages[1].content).toEqual([
      { type: 'text', text: '[collab agent]\nplain result' },
      { type: 'text', text: '[collab message from agent; empty content]' },
      { type: 'text', text: '[collab message from worker; encrypted payload omitted]' },
    ]);
  });

  it('rejects malformed collab content with its input path', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{ type: 'agent_message', content: [{ type: 'image_url' }] }],
    })).toThrowError('input[0].content.image_url');

    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{ type: 'agent_message', content: [{ type: 'text' }] }],
    })).toThrowError('input[0].content.text');

    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{ type: 'agent_message', content: null }],
    })).toThrowError('input[0].content');
  });

  it('keeps collab text inside a valid tool-use round', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { role: 'user', content: 'run it' },
        { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
        { type: 'agent_message', author: 'worker', content: 'working result' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
    });

    expect(result.request.messages[1].content).toEqual([
      expect.objectContaining({ type: 'tool_use', id: 'c1', name: 'run' }),
      { type: 'text', text: '[collab worker]\nworking result' },
    ]);
    expect(result.request.messages[2].content).toEqual([
      expect.objectContaining({ type: 'tool_result', tool_use_id: 'c1' }),
    ]);
  });

  it('rejects structured-output constraints instead of silently dropping them', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      input: 'hello',
      text: {
        format: {
          type: 'json_schema',
          name: 'answer',
          schema: { type: 'object', properties: { value: { type: 'string' } } },
        },
      },
    })).toThrowError('text.format');

    expect(() => translateResponsesRequest({
      model: 'claude',
      input: 'hello',
      response_format: { type: 'json_object' },
    })).toThrowError('response_format');

    expect(translateResponsesRequest({
      model: 'claude',
      input: 'hello',
      text: { format: { type: 'text' } },
    }).request.messages).toHaveLength(1);
  });

  it('flattens namespace tools and restores their mapping in the context', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'mcp_files__read', arguments: '{"path":"a"}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [{
        type: 'namespace',
        name: 'mcp_files',
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      }],
    });
    expect(result.request.tools).toEqual([{
      name: 'mcp_files__read',
      input_schema: { type: 'object', properties: {} },
    }]);
    const assistant = result.request.messages.find((message) => message.role === 'assistant')!;
    expect((assistant.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use',
      name: 'mcp_files__read',
      input: { path: 'a' },
    });
    expect(result.toolContext.byWireName.get('mcp_files__read')).toMatchObject({
      name: 'read',
      namespace: 'mcp_files',
      kind: 'namespace',
    });
  });

  it('round-trips signed and redacted thinking only through the provider envelope', () => {
    const thinking = { type: 'thinking', thinking: 'reason', signature: 'sig_1234567890' };
    const redacted = { type: 'redacted_thinking', data: 'opaque' };
    const thinkingEncoded = encodeThinkingBlock(thinking);
    const redactedEncoded = encodeThinkingBlock(redacted);
    expect(thinkingEncoded).toMatch(/^cindy-anthropic-thinking-v1:/);
    expect(decodeThinkingBlock(thinkingEncoded!)).toEqual(thinking);
    expect(decodeThinkingBlock(redactedEncoded!)).toEqual(redacted);
    expect(decodeThinkingBlock('other-provider:abc')).toBeNull();

    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      max_output_tokens: 8192,
      reasoning: { effort: 'high' },
      input: [
        { type: 'reasoning', encrypted_content: thinkingEncoded },
        { type: 'function_call', call_id: 'c1', name: 'read', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
    });
    const assistant = result.request.messages.find((message) => message.role === 'assistant')!;
    expect((assistant.content as Array<Record<string, unknown>>)[0]).toEqual(thinking);
    expect(result.request.thinking).toEqual({ type: 'adaptive' });
    expect(result.request.output_config).toEqual({ effort: 'high' });
  });

  it('preserves tool-result images as Anthropic media blocks', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [
            { type: 'output_text', text: 'caption' },
            { type: 'input_image', image_url: 'https://example.com/a.png' },
            { type: 'image', mimeType: 'image/webp', data: 'mcp-bytes' },
          ],
        },
      ],
    });
    const resultMessage = result.request.messages.find((message) => (
      message.content as Array<Record<string, unknown>>
    ).some((block) => block.type === 'tool_result'))!;
    const resultContent = ((resultMessage.content as Array<Record<string, unknown>>)[0].content
      ?? []) as Array<Record<string, unknown>>;
    expect(resultContent).toEqual([
      { type: 'text', text: 'caption' },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
      { type: 'image', source: { type: 'base64', media_type: 'image/webp', data: 'mcp-bytes' } },
    ]);
  });

  it('extracts nested MCP/Anthropic media serialized inside a tool result string', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: JSON.stringify({
            content: [
              { type: 'text', text: 'caption' },
              {
                type: 'image',
                source: { type: 'base64', media_type: 'image/png', data: 'nested-png' },
              },
            ],
          }),
        },
      ],
    });
    const resultMessage = result.request.messages.find((message) => (
      (message.content as Array<Record<string, unknown>>)
        .some((block) => block.type === 'tool_result')
    ))!;
    expect((resultMessage.content as Array<Record<string, unknown>>)[0].content).toEqual([
      { type: 'text', text: 'caption' },
      {
        type: 'image',
        source: { type: 'base64', media_type: 'image/png', data: 'nested-png' },
      },
    ]);
  });

  it('adds tools loaded by tool_search_output and maps a tool_search choice', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tool_choice: { type: 'tool_search' },
      input: [
        {
          type: 'tool_search_output',
          tools: [{
            type: 'function',
            name: 'loaded_read',
            description: 'Read a loaded resource',
            parameters: { type: 'object', properties: { path: { type: 'string' } } },
          }],
        },
        { type: 'tool_search_call', call_id: 'search_1', name: 'tool_search', arguments: '{}' },
        { type: 'tool_search_output', call_id: 'search_1', output: 'loaded' },
      ],
    });
    expect(result.request.tools).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'tool_search' }),
      expect.objectContaining({ name: 'loaded_read' }),
    ]));
    expect(result.request.tool_choice).toEqual({ type: 'tool', name: 'tool_search' });
  });

  it('preserves id-correlated tool_search outputs and serializes discovered tools', () => {
    const tools = [{
      type: 'function',
      name: 'loaded_read',
      parameters: { type: 'object' },
    }];
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'tool_search_call', id: 'search_1' },
        { type: 'tool_search_output', id: 'search_1', tools },
      ],
    });
    expect(result.request.tools?.map((tool) => (tool as { name: string }).name)).toEqual(
      expect.arrayContaining(['tool_search', 'loaded_read']),
    );
    const resultMessage = result.request.messages.find((message) => (
      (message.content as Array<Record<string, unknown>>)
        .some((block) => block.type === 'tool_result')
    ))!;
    expect(resultMessage.content).toEqual([{
      type: 'tool_result',
      tool_use_id: 'search_1',
      content: JSON.stringify(tools),
    }]);
  });

  it('collects dynamic tool declarations only from top-level tool-search outputs', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tools: [{ type: 'function', name: 'inspect', parameters: { type: 'object' } }],
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: {
            nestedSearch: {
              type: 'tool_search_output',
              tools: [{ type: 'function', name: 'injected_function' }],
            },
          },
        },
        { type: 'tool_search_call', id: 'search_1' },
        {
          type: 'tool_search_output',
          id: 'search_1',
          tools: [{ type: 'function', name: 'loaded_function' }],
        },
      ],
    });
    const names = result.request.tools?.map((tool) => (tool as { name: string }).name);
    expect(names).toEqual(expect.arrayContaining(['inspect', 'tool_search', 'loaded_function']));
    expect(names).not.toContain('injected_function');
  });

  it('keeps same-named function and custom tools distinct and reversible', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tools: [
        { type: 'function', name: 'shared', parameters: { type: 'object' } },
        { type: 'custom', name: 'shared' },
      ],
      tool_choice: { type: 'custom', name: 'shared' },
      input: [{ type: 'custom_tool_call', call_id: 'c1', name: 'shared', input: 'raw' }],
    });
    const toolNames = result.request.tools?.map((tool) => (tool as { name: string }).name) ?? [];
    const customWireName = (result.request.tool_choice as { name: string }).name;
    expect(toolNames).toHaveLength(2);
    expect(new Set(toolNames).size).toBe(2);
    expect(toolNames).toContain('shared');
    expect(customWireName).not.toBe('shared');
    const assistant = result.request.messages.find((message) => message.role === 'assistant')!;
    expect((assistant.content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use',
      name: customWireName,
    });
    expect(result.toolContext.byWireName.get(customWireName)?.kind).toBe('custom');
  });

  it('filters allowed_tools while preserving Anthropic auto/any semantics', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'function', name: 'keep' }],
      },
      input: [{ role: 'user', content: 'use the allowed tool' }],
      tools: [
        { type: 'function', name: 'keep', parameters: {} },
        { type: 'function', name: 'drop', parameters: {} },
      ],
    });
    expect(result.request.tools?.map((tool) => (tool as { name: string }).name)).toEqual(['keep']);
    expect(result.request.tool_choice).toEqual({ type: 'any' });
  });

  it('rejects a required tool choice when no bridge-compatible tools remain', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      tool_choice: 'required',
      input: [{ role: 'user', content: 'search the web' }],
      tools: [{ type: 'web_search' }],
    })).toThrowError('tool_choice requires a bridge-compatible tool');

    expect(() => translateResponsesRequest({
      model: 'claude',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'function', name: 'missing' }],
      },
      input: [{ role: 'user', content: 'use the missing tool' }],
      tools: [{ type: 'function', name: 'available', parameters: {} }],
    })).toThrowError('tool_choice requires a bridge-compatible tool');

    expect(() => translateResponsesRequest({
      model: 'claude',
      tool_choice: { type: 'web_search' },
      input: [{ role: 'user', content: 'search the web' }],
      tools: [{ type: 'web_search' }],
    })).toThrowError("tool_choice type 'web_search'");

    expect(() => translateResponsesRequest({
      model: 'claude',
      tool_choice: { type: 'web_search' },
      input: [{ role: 'user', content: 'search the web' }],
      tools: [{ type: 'function', name: 'local', parameters: {} }],
    })).toThrowError("tool_choice type 'web_search'");
  });

  it('keeps allowed_tools filtering specific to same-named tool kinds', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'required',
        tools: [{ type: 'custom', name: 'shared' }],
      },
      input: [{ role: 'user', content: 'use the custom tool' }],
      tools: [
        { type: 'function', name: 'shared', parameters: {} },
        { type: 'custom', name: 'shared' },
      ],
    });
    const tools = result.request.tools as Array<{ name: string }>;
    expect(tools).toHaveLength(1);
    expect(result.toolContext.byWireName.get(tools[0].name)?.kind).toBe('custom');
    expect(result.request.tool_choice).toEqual({ type: 'any' });
  });

  it('filters OAuth allowed_tools after applying the custom_ wire prefix', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      tool_choice: {
        type: 'allowed_tools',
        mode: 'auto',
        tools: [{ type: 'function', name: 'keep' }],
      },
      input: [{ role: 'user', content: 'use only the selected tool' }],
      tools: [
        { type: 'function', name: 'keep', parameters: {} },
        { type: 'function', name: 'drop', parameters: {} },
      ],
    }, { authMode: 'oauth' });
    expect(result.request.tools?.map((tool) => (tool as { name: string }).name)).toEqual([
      'custom_keep',
    ]);
    expect(result.request.tool_choice).toEqual({ type: 'auto' });
  });

  it('accepts object-form image_url and preserves a namespaced call supplied with namespace', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        {
          role: 'user',
          content: [{
            type: 'input_image',
            image_url: { url: 'https://example.com/a.png', detail: 'high' },
          }],
        },
        {
          type: 'function_call',
          call_id: 'c1',
          namespace: 'mcp_files',
          name: 'read',
          arguments: '{}',
        },
      ],
      tools: [{
        type: 'namespace',
        name: 'mcp_files',
        tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
      }],
    });
    expect(result.request.messages[0].content).toEqual([{
      type: 'image',
      source: { type: 'url', url: 'https://example.com/a.png' },
    }]);
    expect((result.request.messages[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use',
      name: 'mcp_files__read',
    });
  });

  it('rejects malformed input images instead of silently dropping them', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{
        role: 'user',
        content: [{ type: 'input_image', image_url: '' }],
      }],
    })).toThrow('input_image.image_url');
  });

  it('normalizes missing tool results and assistant-tail history', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
      ],
    });
    expect(result.request.messages).toHaveLength(3);
    expect(result.request.messages[1].role).toBe('assistant');
    expect(result.request.messages[2].role).toBe('user');
    expect((result.request.messages[2].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'c1',
      is_error: true,
    });
  });

  it('uses legacy thinking for older Claude and preserves the budget headroom invariant', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      max_output_tokens: 10000,
      reasoning: { effort: 'medium' },
      input: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      top_p: 0.8,
    });
    expect(result.request.thinking).toEqual({ type: 'enabled', budget_tokens: 5904 });
    expect(result.request.temperature).toBeUndefined();
    expect(result.request.top_p).toBeUndefined();
  });

  it('keeps sampling fields when reasoning is explicitly disabled', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      reasoning: { effort: 'none' },
      input: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      top_p: 0.8,
    });
    expect(result.request.thinking).toEqual({ type: 'disabled' });
    expect(result.request.temperature).toBe(0.2);
    expect(result.request.top_p).toBe(0.8);
  });

  it('rejects sampling values outside the Anthropic 0-1 range', () => {
    expect(() => translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      reasoning: { effort: 'none' },
      input: [{ role: 'user', content: 'hi' }],
      temperature: 1.5,
    })).toThrow('Responses temperature must be between 0 and 1');

    expect(() => translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      reasoning: { effort: 'none' },
      input: [{ role: 'user', content: 'hi' }],
      top_p: -0.1,
    })).toThrow('Responses top_p must be between 0 and 1');
  });

  it('maps Responses stop strings and arrays to Anthropic stop_sequences', () => {
    const single = translateResponsesRequest({
      model: 'claude',
      input: 'hi',
      stop: 'DONE',
    });
    expect(single.request.stop_sequences).toEqual(['DONE']);

    const multiple = translateResponsesRequest({
      model: 'claude',
      input: 'hi',
      stop: ['DONE', 'HALT'],
    });
    expect(multiple.request.stop_sequences).toEqual(['DONE', 'HALT']);
  });

  it('disables thinking when a forced tool choice must be preserved', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'run the tool' }],
      tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
      tool_choice: { type: 'function', name: 'run' },
    });
    expect(result.request.tool_choice).toEqual({ type: 'tool', name: 'run' });
    expect(result.request.thinking).toEqual({ type: 'disabled' });
    expect(result.request.output_config).toBeUndefined();
  });

  it('does not enable thinking for an unsigned tool-result continuation', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      reasoning: { effort: 'high' },
      input: [
        { type: 'function_call', call_id: 'c1', name: 'run', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'run', parameters: { type: 'object' } }],
    });
    expect(result.request.thinking).toEqual({ type: 'disabled' });
    expect(result.request.output_config).toBeUndefined();
  });

  it('applies the Claude Code identity and custom tool prefix only in OAuth mode', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'run-command', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: 'ok' },
      ],
      tools: [{ type: 'function', name: 'run-command', parameters: { type: 'object' } }],
    }, { authMode: 'oauth' });
    expect(result.request.system?.[0]).toEqual({
      type: 'text',
      text: "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
    });
    expect(result.request.tools?.[0]).toMatchObject({ name: 'custom_run-command' });
    expect((result.request.messages[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use',
      name: 'custom_run-command',
    });
  });

  it('models custom tools as free-form input and restores the raw input', () => {
    const request = translateResponsesRequest({
      model: 'claude',
      tools: [{ type: 'custom', name: 'apply_patch', description: 'Apply a patch' }],
      input: [
        { type: 'custom_tool_call', call_id: 'c1', name: 'apply_patch', input: '{"patch":true}' },
        { type: 'custom_tool_call_output', call_id: 'c1', output: 'ok' },
      ],
    });
    expect(request.request.tools?.[0]).toMatchObject({
      name: 'apply_patch',
      input_schema: {
        type: 'object',
        required: ['input'],
        properties: { input: { type: 'string' } },
      },
    });
    expect((request.request.messages[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({
      type: 'tool_use',
      input: { input: '{"patch":true}' },
    });
  });

  it('preserves root tool-schema composition constraints', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: 'open one location',
      tools: [{
        type: 'function',
        name: 'open',
        parameters: {
          oneOf: [
            {
              type: 'object',
              properties: { path: { type: 'string' } },
              required: ['path'],
            },
            {
              type: 'object',
              properties: { url: { type: 'string' } },
              required: ['url'],
            },
          ],
        },
      }],
    });
    expect(result.request.tools?.[0]).toMatchObject({
      input_schema: {
        type: 'object',
        properties: {},
        oneOf: [
          { required: ['path'] },
          { required: ['url'] },
        ],
      },
    });
  });

  it('preserves strict tool definitions only for capable upstreams and drops incomplete historical tool turns', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      tools: [{
        type: 'function',
        name: 'read',
        strict: true,
        parameters: { type: 'object' },
      }],
      input: [
        {
          type: 'function_call',
          status: 'incomplete',
          call_id: 'bad',
          name: 'read',
          arguments: '{"path":',
        },
        { type: 'function_call_output', call_id: 'bad', output: 'partial' },
        { role: 'user', content: 'continue safely' },
      ],
    }, { strictTools: true });
    expect(result.request.tools?.[0]).toMatchObject({ name: 'read', strict: true });
    expect(JSON.stringify(result.request.messages)).not.toContain('bad');
    expect(JSON.stringify(result.request.messages)).not.toContain('partial');

    const compatibleGateway = translateResponsesRequest({
      model: 'claude',
      tools: [{
        type: 'function',
        name: 'read',
        strict: true,
        parameters: { type: 'object' },
      }],
      input: [{ role: 'user', content: 'read safely' }],
    });
    expect(compatibleGateway.request.tools?.[0]).toMatchObject({ name: 'read' });
    expect(compatibleGateway.request.tools?.[0]).not.toHaveProperty('strict');
  });

  it('filters whitespace-only text blocks that Anthropic rejects', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      instructions: '   ',
      input: [
        { role: 'user', content: [{ type: 'input_text', text: '   ' }] },
        { role: 'user', content: [{ type: 'input_text', text: 'hello' }] },
      ],
    });
    expect(result.request.system).toBeUndefined();
    expect(result.request.messages).toEqual([{
      role: 'user',
      content: [{ type: 'text', text: 'hello' }],
    }]);
  });

  it('preserves refusal parts from assistant history as text', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [{
        role: 'assistant',
        content: [{ type: 'refusal', refusal: 'I cannot do that.' }],
      }],
    });
    expect(result.request.messages).toContainEqual({
      role: 'assistant',
      content: [{ type: 'text', text: 'I cannot do that.' }],
    });
  });

  it('converts top-level files and structured tool-result files to documents', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        {
          type: 'input_file',
          file_data: 'data:application/pdf;base64,JVBERiQ=',
          filename: 'report.pdf',
        },
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{ type: 'input_file', file_url: 'https://example.com/report.pdf', filename: 'report.pdf' }],
        },
      ],
    });
    expect(result.request.messages[0].content).toEqual([{
      type: 'document',
      source: { type: 'base64', media_type: 'application/pdf', data: 'JVBERiQ=' },
      title: 'report.pdf',
    }]);
    const toolResult = result.request.messages
      .flatMap((message) => message.content as Array<Record<string, unknown>>)
      .find((block) => block.type === 'tool_result')!;
    expect(toolResult.content).toEqual([{
      type: 'document',
      source: { type: 'url', url: 'https://example.com/report.pdf' },
      title: 'report.pdf',
    }]);
  });

  it('converts inline plain-text files to Anthropic text document sources', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [{
        type: 'input_file',
        file_data: 'data:text/plain;base64,SGVsbG8gQ2xhdWRlIQ==',
        filename: 'hello.txt',
      }],
    });
    expect(result.request.messages[0].content).toEqual([{
      type: 'document',
      source: {
        type: 'text',
        media_type: 'text/plain',
        data: 'Hello Claude!',
      },
      title: 'hello.txt',
    }]);
  });

  it('rejects unsupported inline document MIME types before reaching Anthropic', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{
        type: 'input_file',
        file_data: 'data:application/json;base64,eyJvayI6dHJ1ZX0=',
      }],
    })).toThrow("input_file media type 'application/json'");
  });

  it('normalizes long and invalid tool names deterministically', () => {
    const longName = 'tool.'.repeat(30);
    const first = translateResponsesRequest({
      model: 'claude',
      input: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: longName, parameters: {} }],
    });
    const second = translateResponsesRequest({
      model: 'claude',
      input: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', name: longName, parameters: {} }],
    });
    const firstName = first.request.tools?.[0] as Record<string, unknown>;
    const secondName = second.request.tools?.[0] as Record<string, unknown>;
    expect(String(firstName.name)).toHaveLength(64);
    expect(firstName.name).toBe(secondName.name);
  });

  it('keeps explicit max_output_tokens unchanged for adaptive thinking', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      max_output_tokens: 2048,
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(result.request.max_tokens).toBe(2048);
    expect(result.request.thinking).toEqual({ type: 'adaptive' });
  });

  it('rejects a requested reasoning budget that cannot fit in max_output_tokens', () => {
    expect(() => translateResponsesRequest({
      model: 'claude-sonnet-4-6',
      max_output_tokens: 1024,
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'hi' }],
    })).toThrow('reasoning effort cannot fit');
  });

  it('can disable thinking policy for generic Anthropic-compatible endpoints', () => {
    const result = translateResponsesRequest({
      model: 'custom-model',
      max_output_tokens: 1024,
      reasoning: { effort: 'high' },
      input: [{ role: 'user', content: 'hi' }],
    }, { supportsThinking: () => false });
    expect(result.request.thinking).toBeUndefined();
    expect(result.request.max_tokens).toBe(1024);
  });

  it('normalizes text and rejects unsupported tool-result document MIME types', () => {
    const text = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{
            type: 'document',
            source: { type: 'base64', media_type: 'text/plain', data: 'SGk=' },
          }],
        },
      ],
    });
    const textResult = text.request.messages
      .flatMap((message) => message.content as Array<Record<string, unknown>>)
      .find((block) => block.type === 'tool_result');
    expect(textResult).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'document', source: { type: 'text', data: 'Hi' } }],
    });
    const unsupported = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [{
            type: 'document',
            source: { type: 'base64', media_type: 'application/json', data: 'e30=' },
          }],
        },
      ],
    });
    const unsupportedResult = unsupported.request.messages
      .flatMap((message) => message.content as Array<Record<string, unknown>>)
      .find((block) => block.type === 'tool_result');
    expect(unsupportedResult).toMatchObject({
      type: 'tool_result',
      content: [{ type: 'text' }],
    });
  });

  it('bounds deeply nested structured tool output', () => {
    let nested: unknown = { type: 'text', text: 'leaf' };
    for (let index = 0; index < 20; index += 1) nested = { content: [nested] };
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        { type: 'function_call_output', call_id: 'c1', output: nested },
      ],
    });
    expect(result.request.messages).toHaveLength(3);
  });

  it('does not enable optional adaptive thinking without a requested effort', () => {
    const result = translateResponsesRequest({
      model: 'claude-opus-4-8',
      input: [{ role: 'user', content: 'hi' }],
    });
    expect(result.request.thinking).toBeUndefined();
  });

  it('cannot disable thinking on fable and mythos models', () => {
    for (const model of ['claude-fable-5', 'claude-mythos-5']) {
      const result = translateResponsesRequest({
        model,
        reasoning: { effort: 'none' },
        input: [{ role: 'user', content: 'hi' }],
      });
      expect(result.request.thinking).toEqual({ type: 'adaptive' });
      expect(result.request.output_config).toEqual({ effort: 'low' });
    }
  });

  it('keeps automatic prompt caching off the moving last user block', () => {
    const result = translateResponsesRequest({
      model: 'claude-sonnet-5',
      input: [
        { role: 'user', content: 'first' },
        { role: 'assistant', content: 'reply' },
        { role: 'user', content: 'second' },
      ],
    }, {
      promptCaching: true,
      automaticPromptCaching: true,
    });
    expect(result.request.cache_control).toEqual({ type: 'ephemeral' });
    const firstUser = result.request.messages[0].content as Array<Record<string, unknown>>;
    const lastUser = result.request.messages[2].content as Array<Record<string, unknown>>;
    expect(firstUser[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(lastUser[0].cache_control).toBeUndefined();
  });

  it('rejects non-http image URLs instead of passing them to Anthropic', () => {
    expect(() => translateResponsesRequest({
      model: 'claude',
      input: [{ role: 'user', content: [{ type: 'input_image', image_url: 'file:///tmp/a.png' }] }],
    })).toThrow('input_image.image_url scheme');
  });

  it('textifies invalid tool-result media URLs instead of forwarding them', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { type: 'function_call', call_id: 'c1', name: 'inspect', arguments: '{}' },
        {
          type: 'function_call_output',
          call_id: 'c1',
          output: [
            { type: 'image', source: { type: 'url', url: 'file:///tmp/a.png' } },
            { type: 'image', source: { type: 'url', url: 'https://user:pass@example.com/a.png' } },
            { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
          ],
        },
      ],
    });
    const resultMessage = result.request.messages.find((message) => (
      (message.content as Array<Record<string, unknown>>).some((block) => block.type === 'tool_result')
    ))!;
    const toolResult = (resultMessage.content as Array<Record<string, unknown>>)
      .find((block) => block.type === 'tool_result') as Record<string, unknown>;
    expect(toolResult.content).toEqual([
      {
        type: 'text',
        text: JSON.stringify({ type: 'image', source: { type: 'url', url: 'file:///tmp/a.png' } }),
      },
      {
        type: 'text',
        text: JSON.stringify({
          type: 'image',
          source: { type: 'url', url: 'https://user:pass@example.com/a.png' },
        }),
      },
      { type: 'image', source: { type: 'url', url: 'https://example.com/a.png' } },
    ]);
  });

  it('places tool results before user text and textifies orphan results', () => {
    const result = translateResponsesRequest({
      model: 'claude',
      input: [
        { role: 'user', content: 'before' },
        { type: 'function_call_output', call_id: 'orphan', output: 'lost' },
      ],
    });
    expect(result.request.messages[0].content).toEqual([
      { type: 'text', text: 'before' },
      { type: 'text', text: '[orphan tool_result orphan omitted from replay]' },
    ]);
  });
});
