import { describe, expect, it } from 'vitest';

import { createThreadStripController } from './thread-strip-controller.js';
import {
  compactOversizedImageHistory,
  createActiveStripTransform,
  createDuplicateToolUseIdRecoveryRule,
  createEmptyAssistantMessageRecoveryRule,
  createEmptyTextRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createToolExchangeAdjacencyRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  dedupeDuplicateToolUseIds,
  dedupeDuplicateToolUseIdsFromBody,
  repairToolExchangeAdjacency,
  repairToolExchangeAdjacencyFromBody,
  repairToolExchangeStructureFromBody,
  stripEmptyAssistantMessagesFromBody,
  stripEmptyTextFromBody,
  stripEmptyThinkingFromBody,
  stripEncryptedContentFromBody,
  stripImageGenerationItemsWithoutIdFromBody,
  stripNonAnthropicFields,
  stripToolUseProviderSpecificFields,
  stripToolUseProviderSpecificFieldsFromBody,
} from './transform.js';
import type { RequestTransformCtx } from './types.js';

function buf(obj: unknown): Buffer {
  return Buffer.from(JSON.stringify(obj), 'utf8');
}

const ctx: RequestTransformCtx = {
  reqId: 1,
  method: 'POST',
  url: '/v1/responses',
  headers: { 'thread-id': 'thread-a' },
};

describe('compactOversizedImageHistory', () => {
  it('drops older history images before the newest tool-result and newest user image', () => {
    const body = {
      model: 'claude-test',
      messages: [
        {
          role: 'assistant',
          content: [{ type: 'tool_result', content: [{ type: 'image', source: { type: 'base64', data: 'a'.repeat(4000) } }] }],
        },
        {
          role: 'assistant',
          content: [{ type: 'image', source: { type: 'base64', data: 'b'.repeat(3000) } }],
        },
        {
          role: 'user',
          content: [{ type: 'text', text: 'inspect this' }, { type: 'image', source: { type: 'base64', data: 'c'.repeat(3000) } }],
        },
      ],
    } as Record<string, unknown>;
    const originalBytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    const compacted = compactOversizedImageHistory(body, originalBytes - 2500);
    expect(compacted).toBe(body);
    const messages = body.messages as Array<Record<string, unknown>>;
    const oldToolContent = (messages[0].content as Array<Record<string, unknown>>)[0];
    expect((oldToolContent.content as Array<Record<string, unknown>>)[0].type).toBe('image');
    expect((messages[1].content as Array<Record<string, unknown>>)[0].type).toBe('text');
    expect((messages[2].content as Array<Record<string, unknown>>)[1].type).toBe('image');
  });

  it('preserves the current prompt image when a trailing tool_result also has role user', () => {
    const body = {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'continue inspecting the image' },
            { type: 'image', source: { type: 'base64', data: 'prompt-image'.repeat(500) } },
          ],
        },
        {
          role: 'assistant',
          content: [{ type: 'tool_use', id: 'tool-1', name: 'inspect', input: {} }],
        },
        {
          role: 'user',
          content: [{
            type: 'tool_result',
            tool_use_id: 'tool-1',
            content: [{ type: 'image', source: { type: 'base64', data: 'tool-image'.repeat(500) } }],
          }],
        },
      ],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    compactOversizedImageHistory(body, bytes - 2_500);
    const messages = body.messages as Array<Record<string, unknown>>;
    const promptContent = messages[0].content as Array<Record<string, unknown>>;
    const toolResult = (messages[2].content as Array<Record<string, unknown>>)[0];
    expect(promptContent[1].type).toBe('image');
    expect((toolResult.content as Array<Record<string, unknown>>)[0].type).toBe('text');
  });

  it('preserves the newest image across multiple tool_result blocks in one message', () => {
    const body = {
      model: 'claude-test',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tool-1', content: [{ type: 'image', source: { type: 'base64', data: 'older'.repeat(1000) } }] },
            { type: 'tool_result', tool_use_id: 'tool-2', content: [{ type: 'image', source: { type: 'base64', data: 'newest'.repeat(1000) } }] },
          ],
        },
      ],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    compactOversizedImageHistory(body, bytes - 2_500);
    const content = (body.messages as Array<Record<string, unknown>>)[0].content as Array<Record<string, unknown>>;
    expect((content[0].content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'text' });
    expect((content[1].content as Array<Record<string, unknown>>)[0]).toMatchObject({ type: 'image' });
  });

  it('fails closed when the only image is in the current user message', () => {
    const body = {
      model: 'claude-test',
      messages: [{ role: 'user', content: [{ type: 'image', source: { type: 'base64', data: 'x'.repeat(5000) } }] }],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    expect(compactOversizedImageHistory(body, bytes - 1)).toBeNull();
  });

  it('handles Responses input_image history and keeps the newest user item', () => {
    const body = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(4000)}` }] },
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'b'.repeat(4000)}` }] },
      ],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    compactOversizedImageHistory(body, bytes - 2500);
    const input = body.input as Array<Record<string, unknown>>;
    expect((input[0].content as Array<Record<string, unknown>>)[0].type).toBe('input_text');
    expect((input[1].content as Array<Record<string, unknown>>)[0].type).toBe('input_image');
  });

  it('recognizes a type-less Responses user item as the current prompt', () => {
    const body = {
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'a'.repeat(4000)}` }] },
        { role: 'user', content: [{ type: 'input_image', image_url: `data:image/png;base64,${'b'.repeat(4000)}` }] },
      ],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    compactOversizedImageHistory(body, bytes - 2500);
    const input = body.input as Array<Record<string, unknown>>;
    expect((input[0].content as Array<Record<string, unknown>>)[0].type).toBe('input_text');
    expect((input[1].content as Array<Record<string, unknown>>)[0].type).toBe('input_image');
  });

  it('compacts older OpenAI Chat image_url blocks while keeping the newest user images', () => {
    const body = {
      model: 'grok-4',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'old image' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'a'.repeat(4000)}` } },
          ],
        },
        { role: 'assistant', content: 'not the current prompt' },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'inspect the latest image' },
            { type: 'image_url', image_url: { url: `data:image/png;base64,${'b'.repeat(4000)}` } },
          ],
        },
      ],
    } as Record<string, unknown>;
    const bytes = Buffer.byteLength(JSON.stringify(body), 'utf8');
    compactOversizedImageHistory(body, bytes - 2500);
    const messages = body.messages as Array<Record<string, unknown>>;
    const oldContent = messages[0].content as Array<Record<string, unknown>>;
    const currentContent = messages[2].content as Array<Record<string, unknown>>;
    expect(oldContent[1].type).toBe('text');
    expect(currentContent[1].type).toBe('image_url');
  });
});

