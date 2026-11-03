import { describe, expect, it, vi } from 'vitest';
import { createOthersReadOverlay, isReadByOthers, othersReadMap, parseReadReceiptFrame } from '../chatReadReceipts';

const frame = (data: unknown, extra: Record<string, unknown> = {}) => ({
  type: 'ephemeral', scope: 'actor:me', actorId: 'reader', kind: 'receipt', data: typeof data === 'string' ? data : JSON.stringify(data), ...extra });

describe('read receipts', () => {
  it('compares sequences beyond the safe integer range exactly, and thread keys without case', () => {
    const positions = othersReadMap([{ thread_key: 'main', read_seq: '9007199254740993' }, { thread_key: 'ABCDEF', read_seq: '7' }])!;
    expect(isReadByOthers('9007199254740993', null, positions)).toBe(true);
    expect(isReadByOthers('9007199254740994', null, positions)).toBe(false);
    expect(isReadByOthers('5', 'abcdef', positions)).toBe(true);
    expect(isReadByOthers('5', 'AbCdEf', positions)).toBe(true);
    expect(isReadByOthers('5', 'other', positions)).toBe(false);
  });

  it('reads the author\'s private receipt frame and ignores anything else', () => {
    expect(parseReadReceiptFrame(frame({ conversationId: 'room', threadRootId: 'ROOT', readSeq: '4' }), 'me'))
      .toEqual({ readerId: 'reader', conversationId: 'room', advances: [{ key: 'root', seq: 4n }] });
    expect(parseReadReceiptFrame(frame({ conversationId: 'room', threadRootId: null, readSeq: '12' }), 'me'))
      .toEqual({ readerId: 'reader', conversationId: 'room', advances: [{ key: 'main', seq: 12n }] });
    for (const bad of [frame('{broken'), frame({ conversationId: 'room', readSeq: 12 }), frame({ readSeq: '1' }), frame({ conversationId: 'room', threadRootId: 7, readSeq: '1' }),
      frame({ conversationId: 'room', readSeq: '1' }, { kind: 'typing' }), frame({ conversationId: 'room', readSeq: '1' }, { actorId: 7 }),
      // The old public form, and another author's private channel, are not for this client.
      frame({ conversationId: 'room', readSeq: '1' }, { scope: 'conversation:room' }), frame({ conversationId: 'room', readSeq: '1' }, { scope: 'actor:other' }), null])
      expect(parseReadReceiptFrame(bad, 'me')).toBeNull();
  });

  it('layers receipts on a snapshot, tells which own message they read, and starts over with the next snapshot', () => {
    const overlay = createOthersReadOverlay();
    const snapshot = [{ thread_key: 'main', read_seq: '5' }];
    const own = [{ seq: '3' }, { seq: '7' }, { seq: '9' }, { seq: '4', threadRootId: 'root' }];
    expect(overlay.positions('r', snapshot, own)?.get('main')).toBe(5n);
    // Nothing of mine is read up to 6, 7 is read at 8, and a second receipt reads only what is left.
    expect(overlay.advance('r', [{ key: 'main', seq: 6n }])).toBe(false);
    expect(overlay.advance('r', [{ key: 'main', seq: 8n }])).toBe(true);
    expect(overlay.advance('r', [{ key: 'main', seq: 8n }])).toBe(false);
    expect(overlay.advance('r', [{ key: 'root', seq: 4n }])).toBe(true);
    expect(overlay.positions('r', snapshot, own)?.get('main')).toBe(8n);
    // A new snapshot is the truth again: a member who left lowers the maximum.
    expect(overlay.positions('r', [{ thread_key: 'main', read_seq: '2' }], own)?.get('main')).toBe(2n);
    // A server without receipts has no positions, and an unknown room has nothing to advance.
    expect(overlay.positions('r', undefined, own)).toBeNull();
    expect(overlay.advance('r', [{ key: 'main', seq: 99n }])).toBe(false);
  });

  it('calls a room stale only while my messages are unread in a snapshot that has grown old', () => {
    vi.useFakeTimers();
    try {
      const overlay = createOthersReadOverlay();
      const snapshot = [{ thread_key: 'main', read_seq: '5' }];
      expect(overlay.stale('r', 30_000)).toBe(false);
      overlay.positions('r', snapshot, [{ seq: '7' }]);
      vi.advanceTimersByTime(29_000);
      expect(overlay.stale('r', 30_000)).toBe(false);
      vi.advanceTimersByTime(2_000);
      expect(overlay.stale('r', 30_000)).toBe(true);
      // Everything read, or a newer snapshot, ends it.
      overlay.advance('r', [{ key: 'main', seq: 7n }]);
      expect(overlay.stale('r', 30_000)).toBe(false);
      overlay.positions('r', [{ thread_key: 'main', read_seq: '5' }], [{ seq: '7' }]);
      expect(overlay.stale('r', 30_000)).toBe(false);
    } finally { vi.useRealTimers(); }
  });

  it('keeps what an earlier read of the room loaded when another read of it comes after', () => {
    const overlay = createOthersReadOverlay();
    const snapshot = [{ thread_key: 'main', read_seq: '5' }];
    // The Thread panel loads its replies, then the main timeline reads the same snapshot with only its own messages.
    overlay.positions('r', snapshot, [{ seq: '4', threadRootId: 'Root' }]);
    overlay.positions('r', snapshot, [{ seq: '9' }]);
    expect(overlay.advance('r', [{ key: 'root', seq: 4n }])).toBe(true);
    expect(overlay.advance('r', [{ key: 'main', seq: 9n }])).toBe(true);
    // A new snapshot starts the list over: nothing earlier is remembered.
    overlay.positions('r', [{ thread_key: 'main', read_seq: '5' }], [{ seq: '9' }]);
    expect(overlay.advance('r', [{ key: 'root', seq: 4n }])).toBe(false);
  });
});
