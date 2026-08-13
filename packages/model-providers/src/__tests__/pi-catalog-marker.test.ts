import { describe, expect, it } from 'vitest';

import { effectivePiWireProtocol } from '../pi-catalog-marker.js';

describe('effectivePiWireProtocol', () => {
  it('normalizes an omitted Pi protocol to openai-chat', () => {
    expect(effectivePiWireProtocol(undefined)).toBe('openai-chat');
    expect(effectivePiWireProtocol('openai-chat')).toBe('openai-chat');
  });

  it('preserves explicit non-default protocols', () => {
    expect(effectivePiWireProtocol('anthropic-messages')).toBe('anthropic-messages');
    expect(effectivePiWireProtocol('openai-responses')).toBe('openai-responses');
  });
});