describe('stripEncryptedContentFromBody', () => {
  it('drops ciphertext from intermediate agent messages while preserving readable progress and completion', () => {
    const body = buf({
      model: 'gpt-5.6-sol',
      input: [
        {
          type: 'agent_message',
          author: '/root/progress_test',
          recipient: '/root',
          content: [
            { type: 'input_text', text: 'progress' },
            { type: 'encrypted_content', encrypted_content: 'gAAAAA-progress' },
          ],
          internal_chat_message_metadata_passthrough: { source: 'send_message' },
        },
        {
          type: 'agent_message',
          author: '/root/progress_test',
          recipient: '/root',
          content: [{ type: 'input_text', text: 'complete' }],
        },
        {
          type: 'agent_message',
          author: '/root/opaque',
          content: [{ type: 'encrypted_content', encrypted_content: 'gAAAAA-only' }],
        },
      ],
    });

    const out = stripEncryptedContentFromBody(body);

    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).input).toEqual([
      {
        type: 'agent_message',
        author: '/root/progress_test',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'progress' }],
        internal_chat_message_metadata_passthrough: { source: 'send_message' },
      },
      {
        type: 'agent_message',
        author: '/root/progress_test',
        recipient: '/root',
        content: [{ type: 'input_text', text: 'complete' }],
      },
    ]);
  });

  it('removes encrypted_content nested in Responses-style input items', () => {
    const body = buf({
      model: 'gpt-5.5',
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'reasoning', encrypted_content: 'gAAAAABxyz...', summary: [] },
        { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'call_1' },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(JSON.stringify(parsed)).not.toContain('encrypted_content');
    expect(JSON.stringify(parsed)).not.toContain('gAAAAAB');
    // 剥密文后 reasoning 已无 encrypted_content → 整项丢掉,避免 xAI ModelInput 422。
    expect(parsed.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'function_call', name: 'exec', arguments: '{}', call_id: 'call_1' },
    ]);
  });

  it('removes every occurrence across deep nesting', () => {
    const body = buf({
      input: [
        { encrypted_content: 'a', nested: { encrypted_content: 'b' } },
        { items: [{ encrypted_content: 'c' }] },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    expect(out!.toString('utf8')).not.toContain('encrypted_content');
  });

  it('returns null when there is no encrypted_content', () => {
    expect(stripEncryptedContentFromBody(buf({ model: 'gpt-5.5', input: [{ role: 'user' }] }))).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(stripEncryptedContentFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
  });

  // 回归 (2026-07 Grok 会话卡死): 压缩块的 encrypted_content 是压缩 blob 本体,
  // 剥掉只会留下上游无法解码的空壳 → xAI 400 "Could not decode the compaction blob"。
  it('keeps the compaction blob intact while stripping reasoning blobs', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'compaction', id: 'cmp_abc', encrypted_content: 'BLOB' },
        { type: 'reasoning', encrypted_content: 'gAAAAABxyz...', summary: [] },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.input).toEqual([
      { type: 'compaction', id: 'cmp_abc', encrypted_content: 'BLOB' },
      { type: 'message', role: 'user', content: 'hi' },
    ]);
  });

  it('keeps context_compaction blobs intact too', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'context_compaction', id: 'cc_1', encrypted_content: 'BLOB' },
        { type: 'reasoning', encrypted_content: 'ENC' },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.input).toEqual([{ type: 'context_compaction', id: 'cc_1', encrypted_content: 'BLOB' }]);
  });

  it('returns null when the only encrypted_content belongs to a compaction item', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'compaction', id: 'cmp_abc', encrypted_content: 'BLOB' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    expect(stripEncryptedContentFromBody(body)).toBeNull();
  });

  it('keeps summary-only reasoning items when nothing was stripped this round', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'compaction', id: 'cmp_abc' },
        { type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }] },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    // 压缩空壳必丢;没剥过密文时,只带 summary 的 reasoning 是合法形态,保留。
    expect(parsed.input).toEqual([{ type: 'reasoning', summary: [{ type: 'summary_text', text: 's' }] }]);
  });

  it('drops a compaction shell that already arrived without its blob', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'compaction', id: 'cmp_abc' },
        { type: 'message', role: 'user', content: 'hi' },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.input).toEqual([{ type: 'message', role: 'user', content: 'hi' }]);
  });

  // codex wire: Compaction.encrypted_content 必填、ContextCompaction 可选 —— 不带密文的
  // context_compaction 是合法的可读压缩变体,不是空壳,删掉等于静默丢上下文。
  it('preserves a blob-less context_compaction (legitimate readable variant)', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'context_compaction', id: 'cc_1', summary: 'earlier turns' },
        { type: 'reasoning', encrypted_content: 'ENC' },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.input).toEqual([{ type: 'context_compaction', id: 'cc_1', summary: 'earlier turns' }]);
  });

  // 空壳判定锚在协议层顶层 input[];嵌套结构里同名的 input 数组是别人的业务数据,
  // 不能按 type 形状猜着删(删密文键仍然全树递归,那是定向删键)。
  it('does not touch nested input arrays that are not protocol history', () => {
    const body = buf({
      model: 'grok-4.5',
      input: [
        { type: 'reasoning', encrypted_content: 'ENC' },
        {
          type: 'message',
          role: 'user',
          content: 'hi',
          payload: { input: [{ type: 'compaction' }, { type: 'reasoning' }] },
        },
      ],
    });
    const out = stripEncryptedContentFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.input).toEqual([
      {
        type: 'message',
        role: 'user',
        content: 'hi',
        payload: { input: [{ type: 'compaction' }, { type: 'reasoning' }] },
      },
    ]);
  });
});

describe('stripToolUseProviderSpecificFieldsFromBody', () => {
  it('removes provider_specific_fields from tool_use blocks in message history', () => {
    const body = buf({
      model: 'claude-fable-5',
      messages: [
        {
          role: 'assistant',
          content: [
            {
              type: 'tool_use',
              id: 'toolu_1',
              name: 'Bash',
              input: {
                provider_specific_fields: 'keep-as-tool-input',
                serializedBlock: {
                  type: 'tool_use',
                  provider_specific_fields: 'keep-nested-business-value',
                },
              },
              provider_specific_fields: null,
            },
          ],
        },
      ],
    });

    const out = stripToolUseProviderSpecificFieldsFromBody(body);

    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[0].content[0]).toEqual({
      type: 'tool_use',
      id: 'toolu_1',
      name: 'Bash',
      input: {
        provider_specific_fields: 'keep-as-tool-input',
        serializedBlock: {
          type: 'tool_use',
          provider_specific_fields: 'keep-nested-business-value',
        },
      },
    });
  });

  it('returns null when no tool_use provider field is present', () => {
    expect(stripToolUseProviderSpecificFieldsFromBody(buf({ messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] }))).toBeNull();
  });

  it('mutates parsed request bodies for the active transform path', () => {
    const body = {
      messages: [{ role: 'assistant', content: [{ type: 'tool_use', provider_specific_fields: null }] }],
    };
    expect(stripToolUseProviderSpecificFields(body, ctx)).toBe(body);
    expect(body.messages[0].content[0]).toEqual({ type: 'tool_use' });
  });

  it('handles malformed JSON without throwing', () => {
    expect(stripToolUseProviderSpecificFieldsFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
  });
});

