import { describe, expect, it } from 'vitest';

import { resolveNativeVoiceActivation } from '../nativeVoiceActivation.js';

describe('resolveNativeVoiceActivation', () => {
  it('pairs start and end on the same source', () => {
    const started = resolveNativeVoiceActivation(null, 'start', 'hardware', false);
    expect(started).toEqual({ owner: 'hardware', deliver: true });

    const ended = resolveNativeVoiceActivation(started.owner, 'end', 'hardware', false);
    expect(ended).toEqual({ owner: null, deliver: true });
  });

  it('ignores a second source while the first is held', () => {
    const held = resolveNativeVoiceActivation(null, 'start', 'hardware', false);

    expect(resolveNativeVoiceActivation(held.owner, 'start', 'shortcut', false)).toEqual({
      owner: 'hardware',
      deliver: false,
    });
    expect(resolveNativeVoiceActivation(held.owner, 'end', 'shortcut', false)).toEqual({
      owner: 'hardware',
      deliver: false,
    });
    expect(resolveNativeVoiceActivation(held.owner, 'end', 'hardware', false)).toEqual({
      owner: null,
      deliver: true,
    });
  });

  it('does not let a blocked shortcut start drop a held hardware pairing', () => {
    const held = resolveNativeVoiceActivation(null, 'start', 'hardware', false);

    expect(resolveNativeVoiceActivation(held.owner, 'start', 'shortcut', true)).toEqual({
      owner: 'hardware',
      deliver: false,
    });
  });
});
