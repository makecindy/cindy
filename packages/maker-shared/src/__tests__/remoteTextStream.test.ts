import { describe, expect, it } from 'vitest';
import { consumeRemoteSessionSync, isRemoteTextDelta, readRemoteTextSnapshot, reconcileRemoteText } from '../remoteTextStream.js';

describe('remote text recovery contract', () => {
  it('replaces a missing prefix idempotently before appending newer deltas', () => {
    let text = '';
    for (const [incoming, snapshot] of [[' suffix', false], ['prefix suffix', true], ['prefix suffix', true], [' tail', false]] as const) {
      text = reconcileRemoteText(text, incoming, { snapshot, durable: false });
    }
    expect(text).toBe('prefix suffix tail');
    expect(reconcileRemoteText('persisted', 'old', { snapshot: true, durable: true })).toBe('persisted');
    expect(reconcileRemoteText(text, 'cut', { snapshot: true, durable: false, truncated: true })).toBe(text);
  });
  it('does not batch a repair or treat legacy final text as an in-flight repair', () => {
    const event = { type: 'text', data: { text: 'whole', isFinal: false, isFullText: true, createdAt: '2026-09-08T00:00:00Z' } };
    expect(isRemoteTextDelta(event)).toBe(false);
    expect(readRemoteTextSnapshot(event)?.createdAt).toBe('2026-09-08T00:00:00.000Z');
    expect(isRemoteTextDelta({ ...event, data: { text: 'delta', isFinal: false } })).toBe(true);
    expect(readRemoteTextSnapshot({ ...event, data: { ...event.data, isFinal: true } })).toBeUndefined();
    expect(readRemoteTextSnapshot({ ...event, __deviceLinkTruncated: true })?.truncated).toBe(true);
  });
  it('applies the event before optional history invalidation, ignoring malformed envelopes', () => {
    const order: string[] = [];
    const adapter = { applyEvent: () => { order.push('text'); }, invalidateHistory: (id: string) => { order.push(id); } };
    const payload = { sessionId: 's', persistId: 'p', event: { type: 'text', data: { text: 'whole', isFinal: false, isFullText: true } } };
    consumeRemoteSessionSync({ ...payload, resyncRequired: true }, adapter);
    expect(order).toEqual(['text', 's']);
    consumeRemoteSessionSync({ ...payload, resyncRequired: false }, adapter);
    consumeRemoteSessionSync({ event: {}, resyncRequired: true }, adapter);
    expect(order).toEqual(['text', 's', 'text']);
    consumeRemoteSessionSync({ sessionId: 's', event: { type: 'text' }, resyncRequired: true }, adapter);
    expect(order).toEqual(['text', 's', 'text', 's']);
  });
});