describe('stripImageGenerationItemsWithoutIdFromBody', () => {
  it('removes image generation history items without id and keeps valid siblings', () => {
    const body = buf({
      model: 'gpt-5.5',
      tools: [{ type: 'image_generation' }],
      input: [
        { type: 'message', role: 'user', content: 'hi' },
        { type: 'image_generation_end', call_id: 'ig_1', result: 'data:image/png;base64,xxx' },
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
      ],
    });

    const out = stripImageGenerationItemsWithoutIdFromBody(body);

    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.tools).toEqual([{ type: 'image_generation' }]);
    expect(parsed.input).toEqual([
      { type: 'message', role: 'user', content: 'hi' },
      { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
    ]);
  });

  it('does not remove user input images, tool declarations, or valid image generation items', () => {
    const body = buf({
      tools: [{ type: 'image_generation' }],
      input: [
        { type: 'input_image', image_url: 'data:image/png;base64,xxx' },
        { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,yyy' },
      ],
    });

    expect(stripImageGenerationItemsWithoutIdFromBody(body)).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(stripImageGenerationItemsWithoutIdFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
  });
});

describe('stripEmptyThinkingFromBody', () => {
  it('removes an empty-content thinking block, keeping the sibling text', () => {
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: '' },
            { type: 'text', text: 'ok' },
          ],
        },
      ],
    });
    const out = stripEmptyThinkingFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[1].content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('keeps a content-bearing thinking block (deepseek: empty signature but has text)', () => {
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'real reasoning', signature: '' }] },
      ],
    });
    expect(stripEmptyThinkingFromBody(body)).toBeNull();
  });

  it('treats missing / non-string thinking as empty', () => {
    const body = buf({
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', signature: 'x' }, { type: 'text', text: 'hi' }] },
      ],
    });
    const out = stripEmptyThinkingFromBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).messages[0].content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('drops the whole message when content becomes empty after removal', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] },
        { role: 'user', content: 'q2' },
      ],
    });
    const out = stripEmptyThinkingFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
  });

  it('keeps a tool_use block and only drops the empty thinking (edge b: leave the turn)', () => {
    const body = buf({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: '' },
            { type: 'tool_use', id: 't1', name: 'x', input: {} },
          ],
        },
      ],
    });
    const out = stripEmptyThinkingFromBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).messages[0].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'x', input: {} },
    ]);
  });

  it('returns null for a clean body with valid thinking (cache-safe no-op)', () => {
    const body = buf({
      model: 'claude-sonnet-4-6',
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'deep', signature: 'sig' }, { type: 'text', text: 'a' }] },
      ],
    });
    expect(stripEmptyThinkingFromBody(body)).toBeNull();
  });

  it('returns null when messages is absent (e.g. a Responses input[] body — Codex no-op)', () => {
    expect(stripEmptyThinkingFromBody(buf({ model: 'gpt-5.5', input: [{ type: 'reasoning' }] }))).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(stripEmptyThinkingFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
  });
});

describe('stripEmptyTextFromBody', () => {
  it('removes an empty text block, keeping siblings', () => {
    const body = buf({
      model: 'claude-fable-5',
      messages: [
        { role: 'user', content: 'hi' },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
          ],
        },
      ],
    });
    const out = stripEmptyTextFromBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).messages[1].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
    ]);
  });

  it('drops the whole message when content becomes empty after removal (bridge-polluted turn)', () => {
    // bridge 修复前的典型脏历史:纯工具轮落成 [{type:'text',text:''}] 单块 assistant 消息。
    const body = buf({
      messages: [
        { role: 'user', content: 'q' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'q2' },
      ],
    });
    const out = stripEmptyTextFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
  });

  it('treats whitespace-only / missing / non-string text as empty', () => {
    const body = buf({
      messages: [
        { role: 'assistant', content: [{ type: 'text', text: '  \n ' }, { type: 'text' }, { type: 'text', text: 'ok' }] },
      ],
    });
    const out = stripEmptyTextFromBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).messages[0].content).toEqual([{ type: 'text', text: 'ok' }]);
  });

  it('does not descend into tool_result nested content', () => {
    const body = buf({
      messages: [
        {
          role: 'user',
          content: [{ type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: '' }] }],
        },
      ],
    });
    expect(stripEmptyTextFromBody(body)).toBeNull();
  });

  it('returns null for a clean body (cache-safe no-op)', () => {
    const body = buf({
      model: 'claude-fable-5',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'hello' }] }],
    });
    expect(stripEmptyTextFromBody(body)).toBeNull();
  });

  it('returns null when messages is absent (e.g. a Responses input[] body — Codex no-op)', () => {
    expect(stripEmptyTextFromBody(buf({ model: 'gpt-5.5', input: [{ type: 'message' }] }))).toBeNull();
  });

  it('returns null for non-JSON body', () => {
    expect(stripEmptyTextFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
  });
});

describe('stripEmptyAssistantMessagesFromBody', () => {
  it('drops a thinking-only empty assistant message (moonshot/kimi interrupted placeholder)', () => {
    // 线上污染形态(2026-07-28): 流首包空 thinking 占位被中断持久化。
    const body = buf({
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] },
        { role: 'user', content: 'continue' },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
  });

  it('drops a native empty content-array assistant message', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [] },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!.toString('utf8')).messages).toHaveLength(1);
  });

  it('drops a blank string-content assistant message, keeps a non-blank one', () => {
    const body = buf({
      messages: [
        { role: 'assistant', content: '   ' },
        { role: 'assistant', content: 'real answer' },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content).toBe('real answer');
  });

  it('strips empty thinking but keeps sibling text / tool_use blocks', () => {
    const body = buf({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: '' },
            { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: '' },
            { type: 'text', text: 'done' },
          ],
        },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages[0].content).toEqual([
      { type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } },
    ]);
    expect(parsed.messages[1].content).toEqual([{ type: 'text', text: 'done' }]);
  });

  it('keeps a content-bearing thinking block (empty signature is tolerated)', () => {
    const body = buf({
      messages: [
        { role: 'assistant', content: [{ type: 'thinking', thinking: 'real reasoning', signature: '' }] },
      ],
    });
    expect(stripEmptyAssistantMessagesFromBody(body)).toBeNull();
  });

  it('never touches user messages, even empty ones', () => {
    const body = buf({
      messages: [
        { role: 'user', content: [] },
        { role: 'user', content: 'hi' },
      ],
    });
    expect(stripEmptyAssistantMessagesFromBody(body)).toBeNull();
  });

  it('returns null for a clean body (cache-safe no-op)', () => {
    const body = buf({
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: 'hello' }] },
      ],
    });
    expect(stripEmptyAssistantMessagesFromBody(body)).toBeNull();
  });

  it('drops a text-only empty-block assistant message (bridge cleanup path shape)', () => {
    // PR #821 review: bridge 清理路径产出的 text-only 空块同样命中 moonshot 空消息校验,
    // 只剥 thinking 会让 strip 返回 null、重试被跳过。
    const body = buf({
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'text', text: '' }] },
        { role: 'user', content: 'continue' },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(2);
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'user']);
  });

  it('drops a mixed empty thinking + empty text assistant message, keeps real content siblings', () => {
    const body = buf({
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'thinking', thinking: '', signature: '' },
            { type: 'text', text: '' },
          ],
        },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: '' },
            { type: 'text', text: 'real' },
          ],
        },
      ],
    });
    const out = stripEmptyAssistantMessagesFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0].content).toEqual([{ type: 'text', text: 'real' }]);
  });

  it('returns null for non-JSON / missing messages', () => {
    expect(stripEmptyAssistantMessagesFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
    expect(stripEmptyAssistantMessagesFromBody(buf({ model: 'x' }))).toBeNull();
  });
});

