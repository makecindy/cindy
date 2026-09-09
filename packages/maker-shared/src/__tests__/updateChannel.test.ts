import { describe, expect, it } from 'vitest';

import { resolveUpdateChannel } from '../updateChannel.js';

describe('resolveUpdateChannel', () => {
  it('canary 优先于 beta 与 release', () => {
    expect(resolveUpdateChannel(true, true)).toBe('canary');
    expect(resolveUpdateChannel(true, false)).toBe('canary');
  });

  it('canary 不生效时才看 beta', () => {
    expect(resolveUpdateChannel(false, true)).toBe('beta');
  });

  it('两者都不生效走 release', () => {
    expect(resolveUpdateChannel(false, false)).toBe('release');
  });
});
