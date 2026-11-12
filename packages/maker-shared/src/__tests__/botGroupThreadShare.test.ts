import { describe, expect, it } from 'vitest';
import { buildBotGroupThreadShareCard, botGroupThreadShareOperationId, readBotGroupThreadShareCard } from '../botGroupChat';

const reply = '10000000-0000-4000-8000-000000000001';
const root = '10000000-0000-4000-8000-000000000002';

describe('thread share card', () => {
  it('stores only the two IDs and a readable fallback for older clients', () => {
    const card = buildBotGroupThreadShareCard({ messageId: reply, threadRootId: root, authorName: ' Miao ', text: '第一行\n\n@小满  第二行' });
    expect(card).toEqual({ type: 'card', namespace: 'cindy.thread-share', schemaRevision: 1,
      fallback: '↪ Miao: 第一行 @小满 第二行', data: { messageId: reply, threadRootId: root } });
    expect(readBotGroupThreadShareCard({ threadRootId: null, content: [card] })).toEqual({ messageId: reply, threadRootId: root });
  });

  it('clips long text and keeps attachment-only shares within the server card limits', () => {
    expect(buildBotGroupThreadShareCard({ messageId: reply, threadRootId: root, authorName: 'A', text: 'x'.repeat(5000) }).fallback).toHaveLength('↪ A: '.length + 280 + 1);
    expect(buildBotGroupThreadShareCard({ messageId: reply, threadRootId: root, authorName: '', text: '' }).fallback).toBe('↪ …');
  });

  it('never splits a surrogate pair at the clip point', () => {
    const text = `${'x'.repeat(279)}😀 tail`;
    const fallback = buildBotGroupThreadShareCard({ messageId: reply, threadRootId: root, authorName: 'A', text }).fallback;
    expect(fallback).toBe(`↪ A: ${'x'.repeat(279)}…`);
    expect(fallback).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/);
  });

  it('uses one deterministic operation per reply', () => {
    expect(botGroupThreadShareOperationId(reply)).toBe(`thread-share:${reply}`);
    expect(botGroupThreadShareOperationId(reply)).toMatch(/^[a-zA-Z0-9_.:-]{8,160}$/);
  });

  it.each(['text', 'media', 'card'])('keeps a share mixed with another %s block as ordinary content in either order', type => {
    const card = buildBotGroupThreadShareCard({ messageId: reply, threadRootId: root, authorName: 'A', text: 'reply' });
    const extra = type === 'card' ? card : { type };
    for (const content of [[card, extra], [extra, card]]) {
      expect(readBotGroupThreadShareCard({ threadRootId: null, content })).toBeNull();
    }
    expect(readBotGroupThreadShareCard({ content: [] })).toBeNull();
  });

  it.each([
    ['inside a thread', { threadRootId: root }],
    ['deleted', { deleted: true, threadRootId: null }],
    ['unknown revision', { threadRootId: null, revision: 2 }],
    ['non-UUID target', { threadRootId: null, messageId: 'nope' }],
    ['self-reference', { threadRootId: null, messageId: root }],
  ])('ignores a card %s', (_label, shape: Record<string, unknown>) => {
    const { messageId = reply, revision = 1, ...message } = shape;
    expect(readBotGroupThreadShareCard({ ...message, content: [{ type: 'card', namespace: 'cindy.thread-share', schemaRevision: revision,
      data: { messageId, threadRootId: root } }] })).toBeNull();
  });
});
