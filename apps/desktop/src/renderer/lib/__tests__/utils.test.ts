import { describe, expect, it } from 'vitest';

import { cn } from '@/lib/utils';

describe('cn', () => {
  it('keeps custom numeric font-size utilities alongside arbitrary color utilities', () => {
    const result = cn('text-15', 'text-[var(--msg-assistant-text)]');

    expect(result).toContain('text-15');
    expect(result).toContain('text-[var(--msg-assistant-text)]');
  });

  it('still resolves conflicts for custom font sizes, default font sizes, and colors', () => {
    expect(cn('text-14', 'text-16')).toBe('text-16');
    expect(cn('text-15', 'text-[var(--msg-assistant-text)]')).toBe(
      'text-15 text-[var(--msg-assistant-text)]',
    );
    expect(cn('text-red-500', 'text-blue-500')).toBe('text-blue-500');
    expect(cn('text-sm', 'text-lg')).toBe('text-lg');
  });

  it('treats every DESIGN.md numeric font-size token as one merge group', () => {
    const sizes = [10, 11, 12, 13, 14, 15, 16, 18, 20, 24, 28];
    for (const size of sizes.slice(1)) {
      expect(cn('text-10', `text-${size}`)).toBe(`text-${size}`);
    }
  });
});
