import { describe, expect, it } from 'vitest';
import { createOfflinePushQueue } from '../offlinePushQueue';

describe('offline push queue', () => {
  it('coalesces only state channels and preserves event order', () => {
    let now = 1_000;
    const queue = createOfflinePushQueue({ now: () => now });

    queue.enqueue('dev-1', {
      channel: 'maker:status-changed',
      topic: 'session:s1',
      payload: { sessionId: 's1', phase: 'running' },
    });
    now += 1;
    queue.enqueue('dev-1', {
      channel: 'local-db:messages:created',
      topic: 'session:s1',
      payload: { sessionId: 's1', id: 'm1' },
    });
    now += 1;
    queue.enqueue('dev-1', {
      channel: 'local-db:messages:created',
      topic: 'session:s1',
      payload: { sessionId: 's1', id: 'm2' },
    });
    now += 1;
    queue.enqueue('dev-1', {
      channel: 'usage:message-turn-cost',
      topic: 'session:s1',
      payload: { sessionId: 's1', messageId: 'm1', costUsd: 1 },
    });
    now += 1;
    queue.enqueue('dev-1', {
      channel: 'usage:message-turn-cost',
      topic: 'session:s1',
      payload: { sessionId: 's1', messageId: 'm2', costUsd: 2 },
    });
    now += 1;
    queue.enqueue('dev-1', {
      channel: 'maker:status-changed',
      topic: 'session:s1',
      payload: { sessionId: 's1', phase: 'completed' },
    });

    expect(queue.drain('dev-1')).toEqual([
      {
        channel: 'local-db:messages:created',
        topic: 'session:s1',
        payload: { sessionId: 's1', id: 'm1' },
      },
      {
        channel: 'local-db:messages:created',
        topic: 'session:s1',
        payload: { sessionId: 's1', id: 'm2' },
      },
      {
        channel: 'usage:message-turn-cost',
        topic: 'session:s1',
        payload: { sessionId: 's1', messageId: 'm1', costUsd: 1 },
      },
      {
        channel: 'usage:message-turn-cost',
        topic: 'session:s1',
        payload: { sessionId: 's1', messageId: 'm2', costUsd: 2 },
      },
      {
        channel: 'maker:status-changed',
        topic: 'session:s1',
        payload: { sessionId: 's1', phase: 'completed' },
      },
    ]);
  });

  it('drains only the requested topics and retains the rest', () => {
    const queue = createOfflinePushQueue();
    queue.enqueue('dev-1', { channel: 'a', topic: 'sessions', payload: { value: 1 } });
    queue.enqueue('dev-1', { channel: 'b', topic: 'session:s1', payload: { value: 2 } });

    expect(queue.drain('dev-1', ['sessions'])).toEqual([
      { channel: 'a', topic: 'sessions', payload: { value: 1 } },
    ]);
    expect(queue.drain('dev-1')).toEqual([
      { channel: 'b', topic: 'session:s1', payload: { value: 2 } },
    ]);
  });

  it('bounds queue length and bytes by evicting the oldest items', () => {
    const queue = createOfflinePushQueue({
      maxItems: 2,
      maxBytes: 20,
      estimateBytes: (item) => String((item.payload as { text: string }).text).length,
    });

    queue.enqueue('dev-1', { channel: 'a', topic: 'sessions', payload: { text: '11111111' } });
    queue.enqueue('dev-1', { channel: 'b', topic: 'sessions', payload: { text: '22222222' } });
    queue.enqueue('dev-1', { channel: 'c', topic: 'sessions', payload: { text: '33333333' } });

    expect(queue.drain('dev-1').map((item) => item.channel)).toEqual(['b', 'c']);
  });

  it('expires items and isolates devices', () => {
    let now = 1_000;
    const queue = createOfflinePushQueue({ now: () => now, ttlMs: 100 });
    queue.enqueue('dev-1', { channel: 'a', topic: 'sessions', payload: { value: 1 } });
    queue.enqueue('dev-2', { channel: 'b', topic: 'sessions', payload: { value: 2 } });

    now += 101;
    expect(queue.drain('dev-1')).toEqual([]);
    expect(queue.drain('dev-2')).toEqual([]);
  });

  it('drops single entries that exceed the byte budget', () => {
    const queue = createOfflinePushQueue({ maxBytes: 4, estimateBytes: () => 5 });
    queue.enqueue('dev-1', { channel: 'big', topic: 'sessions', payload: { value: 1 } });
    expect(queue.size('dev-1')).toBe(0);
  });
});
