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

  it('leaves ordinary tasks on the default surface', () => {
    expect(classifyHelperSurface('user', false)).toBe('default');
    expect(classifyHelperSurface(null, false)).toBe('default');
    expect(classifyHelperSurface(undefined, false)).toBe('default');
  });
});