describe('createThreadStripController', () => {
  it('marks active threads and clears them when model changes', () => {
    const controller = createThreadStripController();

    expect(controller.shouldStrip('thread-a')).toBe(false);
    controller.markActive('thread-a', 'gpt-5.5');
    controller.reconcile('thread-a', 'gpt-5.5');
    expect(controller.shouldStrip('thread-a')).toBe(true);
    // 切模型 → reconcile 清除标记
    controller.reconcile('thread-a', 'gpt-5.4');
    expect(controller.shouldStrip('thread-a')).toBe(false);
  });
});

describe('createActiveStripTransform', () => {
  it('strips active thread encrypted_content', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'gpt-5.5');
    const transform = createActiveStripTransform({ controller, enabled: () => true, strip: stripEncryptedContentFromBody });

    const out = transform({ model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] }, ctx);

    expect(out).toEqual({ model: 'gpt-5.5', input: [{}] });
  });

  // 主动剥离排在 codex-proxy transform 链首位, 跨来源压缩兼容 transform 排在其后并以
  // "encrypted_content 非空" 为触发条件。这里先把压缩 blob 剥掉, 那条兼容路径就再也
  // 认不出压缩块, 空壳会一路打到上游 → xAI 400 "Could not decode the compaction blob"。
  it('leaves the compaction blob for the downstream cross-provider transform', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'grok-4.5');
    const transform = createActiveStripTransform({ controller, enabled: () => true, strip: stripEncryptedContentFromBody });

    const out = transform(
      {
        model: 'grok-4.5',
        input: [
          { type: 'compaction', id: 'cmp_abc', encrypted_content: 'BLOB' },
          { type: 'reasoning', encrypted_content: 'gAAA' },
        ],
      },
      ctx,
    );

    expect(out).toEqual({
      model: 'grok-4.5',
      input: [{ type: 'compaction', id: 'cmp_abc', encrypted_content: 'BLOB' }],
    });
  });

  it('strips active thread empty thinking blocks', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'claude-sonnet-4-6');
    const transform = createActiveStripTransform({ controller, enabled: () => true, strip: stripEmptyThinkingFromBody });

    const out = transform(
      {
        model: 'claude-sonnet-4-6',
        messages: [
          { role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }, { type: 'text', text: 'ok' }] },
        ],
      },
      ctx,
    );

    expect(out).toEqual({
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }],
    });
  });

  it('strips active thread image generation history items without id', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'gpt-5.5');
    const transform = createActiveStripTransform({
      controller,
      enabled: () => true,
      strip: stripImageGenerationItemsWithoutIdFromBody,
    });

    const out = transform(
      {
        model: 'gpt-5.5',
        input: [
          { type: 'image_generation_end', call_id: 'ig_1', result: 'data:image/png;base64,xxx' },
          { type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' },
        ],
      },
      ctx,
    );

    expect(out).toEqual({
      model: 'gpt-5.5',
      input: [{ type: 'image_generation_call', id: 'ig_1', result: 'data:image/png;base64,xxx' }],
    });
  });

  it('does not strip without thread id', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'gpt-5.5');
    const transform = createActiveStripTransform({ controller, enabled: () => true, strip: stripEncryptedContentFromBody });

    const out = transform(
      { model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] },
      { ...ctx, headers: {} },
    );

    expect(out).toBeNull();
  });

  it('does not strip when disabled', () => {
    const controller = createThreadStripController();
    controller.markActive('thread-a', 'gpt-5.5');
    const transform = createActiveStripTransform({ controller, enabled: () => false, strip: stripEncryptedContentFromBody });

    const out = transform({ model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] }, ctx);

    expect(out).toBeNull();
  });

  it('keys on the stable x-claude-code-session-id so the mark carries across requests (Layer 2)', () => {
    const controller = createThreadStripController();
    controller.markActive('sess-1', 'claude-sonnet-4-6');
    const transform = createActiveStripTransform({ controller, enabled: () => true, strip: stripEmptyThinkingFromBody });
    const body = {
      model: 'claude-sonnet-4-6',
      messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }, { type: 'text', text: 'ok' }] }],
    };
    const expected = { model: 'claude-sonnet-4-6', messages: [{ role: 'assistant', content: [{ type: 'text', text: 'ok' }] }] };
    // 两个请求 x-client-request-id 不同,但同一会话 → 都命中标记并剥离(若误用 per-request id 则第二次会漏)。
    const out1 = transform(body, { ...ctx, headers: { 'x-claude-code-session-id': 'sess-1', 'x-client-request-id': 'req-A' } });
    const out2 = transform(body, { ...ctx, headers: { 'x-claude-code-session-id': 'sess-1', 'x-client-request-id': 'req-B' } });
    expect(out1).toEqual(expected);
    expect(out2).toEqual(expected);
  });

  it('two controllers are isolated: a thinking mark does not trigger encrypted strip', () => {
    const encrypted = createThreadStripController();
    const thinking = createThreadStripController();
    thinking.markActive('thread-a', 'claude-sonnet-4-6');

    // encrypted transform on the SAME thread → not marked in the encrypted controller → no strip
    const encTransform = createActiveStripTransform({ controller: encrypted, enabled: () => true, strip: stripEncryptedContentFromBody });
    const out = encTransform({ model: 'gpt-5.5', input: [{ encrypted_content: 'gAAA' }] }, ctx);

    expect(out).toBeNull();
  });
});

