import { describe, expect, it } from 'vitest';

import { uniqueCustomProviderId } from './customProviderId';

describe('uniqueCustomProviderId', () => {
  it('generates a stable non-generic id for a pure Chinese name', () => {
    const first = uniqueCustomProviderId('测试网关', new Set());
    expect(first).toMatch(/^provider-[a-z0-9]+$/);
    expect(first).not.toBe('provider');
    expect(uniqueCustomProviderId('测试网关', new Set())).toBe(first);
  });

  it('keeps IDs unique when names normalize to the same slug', () => {
    const first = uniqueCustomProviderId('测试网关', new Set());
    const second = uniqueCustomProviderId('测试网关', new Set([first]));
    expect(second).toBe(`${first}-2`);
  });

  it.each([39, 40, 41, 60])('bounds a %i-character slug to the store limit', (length) => {
    expect(uniqueCustomProviderId('a'.repeat(length), new Set())).toBe(
      'a'.repeat(Math.min(length, 40)),
    );
  });

  it('preserves existing short slug behavior', () => {
    expect(uniqueCustomProviderId(' My AI Provider! ', new Set())).toBe('my-ai-provider');
    expect(uniqueCustomProviderId('My AI Provider', new Set(['my-ai-provider']))).toBe(
      'my-ai-provider-2',
    );
  });

  it('detects collisions after truncation, including different long names', () => {
    const first = uniqueCustomProviderId('a'.repeat(40) + ' first', new Set());
    const existing = new Set([first]);
    expect(uniqueCustomProviderId('a'.repeat(40) + ' second', existing)).toBe(
      'a'.repeat(38) + '-2',
    );
    expect([...existing]).toEqual([first]);
  });

  it('reserves room for one-, two- and three-digit collision suffixes', () => {
    const existing = new Set<string>();
    for (let i = 1; i <= 101; i += 1) {
      const id = uniqueCustomProviderId('a'.repeat(60), existing);
      const suffix = i === 1 ? '' : `-${i}`;
      expect(id).toBe('a'.repeat(40 - suffix.length) + suffix);
      expect(existing.has(id)).toBe(false);
      expect(id).toHaveLength(40);
      existing.add(id);
    }
  });
});
