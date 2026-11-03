import { describe, expect, it } from 'vitest';
import type { BotGroupMessageView } from '../botGroupChat';
import {
  BOT_GROUP_QUOTE_EXCERPT_MAX,
  botGroupQuoteFromMessage,
  buildBotGroupQuoteCard,
  isBotGroupMessageQuotable,
  parseBotGroupQuoteView,
  readBotGroupQuote,
  readBotGroupQuoteCard,
  resolveBotGroupQuote,
  type BotGroupQuoteView,
} from '../botGroupQuote';

const ORIGINAL = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

function message(overrides: Partial<BotGroupMessageView> = {}): BotGroupMessageView {
  return {
    id: ORIGINAL, sequence: 12, kind: 'message', authorKind: 'bot', authorBotId: 'bot-1', authorName: 'Cindy (Chris)',
    content: '第一行\n\n  第二行 ', mentions: { all: false, botIds: [] }, noticeCode: null, planId: null, files: [],
    attachments: [], createdAt: 1, threadRootId: null, ...overrides,
  };
}

const quote = (overrides: Partial<BotGroupQuoteView> = {}): BotGroupQuoteView => ({
  messageId: ORIGINAL, authorName: 'Cindy (Chris)', authorKind: 'bot', excerpt: '第一行 第二行',
  attachmentCount: 0, attachmentName: null, sequence: 12, ...overrides,
});

describe('botGroupQuoteFromMessage', () => {
  it('snapshots author, collapsed text, attachments and server order', () => {
    expect(botGroupQuoteFromMessage(message({
      attachments: [{ id: 'a', name: 'plan.pdf', category: 'pdf', mimeType: 'application/pdf', size: 1, url: null, path: null },
        { id: 'b', name: 'b.png', category: 'image', mimeType: 'image/png', size: 1, url: null, path: null }],
    }))).toEqual(quote({ attachmentCount: 2, attachmentName: 'plan.pdf' }));
  });

  it('names the first attachment that has a name, including a not-yet-downloaded placeholder', () => {
    const placeholder = (name: string) => ({ id: name || 'x', name, category: 'file' as const, mimeType: '', size: 0, url: null, path: null, state: 'loading' as const });
    expect(botGroupQuoteFromMessage(message({ content: '', attachments: [placeholder(''), placeholder('itinerary.pdf')] })))
      .toMatchObject({ excerpt: '', attachmentCount: 2, attachmentName: 'itinerary.pdf' });
    expect(resolveBotGroupQuote(quote(), [message({ content: '', attachments: [placeholder('')] })]))
      .toMatchObject({ state: 'live', attachmentCount: 1, attachmentName: '…' });
  });

  it('bounds a long body to one short excerpt', () => {
    const snapshot = botGroupQuoteFromMessage(message({ content: '字'.repeat(1000) }));
    expect(Array.from(snapshot.excerpt)).toHaveLength(BOT_GROUP_QUOTE_EXCERPT_MAX);
    expect(snapshot.excerpt.endsWith('…')).toBe(true);
  });

  it('quotes a human message as a user author', () => {
    expect(botGroupQuoteFromMessage(message({ authorKind: 'user', authorName: 'Dash' })).authorKind).toBe('user');
  });
});

describe('isBotGroupMessageQuotable', () => {
  it('allows live main-timeline chat messages only', () => {
    expect(isBotGroupMessageQuotable(message())).toBe(true);
    expect(isBotGroupMessageQuotable(message({ deleted: true }))).toBe(false);
    expect(isBotGroupMessageQuotable(message({ threadRootId: OTHER }))).toBe(false);
    expect(isBotGroupMessageQuotable(message({ kind: 'notice', authorKind: 'system' }))).toBe(false);
    expect(isBotGroupMessageQuotable(message({ kind: 'plan' }))).toBe(false);
    // A thread share's own text is only its card's fallback.
    expect(isBotGroupMessageQuotable(message({ threadShare: { messageId: OTHER, threadRootId: OTHER, status: 'available', authorKind: 'bot',
      authorBotId: 'b', authorName: 'Bot', sharedByAuthor: false, content: 'reply', attachments: [], createdAt: 1, edited: false } }))).toBe(false);
  });
});