describe('recovery rule factories', () => {
  it('encrypted rule matches only its error text and strips encrypted_content', () => {
    const rule = createEncryptedContentRecoveryRule({ enabled: () => true });
    expect(rule.id).toBe('encrypted_content');
    expect(rule.matches('... code invalid_encrypted_content ...')).toBe(true);
    expect(rule.matches('Could not decrypt the provided encrypted_content. Ensure the value is the unmodified encrypted_content from a previous response.')).toBe(true);
    expect(rule.matches(JSON.stringify({ code: 'invalid-argument', error: 'Could not decrypt the provided encrypted_content.' }))).toBe(true);
    expect(rule.matches(JSON.stringify({ code: 'invalid-argument', field: 'encrypted_content' }, null, 2))).toBe(true);
    expect(rule.matches('each thinking block must contain thinking')).toBe(false);
    expect(rule.strip(buf({ input: [{ encrypted_content: 'x' }] }))).not.toBeNull();
  });

  it('empty-thinking rule matches only its error text, is always-on by default, and strips empty thinking', () => {
    const rule = createEmptyThinkingRecoveryRule();
    expect(rule.id).toBe('empty_thinking');
    expect(rule.enabled()).toBe(true);
    expect(rule.matches('messages.7.content.0.thinking: each thinking block must contain thinking')).toBe(true);
    expect(rule.matches('invalid_encrypted_content')).toBe(false);
    expect(
      rule.strip(buf({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '' }] }] })),
    ).not.toBeNull();
  });

  it('empty-text rule matches only its error text, is always-on by default, and strips empty text blocks', () => {
    const rule = createEmptyTextRecoveryRule();
    expect(rule.id).toBe('empty_text');
    expect(rule.enabled()).toBe(true);
    // 实测 Anthropic 400(2026-07-23,GPT 订阅会话切 Fable 5):
    expect(rule.matches('messages: text content blocks must be non-empty')).toBe(true);
    expect(rule.matches('messages.5.content.0: text content blocks must contain non-whitespace text')).toBe(true);
    expect(rule.matches('each thinking block must contain thinking')).toBe(false);
    expect(
      rule.strip(buf({ messages: [{ role: 'assistant', content: [{ type: 'text', text: '' }] }] })),
    ).not.toBeNull();
  });

  it('empty-assistant-message rule matches the moonshot error text, is always-on by default, and strips empty assistant messages', () => {
    const rule = createEmptyAssistantMessageRecoveryRule();
    expect(rule.id).toBe('empty_assistant_message');
    expect(rule.enabled()).toBe(true);
    // 线上实测 moonshot 400 原文(2026-07-28,经 LiteLLM passthrough,两个独立会话):
    expect(
      rule.matches(
        'Invalid request: the message at position 693 with role \'assistant\' must not be empty',
      ),
    ).toBe(true);
    expect(
      rule.matches(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            message: "Invalid request: the message at position 275 with role 'assistant' must not be empty",
          },
        }),
      ),
    ).toBe(true);
    expect(rule.matches('each thinking block must contain thinking')).toBe(false);
    expect(rule.matches('invalid_encrypted_content')).toBe(false);
    expect(
      rule.strip(
        buf({ messages: [{ role: 'assistant', content: [{ type: 'thinking', thinking: '', signature: '' }] }] }),
      ),
    ).not.toBeNull();
  });

  it('image-generation-id rule matches only its error text, is always-on by default, and strips malformed items', () => {
    const rule = createImageGenerationIdRecoveryRule();
    expect(rule.id).toBe('image_generation_id');
    expect(rule.enabled()).toBe(true);
    expect(rule.matches('Image generation items without `id` are not supported for this request.')).toBe(true);
    expect(rule.matches('invalid_encrypted_content')).toBe(false);
    expect(
      rule.strip(buf({ input: [{ type: 'image_generation_end', call_id: 'ig_1' }] })),
    ).not.toBeNull();
  });

  it('tool-use provider field rule matches the LiteLLM schema error and strips the field', () => {
    const rule = createToolUseProviderSpecificFieldsRecoveryRule();
    expect(rule.id).toBe('tool_use_provider_specific_fields');
    expect(rule.enabled()).toBe(true);
    expect(rule.matches('messages.2.content.0.tool_use.provider_specific_fields: Extra inputs are not permitted')).toBe(true);
    expect(rule.matches('messages.2.content.0.tool_use.name: Extra inputs are not permitted')).toBe(false);
    expect(rule.matches(JSON.stringify([
      { message: 'messages.2.content.0.tool_use.provider_specific_fields: unexpected value' },
      { message: 'messages.2.content.1.name: Extra inputs are not permitted' },
    ]))).toBe(false);
    expect(
      rule.strip(buf({ messages: [{ role: 'assistant', content: [{ type: 'tool_use', provider_specific_fields: null }] }] })),
    ).not.toBeNull();
  });
});

describe('stripNonAnthropicFields · glm-5.2 tool_result 图像降级 (#794)', () => {
  const imageBlock = {
    type: 'image',
    source: { type: 'base64', media_type: 'image/png', data: 'AAAABBBB' },
  };
  const makeBody = (model: string): Record<string, unknown> => ({
    model,
    messages: [
      { role: 'user', content: 'read the scan' },
      {
        role: 'user',
        content: [
          {
            type: 'tool_result',
            tool_use_id: 't1',
            content: [{ type: 'text', text: 'scan follows' }, imageBlock],
          },
        ],
      },
    ],
  });

  it.each(['glm-5.2', 'z-ai/glm-5.2', 'glm-5.2[1m]', 'z-ai/glm-5.2[1m]'])(
    '%s:tool_result 图像替换为说明性占位文本,图像字节不外泄',
    (model) => {
      const out = stripNonAnthropicFields(makeBody(model), ctx) as Record<string, unknown> | null;
      expect(out).not.toBeNull();
      const json = JSON.stringify(out);
      expect(json).not.toContain('AAAABBBB');
      expect(json).toContain('[image omitted:');
      expect(json).toContain('Do NOT guess');
      // 同一 tool_result 的文本块保留,块结构仍是 tool_result。
      expect(json).toContain('scan follows');
      expect(json).toContain('tool_result');
    },
  );

  it('glm-5.2 无图像时返回 null(cache 安全契约,字节透传)', () => {
    const body = {
      model: 'glm-5.2',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: [{ type: 'text', text: 'ok' }] },
          ],
        },
      ],
    };
    expect(stripNonAnthropicFields(body, ctx)).toBeNull();
  });

  it('未登记的 model 不受影响(字节透传)', () => {
    expect(
      stripNonAnthropicFields(makeBody('claude-opus-5'), ctx),
    ).toBeNull();
  });

  it('user 消息里的图像不动,只处理 tool_result 内嵌图像', () => {
    const body = {
      model: 'glm-5.2',
      messages: [{ role: 'user', content: [imageBlock] }],
    };
    expect(stripNonAnthropicFields(body, ctx)).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// Tool exchange 结构修复(kimi/moonshot 序号 id 复用 + 配对断裂)
// 背景: 2026-07 两个独立会话实测,moonshot 序号 id 跨 turn 复用(Edit_306 /
// Bash_256 各 20+ 次)致会话安静瘫痪;修复方案与 kimi code 官方客户端
// (kosong normalize + agent-core projector)同构。
// ───────────────────────────────────────────────────────────────────────────

describe('dedupeDuplicateToolUseIdsFromBody', () => {
  it('rewrites the 2nd occurrence of a duplicated id and its paired result', () => {
    // 线上事故形态: 同 id 的完整配对历史重复出现。
    const body = buf({
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'fix it' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'not found' }] },
      ],
    });
    const out = dedupeDuplicateToolUseIdsFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[1].content[0].id).toBe('Edit_306');
    expect(parsed.messages[2].content[0].tool_use_id).toBe('Edit_306');
    expect(parsed.messages[3].content[0].id).toBe('Edit_306_2');
    expect(parsed.messages[4].content[0].tool_use_id).toBe('Edit_306_2');
    // 业务数据(input / result content)原样保留。
    expect(parsed.messages[3].content[0].input).toEqual({ a: 2 });
    expect(parsed.messages[4].content[0].content).toBe('not found');
  });

  it('numbers the 3rd+ occurrences sequentially', () => {
    const mk = (input: unknown) => ({
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'Bash_256', name: 'Bash', input }],
    });
    const mkRes = (content: string) => ({
      role: 'user',
      content: [{ type: 'tool_result', tool_use_id: 'Bash_256', content }],
    });
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        mk({ c: 1 }), mkRes('r1'), mk({ c: 2 }), mkRes('r2'), mk({ c: 3 }), mkRes('r3'),
      ],
    });
    const out = dedupeDuplicateToolUseIdsFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[1].content[0].id).toBe('Bash_256');
    expect(parsed.messages[3].content[0].id).toBe('Bash_256_2');
    expect(parsed.messages[5].content[0].id).toBe('Bash_256_3');
    expect(parsed.messages[6].content[0].tool_use_id).toBe('Bash_256_3');
  });

  it('skips a suffix candidate that collides with a pre-existing distinct id', () => {
    // 历史里已有一个独立的 Edit_306_2(不同 call) → Edit_306 的第 2 次出现顺延到 _3。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'r1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306_2', name: 'Edit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306_2', content: 'r2' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_306', name: 'Edit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_306', content: 'r3' }] },
      ],
    });
    const out = dedupeDuplicateToolUseIdsFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    // 独立的 Edit_306_2 不动;重复的 Edit_306 第 2 次顺延到 _3,配对 result 同步。
    expect(parsed.messages[3].content[0].id).toBe('Edit_306_2');
    expect(parsed.messages[5].content[0].id).toBe('Edit_306_3');
    expect(parsed.messages[6].content[0].tool_use_id).toBe('Edit_306_3');
  });

  it('dedupes parallel duplicate calls inside a single assistant message', () => {
    // 同一条 assistant 消息内两个同 id tool_use(parallel 形态)+ 同一条 user 内两个 result。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'Read_305', name: 'Read', input: { f: 'a' } },
            { type: 'tool_use', id: 'Read_305', name: 'Read', input: { f: 'b' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'Read_305', content: 'a-content' },
            { type: 'tool_result', tool_use_id: 'Read_305', content: 'b-content' },
          ],
        },
      ],
    });
    const out = dedupeDuplicateToolUseIdsFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[1].content.map((b: { id: string }) => b.id)).toEqual(['Read_305', 'Read_305_2']);
    expect(parsed.messages[2].content.map((b: { tool_use_id: string }) => b.tool_use_id)).toEqual(['Read_305', 'Read_305_2']);
    // 顺序配对: 第二个 result(b-content)跟随第二个 call。
    expect(parsed.messages[2].content[1].content).toBe('b-content');
  });

  it('leaves a result without a matching Nth call untouched', () => {
    // 2 个 call、3 个 result: 第 3 个 result 无第 3 个 call 可配,保持原样(指向首现
    // call,协议合法;孤儿清理由 repairToolExchangeAdjacency 负责)。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X_1', name: 'X', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X_1', content: 'r1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X_1', name: 'X', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X_1', content: 'r2' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X_1', content: 'r3-stray' }] },
      ],
    });
    const out = dedupeDuplicateToolUseIdsFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[3].content[0].id).toBe('X_1_2');
    expect(parsed.messages[4].content[0].tool_use_id).toBe('X_1_2');
    expect(parsed.messages[5].content[0].tool_use_id).toBe('X_1');
  });

  it('returns null when every id is unique (cache-safe no-op)', () => {
    const body = buf({
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_1', name: 'Edit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_1', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'Edit_2', name: 'Edit', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'Edit_2', content: 'ok' }] },
      ],
    });
    expect(dedupeDuplicateToolUseIdsFromBody(body)).toBeNull();
  });

  it('returns null for non-JSON body / missing messages', () => {
    expect(dedupeDuplicateToolUseIdsFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
    expect(dedupeDuplicateToolUseIdsFromBody(buf({ model: 'x' }))).toBeNull();
  });

  it('tolerates string content and id-less blocks without crashing', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'plain string' },
        { role: 'assistant', content: 'plain assistant string' },
        { role: 'assistant', content: [{ type: 'tool_use', name: 'Edit', input: {} }] }, // 缺 id
        { role: 'user', content: [{ type: 'tool_result', content: 'no id' }] }, // 缺 tool_use_id
      ],
    });
    expect(dedupeDuplicateToolUseIdsFromBody(body)).toBeNull();
  });
});

