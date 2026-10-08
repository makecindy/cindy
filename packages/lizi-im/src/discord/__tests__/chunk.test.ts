import { describe, expect, it } from 'vitest';

import { chunkDiscordText, MAX_MESSAGE_LEN, SPLIT_THRESHOLD } from '../chunk.js';

describe('chunkDiscordText', () => {
  it('exports Discord message size constants', () => {
    expect(MAX_MESSAGE_LEN).toBe(2000);
    expect(SPLIT_THRESHOLD).toBe(1900);
  });

  it('keeps text within the limit as a single chunk', () => {
    expect(chunkDiscordText('short text')).toEqual(['short text']);
  });

  it('prefers paragraph boundaries for long text', () => {
    const first = 'A'.repeat(30);
    const second = 'B'.repeat(30);
    const third = 'C'.repeat(30);
    const chunks = chunkDiscordText([first, '', second, '', third].join('\n'), 70);

    expect(chunks).toEqual([[first, '', second, '', ''].join('\n'), third]);
    expect(chunks.every((chunk) => chunk.length <= 70)).toBe(true);
  });

  it('closes and reopens code fences when splitting inside a code block', () => {
    const text = ['```ts', 'x'.repeat(3000), '```'].join('\n');
    const chunks = chunkDiscordText(text);

    expect(chunks).toHaveLength(2);
    expect(chunks.every((chunk) => chunk.length <= MAX_MESSAGE_LEN)).toBe(true);
    expect(chunks[0].startsWith('```ts\n')).toBe(true);
    expect(chunks[0].endsWith('\n```')).toBe(true);
    expect(chunks[1].startsWith('```ts\n')).toBe(true);
    expect(chunks[1].endsWith('\n```')).toBe(true);
  });

  it('hard-splits a single line over the limit', () => {
    const chunks = chunkDiscordText('x'.repeat(25), 10);

    expect(chunks).toEqual(['x'.repeat(10), 'x'.repeat(10), 'x'.repeat(5)]);
    expect(chunks.every((chunk) => chunk.length <= 10)).toBe(true);
  });

  it('keeps words and emoji intact when a long line must be split', () => {
    const words = 'bottomPadding value '.repeat(20);
    const chunks = chunkDiscordText(words, 30);
    expect(chunks.join('')).toBe(words);
    expect(chunks.slice(0, -1).every((chunk) => /\s$/.test(chunk))).toBe(true);
    const emoji = chunkDiscordText('🙂'.repeat(30), 11);
    expect(emoji.join('')).toBe('🙂'.repeat(30));
    expect(
      emoji.every(
        (chunk) => chunk.length <= 11 && !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(chunk),
      ),
    ).toBe(true);
  });
});
