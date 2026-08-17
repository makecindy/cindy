import { describe, expect, it } from 'vitest';

import { effectivePiWireProtocol } from '../pi-catalog-marker.js';

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
