/**
 * Regression tests for shared carousel fence parsing (Desktop + Mobile parity).
 * Value: ensures real-world ````carousel blocks with `<!-- slide -->` separators
 * and nested code fences split identically on both clients without false splits.
 */
import { describe, expect, it } from 'vitest';
import { isCarouselFenceLanguage, splitCarouselSlides } from '../markdownCarousel';

describe('isCarouselFenceLanguage', () => {
  it('matches carousel case-insensitively and ignores unrelated languages', () => {
    expect(isCarouselFenceLanguage('carousel')).toBe(true);
    expect(isCarouselFenceLanguage('  Carousel  ')).toBe(true);
    expect(isCarouselFenceLanguage('carousel title="Dark vs Light"')).toBe(true);
    expect(isCarouselFenceLanguage('carousels')).toBe(false);
    expect(isCarouselFenceLanguage('mermaid')).toBe(false);
    expect(isCarouselFenceLanguage('')).toBe(false);
    expect(isCarouselFenceLanguage(undefined)).toBe(false);
  });
});

describe('splitCarouselSlides', () => {
  it('splits image slides on standalone <!-- slide --> comments and drops empty slides', () => {
    const raw = [
      '![Dark](/tmp/01-dark.png)',
      '<!-- slide -->',
      '![Light](/tmp/01-light.png)',
      '  <!--   SLIDE  -->  ',
      '',
      '![Third](./03.png)',
    ].join('\n');

    expect(splitCarouselSlides(raw)).toEqual([
      '![Dark](/tmp/01-dark.png)',
      '![Light](/tmp/01-light.png)',
      '![Third](./03.png)',
    ]);
  });

  it('does not split on <!-- slide --> inside nested fenced code blocks', () => {
    const raw = [
      '![Preview](/tmp/preview.png)',
      '<!-- slide -->',
      '```html',
      '<!-- slide -->',
      '<div>example</div>',
      '```',
      '<!-- slide -->',
      '![After](/tmp/after.png)',
    ].join('\r\n');

    expect(splitCarouselSlides(raw)).toEqual([
      '![Preview](/tmp/preview.png)',
      '```html\n<!-- slide -->\n<div>example</div>\n```',
      '![After](/tmp/after.png)',
    ]);
  });

  it('returns empty array for blank or separator-only bodies', () => {
    expect(splitCarouselSlides('')).toEqual([]);
    expect(splitCarouselSlides('  \n<!-- slide -->\n  ')).toEqual([]);
  });
});
