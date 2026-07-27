import { describe, expect, it } from 'vitest';

import { markdownToDiscord } from '../markdown.js';

describe('markdownToDiscord', () => {
  it('passes through Discord-native markdown', () => {
    const md = [
      '# Heading',
      '**bold** and *italic* and `code`',
      '> quote',
      '- unordered',
      '1. ordered',
      '[docs](https://example.com/docs)',
      '```ts',
      '<keep>inside fence</keep>',
      '```',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({ text: md, imageUrls: [] });
  });

  it('wraps markdown tables in a code fence', () => {
    const md = ['before', '', '| A | B |', '| --- | --- |', '| 1 | 2 |', '', 'after'].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['before', '', '```', '| A | B |', '| --- | --- |', '| 1 | 2 |', '```', '', 'after'].join('\n'),
      imageUrls: [],
    });
  });

  it('strips HTML outside code fences only', () => {
    const md = ['<p>Hello <strong>world</strong></p>', '```html', '<p>kept</p>', '```'].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['Hello world', '```html', '<p>kept</p>', '```'].join('\n'),
      imageUrls: [],
    });
  });

  it('keeps Discord autolinks while stripping HTML tags', () => {
    expect(markdownToDiscord('See <https://example.com>')).toEqual({
      text: 'See <https://example.com>',
      imageUrls: [],
    });
  });

  it('strips simple tags and self-closing tags', () => {
    expect(markdownToDiscord('<b>x</b><br/>y')).toEqual({
      text: 'xy',
      imageUrls: [],
    });
  });

  it('extracts xdt-image lines and keeps http image markdown', () => {
    const md = [
      'before',
      '![local](xdt-image://abc123)',
      '![remote](https://example.com/image.png)',
      'after ![local2](xdt-image://def456)',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: ['before', '![remote](https://example.com/image.png)', 'after'].join('\n'),
      imageUrls: ['xdt-image://abc123', 'xdt-image://def456'],
    });
  });

  it('keeps text around inline xdt-image tokens', () => {
    expect(markdownToDiscord('Here is the plot ![plot](xdt-image://plot-1) for today')).toEqual({
      text: 'Here is the plot for today',
      imageUrls: ['xdt-image://plot-1'],
    });
  });

  it('removes image-only xdt-image lines', () => {
    expect(markdownToDiscord(['before', '  ![plot](xdt-image://plot-1)  ', 'after'].join('\n'))).toEqual({
      text: ['before', 'after'].join('\n'),
      imageUrls: ['xdt-image://plot-1'],
    });
  });

  it('extracts multiple xdt-image tokens on one line while keeping remaining text', () => {
    expect(
      markdownToDiscord(
        'Images: ![first](xdt-image://first) and ![second](xdt-image://second) are attached',
      ),
    ).toEqual({
      text: 'Images: and are attached',
      imageUrls: ['xdt-image://first', 'xdt-image://second'],
    });
  });

  it('handles a mixed document', () => {
    const md = [
      '## Report',
      '<div>summary</div>',
      '',
      '| File | Status |',
      '| --- | --- |',
      '| a.ts | ok |',
      '',
      '![diagram](xdt-image://diagram-1)',
      '[open](https://example.com)',
      '```html',
      '<span>not stripped</span>',
      '```',
    ].join('\n');

    expect(markdownToDiscord(md)).toEqual({
      text: [
        '## Report',
        'summary',
        '',
        '```',
        '| File | Status |',
        '| --- | --- |',
        '| a.ts | ok |',
        '```',
        '',
        '[open](https://example.com)',
        '```html',
        '<span>not stripped</span>',
        '```',
      ].join('\n'),
      imageUrls: ['xdt-image://diagram-1'],
    });
  });

  // 2026-07 安全整改回归:图片提取与 HTML 剥除从正则改为线性扫描/循环剥除
  // (CodeQL js/polynomial-redos / js/incomplete-multi-character-sanitization),
  // 钉住新实现的行为与性能边界。
  describe('sanitizer hardening regressions', () => {
    it('non-xdt image markdown and unclosed constructs pass through untouched', () => {
      expect(markdownToDiscord('![pic](https://a/b.png) ![x [y](xdt-image://')).toEqual({
        text: '![pic](https://a/b.png) ![x [y](xdt-image://',
        imageUrls: [],
      });
      // '://' 后紧跟 ')' 不算图片引用
      expect(markdownToDiscord('a ![e](xdt-image://) b')).toEqual({
        text: 'a ![e](xdt-image://) b',
        imageUrls: [],
      });
    });

    it('nested tag fragments cannot reassemble into <script>', () => {
      const { text } = markdownToDiscord('<scr<x>ipt>alert(1)</scr<x>ipt>');
      expect(text.toLowerCase()).not.toContain('<script');
    });

    it('adversarial long inputs finish fast (no catastrophic backtracking)', () => {
      const start = Date.now();
      markdownToDiscord('![['.repeat(20_000));
      markdownToDiscord('![](xdt-image://'.repeat(10_000));
      markdownToDiscord('<A\t'.repeat(20_000));
      expect(Date.now() - start).toBeLessThan(2_000);
    });
  });
});