describe('dedupeDuplicateToolUseIds (RequestTransform)', () => {
  it('rewrites via the object form and does not mutate the input', () => {
    const original: { model: string; messages: Array<{ role: string; content: Array<Record<string, unknown>> }> } = {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'E_1', name: 'E', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'E_1', content: 'r1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'E_1', name: 'E', input: {} }] },
      ],
    };
    const out = dedupeDuplicateToolUseIds(original, ctx) as typeof original | null;
    expect(out).not.toBeNull();
    expect(out!.messages[2].content[0].id).toBe('E_1_2');
    // 输入对象未被原地改写。
    expect(original.messages[2].content[0].id).toBe('E_1');
  });

  it('returns null for a clean body', () => {
    expect(
      dedupeDuplicateToolUseIds(
        { messages: [{ role: 'assistant', content: [{ type: 'tool_use', id: 'E_1', name: 'E', input: {} }] }] },
        ctx,
      ),
    ).toBeNull();
  });
});

describe('repairToolExchangeAdjacencyFromBody', () => {
  it('returns null for a well-formed paired history (cache-safe no-op)', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    });
    expect(repairToolExchangeAdjacencyFromBody(body)).toBeNull();
  });

  it('drops an orphan result block but keeps the sibling text', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
            { type: 'tool_result', tool_use_id: 'orphan_999', content: 'stray' },
            { type: 'text', text: 'note' },
          ],
        },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'ok' },
      { type: 'text', text: 'note' },
    ]);
  });

  it('drops a user message left empty by orphan removal and closes the stranded call', () => {
    // 孤儿块是唯一内容 → 整条 user 丢弃;stranded call(t1)后面有 assistant 推进
    // → 非 trailing,合成占位封闭(新建 user 消息紧邻插入)。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'orphan_9', content: 'stray' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant',
    ]);
    expect(parsed.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
      },
    ]);
  });

  it('prepends a synthetic result into the immediately following user message', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: '还有问题' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(3);
    // result 块在 text 前(Anthropic 惯例)。
    expect(parsed.messages[2].content.map((b: { type: string }) => b.type)).toEqual(['tool_result', 'text']);
    expect(parsed.messages[2].content[0].tool_use_id).toBe('t1');
  });

  it('converts a string-content user message to an array when prepending', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: 'next question' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
      },
      { type: 'text', text: 'next question' },
    ]);
  });

  it('closes multiple missing calls of one assistant message in order', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[2].content.map((b: { tool_use_id?: string }) => b.tool_use_id)).toEqual(['t1', 't2', undefined]);
  });

  it('leaves a trailing open exchange untouched (call may still be in flight)', () => {
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
      ],
    });
    expect(repairToolExchangeAdjacencyFromBody(body)).toBeNull();
  });

  it('treats a pure tool_result tail as part of the trailing exchange', () => {
    // user(result t1) 是纯 result 消息,不算对话推进点;同 assistant 的 t2 未配对
    // 但之后没有推进点 → trailing,不动。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });
    expect(repairToolExchangeAdjacencyFromBody(body)).toBeNull();
  });

  it('closes a mid-history stranded call even when a later assistant exists', () => {
    // user, A(callX 未配对), B(text): B 证明模型已 move on → 非 trailing,封闭。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Bash', input: {} }] },
        { role: 'assistant', content: [{ type: 'text', text: '我以为发出去了' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(parsed.messages[2].content[0].tool_use_id).toBe('X');
  });

  it('moves a displaced result back next to its call (kimi consumed-scan)', () => {
    // review 反例: result 存在但与 call 之间隔了一条 user(text) —— 全局配对视角
    // "有应答",但 Anthropic strict adjacency 仍非法 → 必须前移重排。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'intervening' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'late result' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    // result 前移到 call 紧邻的 user 消息开头;原位置 user 消息清空 → 整条丢。
    expect(parsed.messages).toHaveLength(3);
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'late result' },
      { type: 'text', text: 'intervening' },
    ]);
  });

  it('reorders a result that sits after a text block in the adjacent user message', () => {
    // 块级错位(review 反例): result 在紧邻 user 消息里,但排在 text 之后 ——
    // 消息级"已邻接",块级仍非法 → 移进前导 tool_result 区间。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'text', text: 'note first' },
            { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
          ],
        },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'text', text: 'note first' },
    ]);
  });

  it('keeps leading results in place and reorders only the trailing one (parallel calls)', () => {
    // 多 call: t1 已在前导区间(不动),t2 落在 text 后 → 只重排 t2,
    // 插到前导区间末尾(保持与 call 顺序一致)。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
            { type: 'text', text: 'middle' },
            { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
          ],
        },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
      { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
      { type: 'text', text: 'middle' },
    ]);
  });

  it('drops a surplus result for the same call id (one call, one answer)', () => {
    // 同 id 第二个 result: 不是孤儿(callIds 里有),但一个 call 恰应有一个应答 →
    // 接力消费后池中剩余,丢弃(与 kimi duplicate_tool_result_dropped 同语义)。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'first' },
            { type: 'tool_result', tool_use_id: 't1', content: 'surplus' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 't1', content: 'first' },
    ]);
  });

  it('drops a result that precedes its call and closes the call with a placeholder', () => {
    // result 出现在 call 之前 = 引用未来 call,上游必然 400;接力消费只取 call
    // 之后的 result,前置块留在池中 → 丢弃,call 按缺失合成。
    const body = buf({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'too early' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: 'next' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    // 前置 result 所在 user 消息清空 → 整条丢;call 后紧邻 user 并入合成占位。
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user']);
    expect(parsed.messages[1].content[0]).toEqual({
      type: 'tool_result',
      tool_use_id: 't1',
      content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
    });
  });

  it('keeps trailing-exchange results: fully paired trailing calls stay byte-clean', () => {
    // trailing assistant 的 parallel calls + 尾部纯 result 消息 = 正常末尾交换,
    // 接力消费后池空、无插入 → null(尾部 result 不得误判为残留)。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 't1', content: 'r1' },
            { type: 'tool_result', tool_use_id: 't2', content: 'r2' },
          ],
        },
      ],
    });
    expect(repairToolExchangeAdjacencyFromBody(body)).toBeNull();
  });

  it('does not append a text block when prepending into a whitespace-only string user', () => {
    // 空白 string content 转数组时不附加 text 块 —— 否则新造空 text 块,
    // 转头命中 "text content blocks must be non-empty" 400。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: '   ' },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages[2].content).toEqual([
      {
        type: 'tool_result',
        tool_use_id: 't1',
        content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
      },
    ]);
  });

  it('does not steal a later call\'s real result for an earlier same-id gap (Greptile P1)', () => {
    // Greptile P1 反例: 较早的同 id call 缺 result、较晚 call 有真实结果。
    // 位置配对必须优先 —— r2 只能配给 call#2;call#1 合成占位,不得张冠李戴。
    const body = buf({
      messages: [
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2-real' }] },
        { role: 'user', content: '继续' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'assistant', 'user', 'assistant', 'user', 'user',
    ]);
    // call#1 得到合成占位;call#2 保留真实结果 r2。
    expect(parsed.messages[1].content[0]).toMatchObject({
      type: 'tool_result',
      tool_use_id: 'X',
      content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
    });
    expect(parsed.messages[3].content[0]).toMatchObject({ tool_use_id: 'X', content: 'r2-real' });
  });

  it('positional pairing wins over relay even when the later call is trailing', () => {
    // 变体: 较晚 call 是 trailing(末尾交换)。它紧邻位置的真实 result 仍归它
    // (trailing 参与位置配对),较早缺口 call 合成,池不被越权消费。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2-real' }] },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user',
    ]);
    expect(parsed.messages[2].content[0].content).toContain('Tool result is not available');
    expect(parsed.messages[4].content[0]).toMatchObject({ tool_use_id: 'X', content: 'r2-real' });
  });

  it('relay stays inside the owning interval: a later call\'s displaced result is not stolen', () => {
    // Greptile 第二轮反例: 两个同 id call 都无紧邻 result(位置配对均失败),
    // call#2 的真实 result 错位在更后 —— 接力按归属区间(到下一个同 id call
    // 为止)取块:r2 归 call#2 前移,call#1 合成,不再先到先得。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'text', text: '之间' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2-real' }] },
        { role: 'user', content: '继续' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'assistant', 'user', 'user',
    ]);
    // call#1 → 新建 user 合成占位;call#2 → r2 前移到其紧邻 user(之间)的前导区间。
    expect(parsed.messages[2].content[0].content).toContain('Tool result is not available');
    expect(parsed.messages[4].content).toEqual([
      { type: 'tool_result', tool_use_id: 'X', content: 'r2-real' },
      { type: 'text', text: '之间' },
    ]);
  });

  it('keeps trailing parallel results arriving in separate messages (no kill)', () => {
    // trailing parallel calls 的 result 分多条纯 result 消息回来 = 合法末尾
    // 交换。t2 位置配对失败(i+1 里只有 t1),trailing 接力只消费保护不修复,
    // 不得被"池剩余丢弃"误杀 → 整体 byte-clean 返回 null。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 't1', name: 'Bash', input: {} },
            { type: 'tool_use', id: 't2', name: 'Read', input: {} },
          ],
        },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'r1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'r2' }] },
      ],
    });
    expect(repairToolExchangeAdjacencyFromBody(body)).toBeNull();
  });

  it('same-message parallel same-id calls pair a stray result in call order', () => {
    // 同一条 assistant 消息内的 parallel 同 id calls 同批发出,其中一个
    // result 丢失时归属在原理上不可判定(两种归属的世界序列化后字节相同)。
    // 这里锁定的是**稳定 tie-breaker 契约**:区间内涵 call 块顺序配序
    // (受典型 client serializer 支持:SDK Tool Runner Promise.all 的结果数组
    // 保持输入序)—— 是可复现的默认约定,不是"证明 stray 属于 call#1"。
    // (归属区间按 exchange 粒度计算,同消息 calls 共享区间。)
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } },
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '之间' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'stray' }] },
        { role: 'user', content: '继续' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'user',
    ]);
    // stray 前移到紧邻 user(之间)前导区间(配 call#1),call#2 合成紧随其后。
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'X', content: 'stray' },
      {
        type: 'tool_result',
        tool_use_id: 'X',
        content: 'Tool result is not available in the current context. Do not assume the tool completed successfully.',
      },
      { type: 'text', text: '之间' },
    ]);
  });

  it('two displaced same-id results keep pool order onto call order (stable serializer contract)', () => {
    // 契约测试: 同消息 parallel 同 id calls 均无紧邻 result,池中两个错位
    // result 按位置顺序 zip 到 call 顺序(r1→call#1、r2→call#2)—— 锁定
    // stable tie-breaker 在多元件下的可复现性。
    const body = buf({
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } },
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '之间' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r1' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2' }] },
        { role: 'user', content: '继续' },
      ],
    });
    const out = repairToolExchangeAdjacencyFromBody(body);
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual([
      'user', 'assistant', 'user', 'user',
    ]);
    expect(parsed.messages[2].content).toEqual([
      { type: 'tool_result', tool_use_id: 'X', content: 'r1' },
      { type: 'tool_result', tool_use_id: 'X', content: 'r2' },
      { type: 'text', text: '之间' },
    ]);
  });

  it('returns null for non-JSON body / missing messages', () => {
    expect(repairToolExchangeAdjacencyFromBody(Buffer.from('not json', 'utf8'))).toBeNull();
    expect(repairToolExchangeAdjacencyFromBody(buf({ model: 'x' }))).toBeNull();
  });
});

