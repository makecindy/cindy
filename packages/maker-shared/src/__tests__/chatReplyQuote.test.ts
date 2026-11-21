import { describe, expect, it } from 'vitest';
import { chatReplyQuoteExcerpt, readChatReplyQuote } from '../chatReplyQuote';

describe('chatReplyQuoteExcerpt', () => {
  it.each([
    ['an emoji crossing the cut', `${'a'.repeat(278)}😀x`, `${'a'.repeat(278)}…`],
    ['an emoji ending at the cut', `${'a'.repeat(277)}😀xy`, `${'a'.repeat(277)}😀…`],
    ['plain text beyond the limit', 'a'.repeat(281), `${'a'.repeat(279)}…`],
    ['an emoji exactly at the limit', `${'a'.repeat(278)}😀`, `${'a'.repeat(278)}😀`],
  ])('preserves complete characters for %s', (_name, input, expected) => {
    expect(chatReplyQuoteExcerpt(input)).toBe(expected);
  });
});

describe('readChatReplyQuote', () => {
  it('keeps a received quote readable when its excerpt crosses an emoji boundary', () => {
    expect(readChatReplyQuote({
      clientId: 'original-message',
      role: 'assistant',
      excerpt: `${'a'.repeat(278)}😀x`,
    })).toEqual({
      clientId: 'original-message',
      role: 'assistant',
      excerpt: `${'a'.repeat(278)}…`,
    });
  });
});
