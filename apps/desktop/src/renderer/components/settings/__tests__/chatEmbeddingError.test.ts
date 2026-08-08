import { describe, expect, it } from 'vitest';

import { chatEmbeddingFailureKey } from '../chatEmbeddingError';

describe('chat embedding error localization', () => {
  it('maps unavailable access without exposing the main-process message', () => {
    const error = new Error(
      'Error invoking remote method: Error: [UNSUPPORTED_CAPABILITY] raw English detail',
    );
    expect(chatEmbeddingFailureKey(error)).toBe('settings.chatEmbedding.toast.unavailable');
  });

  it('uses localized fallback copy for other failures', () => {
    expect(chatEmbeddingFailureKey(new Error('[INTERNAL] raw internal detail'))).toBe(
      'settings.chatEmbedding.toast.toggleFailed',
    );
    expect(chatEmbeddingFailureKey(new Error('raw unstructured detail'))).toBe(
      'settings.chatEmbedding.toast.toggleFailed',
    );
  });
});
