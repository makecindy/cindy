import { describe, expect, it } from 'vitest';
import { botReplyQuoteDisplay, botReplyQuoteFor } from '../botDmQuote';
import { formatForwardedRequest } from '../../../../shared/forwardedRequest';

// Unit: reply previews/live originals re-exposed serialized paragraph escapes.
// These production quote entry points had no forwarded-message coverage.
describe('forwarded companion reply quotes', () => {
  const content = formatForwardedRequest({ userText: '只检查' }, '第一段\n\n第二段，保留 `\\n`', 'zh-CN');
  const message = { clientId: 'forwarded', role: 'user' as const, content,
    automationOrigin: { kind: 'session' as const, senderSessionId: 'sender' } };
  const names = { owner: 'Chris', companion: 'Cindy' };

  it('uses readable text for the pending snapshot, live original and unloaded fallback', () => {
    const quote = botReplyQuoteFor(message)!;
    expect(quote.excerpt).toContain('第一段 第二段，保留 `\\n`');
    expect(quote.excerpt).not.toContain('第一段\\n\\n');
    expect(botReplyQuoteDisplay({ ...quote, excerpt: 'old escaped snapshot' }, message, names)).toMatchObject({ state: 'live', excerpt: quote.excerpt });
    expect(botReplyQuoteDisplay(quote, undefined, names)).toMatchObject({ state: 'snapshot', excerpt: quote.excerpt });
    expect(message.content).toBe(content);
  });

  it('preserves the same intentional JSON example from a human', () => {
    const human = { ...message, automationOrigin: undefined };
    const quote = botReplyQuoteFor(human)!;
    expect(quote.excerpt).toBe(content.replace(/\s+/g, ' '));
    expect(botReplyQuoteDisplay(quote, human, names)).toMatchObject({ state: 'live', excerpt: quote.excerpt });
  });
});

describe('IM companion reply quotes', () => {
  const names = { owner: 'Chris', companion: 'Cindy' };
  const content = '<p>原文 &amp; 记录<br>第二行</p>';
  it.each(['feishu', 'lark'])('uses %s display text for live and newly saved quotes', (im) => {
    const message = { clientId: 'im', role: 'user' as const, content, hookSource: { im, userText: content } };
    const quote = botReplyQuoteFor(message)!;
    expect(quote.excerpt).toBe('原文 & 记录 第二行');
    expect(botReplyQuoteDisplay({ ...quote, excerpt: content }, message, names)).toMatchObject({ state: 'live', excerpt: quote.excerpt });
    expect(botReplyQuoteDisplay(quote, undefined, names)).toMatchObject({ state: 'snapshot', excerpt: quote.excerpt });
    expect(message.hookSource.userText).toBe(content);
    expect(message.content).toBe(content);
  });

  it('preserves other channels and older snapshots whose source is unloaded', () => {
    const message = { clientId: 'im', role: 'user' as const, content, hookSource: { im: 'slack', userText: content } };
    const quote = botReplyQuoteFor(message)!;
    expect(quote.excerpt).toBe(content);
    expect(botReplyQuoteDisplay(quote, undefined, names)).toMatchObject({ state: 'snapshot', excerpt: content });
  });
});
