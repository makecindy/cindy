import { describe, it, expect } from 'vitest';
import { markdownToDiscord } from '../markdown.js';

describe('stripHtmlTags edge cases', () => {
  it('O(n) on repeated unterminated tags', () => {
    const N = 10000;
    const start = Date.now();
    markdownToDiscord('<A\t'.repeat(N));
    expect(Date.now() - start).toBeLessThan(500);
  });

  it('preserves <owner/repo> angle-bracket placeholders', () => {
    const { text } = markdownToDiscord('Clone <owner/repo> now');
    expect(text).toContain('<owner/repo>');
  });

  it('strips self-closing <br/>', () => {
    const { text } = markdownToDiscord('line<br/>break');
    expect(text).toBe('linebreak');
  });

  it('strips tags with attributes', () => {
    const { text } = markdownToDiscord('<div class="x">hello</div>');
    expect(text).toBe('hello');
  });

  it('preserves autolinks', () => {
    const { text } = markdownToDiscord('See <https://example.com>');
    expect(text).toBe('See <https://example.com>');
  });

  it('strips nested fragments without reassembly', () => {
    const { text } = markdownToDiscord('<scr<x>ipt>alert(1)</scr<x>ipt>');
    expect(text.toLowerCase()).not.toContain('<script');
  });

  it('preserves text after unterminated tag-like fragment', () => {
    const { text } = markdownToDiscord('Use <Component props');
    expect(text).toContain('Component');
    expect(text).toContain('props');
  });
});
