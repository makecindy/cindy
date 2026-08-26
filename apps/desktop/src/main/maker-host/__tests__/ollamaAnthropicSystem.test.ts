import { afterEach, describe, expect, it } from 'vitest';

import { MANAGED_OLLAMA_PROVIDER_ID } from '../../../shared/localModelRuntime.js';
import {
  coalesceAnthropicMessagesForOllama,
  createOllamaAnthropicSystemTransform,
} from '../ollamaAnthropicSystem.js';
import { clearSessionProvider, setSessionProvider } from '../session-provider-store.js';

const BODY = {
  model: 'qwen3.8:27b-mxfp8',
  system: [
    { type: 'text', text: 'top', cache_control: { type: 'ephemeral' } },
  ],
  messages: [
    { role: 'user', content: 'hi' },
    { role: 'assistant', content: 'hello' },
    { role: 'system', content: [{ type: 'text', text: 'later note' }] },
    { role: 'user', content: 'again' },
  ],
};

describe('coalesceAnthropicMessagesForOllama', () => {
  it('moves mid-conversation system messages and keeps top-level text blocks', () => {
    expect(coalesceAnthropicMessagesForOllama(BODY)).toEqual({
      model: 'qwen3.8:27b-mxfp8',
      system: [
        { type: 'text', text: 'top', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'later note' },
      ],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'hello' },
        { role: 'user', content: 'again' },
      ],
    });
  });

  it('returns null when there is no mid-list system message', () => {
    expect(
      coalesceAnthropicMessagesForOllama({
        model: 'qwen3.8:27b-mxfp8',
        system: 'only top',
        messages: [{ role: 'user', content: 'hi' }],
      }),
    ).toBeNull();
  });

  it('still strips empty late system messages so Ollama cannot see them', () => {
    expect(
      coalesceAnthropicMessagesForOllama({
        model: 'qwen3.8:27b-mxfp8',
        system: 'top',
        messages: [
          { role: 'user', content: 'hi' },
          { role: 'system', content: '' },
          { role: 'user', content: 'again' },
        ],
      }),
    ).toEqual({
      model: 'qwen3.8:27b-mxfp8',
      system: [{ type: 'text', text: 'top' }],
      messages: [
        { role: 'user', content: 'hi' },
        { role: 'user', content: 'again' },
      ],
    });
  });
});

describe('createOllamaAnthropicSystemTransform', () => {
  afterEach(() => {
    clearSessionProvider('s-ollama');
    clearSessionProvider('s-other');
  });

  const ctx = {
    reqId: 1,
    method: 'POST',
    url: '/v1/messages',
    headers: { 'x-claude-code-session-id': 'sdk-1' },
  };

  it('rewrites only when the session is managed Ollama', () => {
    setSessionProvider('s-ollama', MANAGED_OLLAMA_PROVIDER_ID);
    const transform = createOllamaAnthropicSystemTransform((headers) =>
      headers['x-claude-code-session-id'] ? 's-ollama' : null,
    );
    const next = transform(BODY, ctx);
    expect(next).toMatchObject({
      system: [
        { type: 'text', text: 'top', cache_control: { type: 'ephemeral' } },
        { type: 'text', text: 'later note' },
      ],
    });
    expect((next as { messages: Array<{ role: string }> }).messages.some((item) => item.role === 'system')).toBe(
      false,
    );
  });

  it('does not rewrite non-Qwen Ollama models', () => {
    setSessionProvider('s-ollama', MANAGED_OLLAMA_PROVIDER_ID);
    const transform = createOllamaAnthropicSystemTransform(() => 's-ollama');
    expect(
      transform(
        {
          ...BODY,
          model: 'llama3.1:8b',
        },
        ctx,
      ),
    ).toBeNull();
  });

  it('does not rewrite other providers or a missing session', () => {
    setSessionProvider('s-other', 'anthropic');
    const other = createOllamaAnthropicSystemTransform(() => 's-other');
    expect(other(BODY, ctx)).toBeNull();
    const missing = createOllamaAnthropicSystemTransform(() => null);
    expect(missing(BODY, ctx)).toBeNull();
  });
});