describe('repairToolExchangeAdjacency (RequestTransform)', () => {
  it('repairs via the object form and does not mutate the input', () => {
    const original = {
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'text', text: 'next' }] },
      ],
    };
    const out = repairToolExchangeAdjacency(original, ctx) as typeof original | null;
    expect(out).not.toBeNull();
    expect((out!.messages[2].content as unknown[]).length).toBe(2);
    // 输入未被原地改写。
    expect((original.messages[2].content as unknown[]).length).toBe(1);
  });
});

describe('duplicate tool_use id / tool exchange adjacency recovery rules', () => {
  it('duplicate id rule: matches the anthropic error, strips dupes, ignores others', () => {
    const rule = createDuplicateToolUseIdRecoveryRule();
    expect(rule.id).toBe('duplicate_tool_use_id');
    expect(rule.enabled()).toBe(true);
    expect(rule.matches('messages: `tool_use` ids must be unique')).toBe(true);
    expect(rule.matches('{"error":{"message":"messages.5: `tool_use` ids must be unique"}}')).toBe(true);
    expect(rule.matches('some other 400')).toBe(false);
    // 无重复可修 → strip null(该规则让位)。
    expect(rule.strip(buf({ messages: [{ role: 'user', content: 'hi' }] }))).toBeNull();
  });

  it('adjacency rule: matches moonshot / anthropic phrasings, not a plain 404', () => {
    const rule = createToolExchangeAdjacencyRecoveryRule();
    expect(rule.id).toBe('tool_exchange_adjacency');
    expect(rule.enabled()).toBe(true);
    // Moonshot chatcmpl 校验透出(原文双空格)。
    expect(rule.matches('Invalid request: tool_call_id  is not found')).toBe(true);
    // Anthropic 孤儿 result。
    expect(rule.matches("messages.0.content.0: unexpected `tool_use_id` found in `tool_result` blocks")).toBe(true);
    // Anthropic 未配对 call。
    expect(rule.matches('messages.3: `tool_use` ids were found without `tool_result` blocks immediately after: toolu_01ABC')).toBe(true);
    // OpenAI 系(LiteLLM 版本差异可能透出): 孤儿 tool 消息 / 未配对 call。
    expect(rule.matches("messages with role 'tool' must be a response to a preceding message with 'tool_calls'")).toBe(true);
    expect(rule.matches('the following tool_call_ids did not have response messages: call_1')).toBe(true);
    expect(rule.matches('unexpected `tool_result` block')).toBe(true);
    // 404 类 not found 不命中(锚定 tool_call_id)。
    expect(rule.matches('404 model not found')).toBe(false);
  });
});

