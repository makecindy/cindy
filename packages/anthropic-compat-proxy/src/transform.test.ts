import { describe, expect, it } from 'vitest';

import { createThreadStripController } from './thread-strip-controller.js';
import {
  createActiveStripTransform,
  createEmptyTextRecoveryRule,
  createEmptyThinkingRecoveryRule,
  createEncryptedContentRecoveryRule,
  createImageGenerationIdRecoveryRule,
  createToolUseProviderSpecificFieldsRecoveryRule,
  stripEmptyTextFromBody,
  stripEmptyThinkingFromBody,
  stripEncryptedContentFromBody,
  stripImageGenerationItemsWithoutIdFromBody,
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

describe('stripEncryptedContentFromBody', () => {
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
