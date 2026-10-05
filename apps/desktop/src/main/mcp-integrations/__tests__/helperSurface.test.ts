import { describe, expect, it } from 'vitest';
import { classifyHelperSurface } from '../helperSurface.js';

describe('classifyHelperSurface', () => {
  it.each([
    ['bot', true],
    ['bot', false],
    [null, true],
    ['user', true],
  ] as const)('treats source=%s link=%s as a Bot', (source, hasBotLink) => {
    expect(classifyHelperSurface(source, hasBotLink)).toBe('bot');
  });

  it('gives only a local, active Bot main task the full gated surface', () => {
    const main = { role: 'canonical', status: 'active', remoteHostId: null };
    expect(classifyHelperSurface('bot', true, main)).toBe('bot-main');
    for (const [source, link, patch] of [
      ['bot', true, { role: 'group' }],
      ['bot', true, { role: 'history' }],
      ['bot', true, { role: null }],
      ['bot', true, { status: 'archived' }],
      ['bot', true, { remoteHostId: 'ssh-1' }],
      ['bot', false, {}],
      ['user', true, {}],
    ] as const) {
      expect(classifyHelperSurface(source, link, { ...main, ...patch })).toBe('bot');
    }
    expect(classifyHelperSurface('user', false, main)).toBe('default');
  });

  it('leaves ordinary tasks on the default surface', () => {
    expect(classifyHelperSurface('user', false)).toBe('default');
    expect(classifyHelperSurface(null, false)).toBe('default');
    expect(classifyHelperSurface(undefined, false)).toBe('default');
  });
});
