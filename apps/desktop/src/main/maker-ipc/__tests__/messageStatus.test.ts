import { describe, expect, it } from 'vitest';

import {
  classifySessionMessageStatus,
  type MessageStatusQueueEntry,
} from '../messageStatus';

const queueEntry: MessageStatusQueueEntry = {
  queuedMessageId: 'q-1',
  position: 1,
  source: 'session',
  sourceLabel: 'sender-session',
  enqueuedAtMs: Date.parse('2026-08-16T01:02:03.000Z'),
  consuming: false,
};

describe('classifySessionMessageStatus', () => {
  it('returns queued with position while the message waits in the queue', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry,
        isActiveTurnInput: false,
        persisted: null,
        firstReply: null,
      }),
    ).toMatchObject({
      status: 'queued',
      position: 1,
      source: 'session',
      source_label: 'sender-session',
      enqueued_at: '2026-08-16T01:02:03.000Z',
    });
  });

  it('returns processing while the queued entry is being consumed', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry: { ...queueEntry, consuming: true },
        isActiveTurnInput: false,
        persisted: null,
        firstReply: null,
      }),
    ).toMatchObject({ status: 'processing', position: 1 });
  });

  it('returns null when the message is unknown to every channel', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry: null,
        isActiveTurnInput: false,
        persisted: null,
        firstReply: null,
      }),
    ).toBeNull();
  });

  it('returns dispatched once the user row exists without a reply or active turn', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry: null,
        isActiveTurnInput: false,
        persisted: { role: 'user', createdAt: 100, rewindAt: null, cleared: false },
        firstReply: null,
      }),
    ).toMatchObject({ status: 'dispatched' });
  });

  it('returns processing when the message is an active turn input', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry: null,
        isActiveTurnInput: true,
        persisted: { role: 'user', createdAt: 100, rewindAt: null, cleared: false },
        firstReply: null,
      }),
    ).toMatchObject({ status: 'processing' });
  });

  it('returns consumed once a later assistant reply exists', () => {
    expect(
      classifySessionMessageStatus({
        queueEntry: null,
        isActiveTurnInput: false,
        persisted: { role: 'user', createdAt: 100, rewindAt: null, cleared: false },
        firstReply: { role: 'assistant', createdAt: 200, content: 'done' },
      }),
    ).toMatchObject({ status: 'consumed', consumed_at: new Date(200).toISOString() });
  });

  it('returns failed with the error summary when the first reply is an error row', () => {
    const snapshot = classifySessionMessageStatus({
      queueEntry: null,
      isActiveTurnInput: false,
      persisted: { role: 'user', createdAt: 100, rewindAt: null, cleared: false },
      firstReply: {
        role: 'error',
        createdAt: 200,
        content: JSON.stringify({ message: 'provider timeout' }),
      },
    });
    expect(snapshot).toMatchObject({ status: 'failed' });
    expect(snapshot?.detail).toContain('provider timeout');
  });

  it('returns failed when the persisted row was rewound or cleared', () => {
    for (const persisted of [
      { role: 'user', createdAt: 100, rewindAt: 150, cleared: false },
      { role: 'user', createdAt: 100, rewindAt: null, cleared: true },
    ]) {
      expect(
        classifySessionMessageStatus({
          queueEntry: null,
          isActiveTurnInput: false,
          persisted,
          firstReply: null,
        }),
      ).toMatchObject({ status: 'failed' });
    }
  });
});