describe('repair → dedupe 链式顺序(host 主动链同序)', () => {
  it('同消息 parallel 同 id + 一个错位 result:真实 R→X、合成→X_2(端到端契约)', () => {
    // 端到端契约: repair 先把 stray 配给 call#1(稳定 tie-breaker)、call#2
    // 合成,dedupe 再把 call#2 改名 X_2、第 2 个 result(合成块)同步改名。
    const body = {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: 'go' },
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } },
            { type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } },
          ],
        },
        { role: 'user', content: [{ type: 'text', text: '之间' }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'stray' }] },
        { role: 'user', content: '继续' },
      ],
    };
    const afterRepair = repairToolExchangeAdjacency(body, ctx) as typeof body | null;
    expect(afterRepair).not.toBeNull();
    const afterBoth = dedupeDuplicateToolUseIds(afterRepair!, ctx) as typeof body | null;
    expect(afterBoth).not.toBeNull();
    const messages = afterBoth!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    expect(messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'user']);
    const calls = messages[1].content;
    expect(calls[0].id).toBe('X');
    expect(calls[1].id).toBe('X_2');
    // 真实 stray 配 call#1(保持 X);合成块配 call#2(同步改名 X_2)。
    expect(messages[2].content[0]).toMatchObject({ tool_use_id: 'X', content: 'stray' });
    expect(messages[2].content[1]).toMatchObject({ tool_use_id: 'X_2' });
    expect(String(messages[2].content[1].content)).toContain('Tool result is not available');
  });

  it('前置 same-id result 不污染 dedupe 的配对序号(复审反例)', () => {
    // 复审反例: dedupe 先跑时,'early' 白占 result 序号 1,本属 call#1 的 r1
    // 被改名给 call#2,repair 按改名后 id 配对 → 张冠李戴。repair 先跑则
    // 前置块先被丢弃,result 与 call 严格同序,dedupe 配对正确。
    const body = {
      model: 'moonshot/kimi-k3',
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'early' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2' }] },
        { role: 'assistant', content: [{ type: 'text', text: 'done' }] },
      ],
    };
    const afterRepair = repairToolExchangeAdjacency(body, ctx) as typeof body | null;
    expect(afterRepair).not.toBeNull();
    const afterBoth = dedupeDuplicateToolUseIds(afterRepair!, ctx) as typeof body | null;
    expect(afterBoth).not.toBeNull();
    const messages = afterBoth!.messages as Array<{ role: string; content: Array<Record<string, unknown>> }>;
    // 前置 'early' 所在 user 整条丢;call#1 → X(配 r1),call#2 → X_2(配 r2)。
    expect(messages.map((m) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user', 'assistant']);
    expect(messages[0].content[0].id).toBe('X');
    expect(messages[1].content[0]).toMatchObject({ tool_use_id: 'X', content: 'r1' });
    expect(messages[2].content[0].id).toBe('X_2');
    expect(messages[3].content[0]).toMatchObject({ tool_use_id: 'X_2', content: 'r2' });
  });

  it('组合 strip(recovery 共用)同序修复且不改写干净 body', () => {    // 同一 body 经组合函数: 前置丢弃 + 合成/重排 + 唯一化一次完成。
    const polluted = buf({
      messages: [
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'early' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 1 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r1' }] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'X', name: 'Edit', input: { a: 2 } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'X', content: 'r2' }] },
      ],
    });
    const out = repairToolExchangeStructureFromBody(polluted);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!.toString('utf8'));
    expect(parsed.messages.map((m: { role: string }) => m.role)).toEqual(['assistant', 'user', 'assistant', 'user']);
    expect(parsed.messages[1].content[0]).toMatchObject({ tool_use_id: 'X', content: 'r1' });
    expect(parsed.messages[3].content[0]).toMatchObject({ tool_use_id: 'X_2', content: 'r2' });
    // 干净 body → null(两步都无改动)。
    const clean = buf({
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: {} }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'ok' }] },
      ],
    });
    expect(repairToolExchangeStructureFromBody(clean)).toBeNull();
  });
});