describe('quote card', () => {
  it('round-trips through the server content block', () => {
    const card = buildBotGroupQuoteCard(quote({ attachmentCount: 3, attachmentName: 'a.pdf' }));
    expect(card).toMatchObject({ type: 'card', namespace: 'cindy.quote', schemaRevision: 1 });
    expect(card.fallback).toBe('> Cindy (Chris): 第一行 第二行 📎 a.pdf +2');
    expect(readBotGroupQuoteCard(JSON.parse(JSON.stringify(card)))).toEqual(quote({ attachmentCount: 3, attachmentName: 'a.pdf' }));
  });

  it('keeps a readable fallback for an attachment-only original', () => {
    expect(buildBotGroupQuoteCard(quote({ excerpt: '', attachmentCount: 1, attachmentName: 'shot.png' })).fallback)
      .toBe('> Cindy (Chris): 📎 shot.png');
  });

  it('is not a quote when the revision or any field is wrong', () => {
    const card = buildBotGroupQuoteCard(quote());
    expect(readBotGroupQuoteCard({ ...card, schemaRevision: 2 })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, namespace: 'cindy.plan' })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, messageId: '../other' } })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, authorKind: 'system' } })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, authorName: ' ' } })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, excerpt: 'x'.repeat(5000) } })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, attachmentCount: 2 } })).toBeNull();
    expect(readBotGroupQuoteCard({ ...card, data: { ...card.data, seq: '1e9' } })).toBeNull();
    expect(readBotGroupQuoteCard({ type: 'text', text: card.fallback })).toBeNull();
    expect(readBotGroupQuoteCard(null)).toBeNull();
  });

  it('reads the first valid quote among the message blocks', () => {
    const card = buildBotGroupQuoteCard(quote());
    expect(readBotGroupQuote([{ type: 'text', text: 'hi' }, { ...card, schemaRevision: 9 }, card])).toEqual(quote());
    expect(readBotGroupQuote([{ type: 'text', text: 'hi' }])).toBeNull();
  });
});

describe('parseBotGroupQuoteView', () => {
  it('accepts the projected view and applies the card field rules', () => {
    expect(parseBotGroupQuoteView(quote())).toEqual(quote());
    expect(parseBotGroupQuoteView({ ...quote(), sequence: null })).toEqual(quote({ sequence: null }));
    expect(parseBotGroupQuoteView({ ...quote(), originalDeleted: true })).toEqual(quote({ originalDeleted: true }));
    expect(parseBotGroupQuoteView({ ...quote(), originalDeleted: 'yes' })).toEqual(quote());
    expect(parseBotGroupQuoteView({ ...quote(), sequence: 0 })).toBeNull();
    expect(parseBotGroupQuoteView({ ...quote(), sequence: '2' })).toBeNull();
    expect(parseBotGroupQuoteView({ ...quote(), messageId: 'x' })).toBeNull();
    expect(parseBotGroupQuoteView({ ...quote(), attachmentCount: 1 })).toBeNull();
    expect(parseBotGroupQuoteView(null)).toBeNull();
    expect(parseBotGroupQuoteView([quote()])).toBeNull();
  });
});

describe('resolveBotGroupQuote', () => {
  it('prefers the loaded original over the snapshot', () => {
    expect(resolveBotGroupQuote(quote({ excerpt: 'old' }), [message({ content: 'edited', authorName: 'Cindy' })]))
      .toEqual({ state: 'live', authorName: 'Cindy', excerpt: 'edited', attachmentCount: 0, attachmentName: null });
  });

  it('hides the snapshot once the loaded original is deleted', () => {
    expect(resolveBotGroupQuote(quote(), [message({ deleted: true, content: '（消息已删除）' })]))
      .toEqual({ state: 'deleted', authorName: 'Cindy (Chris)' });
    expect(resolveBotGroupQuote(quote({ originalDeleted: true }), [])).toEqual({ state: 'deleted', authorName: 'Cindy (Chris)' });
  });

  it('falls back to the snapshot when the original is not loaded', () => {
    expect(resolveBotGroupQuote(quote(), [message({ id: OTHER })])).toMatchObject({ state: 'snapshot', excerpt: '第一行 第二行' });
  });

  it('keeps the snapshot attachment summary while a loaded original has no attachments yet', () => {
    expect(resolveBotGroupQuote(quote({ excerpt: '', attachmentCount: 2, attachmentName: 'plan.pdf' }), [message({ content: '' })]))
      .toEqual({ state: 'live', authorName: 'Cindy (Chris)', excerpt: '', attachmentCount: 2, attachmentName: 'plan.pdf' });
  });

  it('never resolves into a Thread reply with the same id', () => {
    expect(resolveBotGroupQuote(quote(), [message({ threadRootId: OTHER, content: 'thread' })]).state).toBe('snapshot');
  });
});
