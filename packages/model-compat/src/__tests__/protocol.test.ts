import { describe, expect, it } from 'vitest';
import { compatibilityProtocol, selectCompatibilityRoute } from '../protocol';

describe('protocol selection uses declared routes', () => {
  it('chooses native requests without changing the selected harness or inventing routes', () => {
    const chat = { protocol: 'openai-chat' as const, endpoint: '/chat/completions' };
    const messages = { protocol: 'anthropic' as const, endpoint: '/messages' };
    const responses = { protocol: 'openai-responses' as const, endpoint: '/responses' };
    expect(selectCompatibilityRoute('claude-code', [chat, messages, responses])).toBe(messages);
    expect(selectCompatibilityRoute('codex', [chat, messages, responses])).toBe(responses);
    expect(selectCompatibilityRoute('pi', [chat, messages, responses])).toBe(chat);
    expect(selectCompatibilityRoute('codex', [chat])).toBe(chat);
    expect(selectCompatibilityRoute('claude-code', [])).toBeUndefined();
  });
  it('separates cloud transport identity from request language without false aliases', () => {
    expect(compatibilityProtocol('azure-openai-responses')).toBe('openai-responses');
    expect(compatibilityProtocol('google-vertex')).toBe('google');
    expect(compatibilityProtocol('bedrock-converse-stream')).toBeNull();
    expect(compatibilityProtocol('mistral-conversations')).toBeNull();
  });
});
