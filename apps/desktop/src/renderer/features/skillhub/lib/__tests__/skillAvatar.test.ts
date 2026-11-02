import { describe, expect, it } from 'vitest';
import { resolveSkillAvatarCategory as resolve } from '../skillAvatar';

describe('skill avatar metadata', () => {
  it.each([undefined, null, '', [], 123, {}, ['unknown'], [{ name: 12 }]])('defaults for %j', tags => {
    expect(resolve({ frontmatter: { tags } })).toBeUndefined();
  });
  it('reads local category strings and tag arrays', () => {
    expect(resolve({ frontmatter: { category: ' DESIGN ' } })).toBe('creative');
    expect(resolve({ frontmatter: { tags: ['unknown', '办公'] } })).toBe('writing');
  });
  it('accepts market slugs and tag objects', () => {
    expect(resolve({ categories: ['research'] })).toBe('research');
    expect(resolve({ tags: [{ slug: 'coding', name: '编程' }] })).toBe('code');
  });
  it('prioritizes categories and is independent of tag order', () => {
    expect(resolve({ frontmatter: { categories: ['design'], tags: ['research'] } })).toBe('creative');
    expect(resolve({ tags: ['design', 'research'] })).toBe(resolve({ tags: ['research', 'design'] }));
  });
  it('falls through unknown categories without guessing from prose', () => {
    expect(resolve({ frontmatter: { category: 'other', tags: 'business' } })).toBe('business');
    expect(resolve({ frontmatter: { description: 'research', tags: 'research assistant' } })).toBeUndefined();
  });
});
