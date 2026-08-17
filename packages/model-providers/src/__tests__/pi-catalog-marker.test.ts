import { describe, expect, it } from 'vitest';

import { effectivePiWireProtocol, resolvePiModelWireProtocol } from '../pi-catalog-marker.js';

describe('effectivePiWireProtocol', () => {
  it('keeps an omitted Pi protocol distinct from explicit Chat', () => {
    expect(effectivePiWireProtocol(undefined)).toBeUndefined();
    expect(effectivePiWireProtocol('openai-chat')).toBe('openai-chat');
  });

  it('preserves explicit non-default protocols', () => {
    expect(effectivePiWireProtocol('anthropic-messages')).toBe('anthropic-messages');
    expect(effectivePiWireProtocol('openai-responses')).toBe('openai-responses');
  });
});

describe('resolvePiModelWireProtocol', () => {
  it('prefers a portable model override over route and provider defaults', () => {
    expect(
      resolvePiModelWireProtocol(
        {
          piApi: 'anthropic-messages',
          route: { wireProtocol: 'openai-responses' },
        },
        'openai-chat',
      ),
    ).toBe('anthropic-messages');
    expect(resolvePiModelWireProtocol({ piApi: 'openai-completions' }, 'openai-responses')).toBe(
      'openai-chat',
    );
  });

  it('uses route then provider defaults and fails closed for native Google', () => {
    expect(
      resolvePiModelWireProtocol({ route: { wireProtocol: 'openai-responses' } }, 'openai-chat'),
    ).toBe('openai-responses');
    expect(resolvePiModelWireProtocol(undefined, 'openai-chat')).toBe('openai-chat');
    expect(resolvePiModelWireProtocol({ piApi: 'google-generative-ai' }, 'openai-chat')).toBeNull();
    expect(resolvePiModelWireProtocol(undefined, undefined)).toBeNull();
  });
});
