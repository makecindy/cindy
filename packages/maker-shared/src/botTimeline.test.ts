import { describe, expect, it } from 'vitest';
import { botGroupWorkAnchors } from './botTimeline';

describe('live group work in message order', () => {
  const messages = [{ id: 'first', createdAt: 10 }, { id: 'later', createdAt: 30 }];
  it('keeps earlier work ahead of a later user message and another request', () => {
    const early = { executionId: 'a', requestedAt: 20, startedAt: 50 };
    const late = { executionId: 'b', requestedAt: 40 };
    const anchors = botGroupWorkAnchors(messages, [late, early]);
    expect([...anchors]).toEqual([['first', [early]], ['later', [late]]]);
    expect(botGroupWorkAnchors([...messages, { id: 'newest', createdAt: 60 }], [early]).get('first')).toEqual([early]);
  });
  it('retires live work when its completed process is present', () => {
    expect(botGroupWorkAnchors([{ id: 'answer', createdAt: 50, process: { executionId: 'a' } }], [{ executionId: 'a', requestedAt: 20 }]).size).toBe(0);
  });
  it('handles an unloaded source, an empty timeline and older hosts', () => {
    expect(botGroupWorkAnchors(messages, [{ requestedAt: 5 }]).has(null)).toBe(true);
    expect(botGroupWorkAnchors([], [{}]).get(null)).toEqual([{}]);
    expect(botGroupWorkAnchors(messages, [{ sourceMessageId: 'first' }]).has('first')).toBe(true);
    expect(botGroupWorkAnchors(messages, [{}]).has('later')).toBe(true);
  });
  // Live /executions can omit enqueue time; a delayed start must stay with the request.
  it('uses the source before a later start when enqueue time is unavailable', () => {
    const work = { executionId: 'a', sourceMessageId: 'first', startedAt: 50 };
    expect(botGroupWorkAnchors(messages, [work]).get('first')).toEqual([work]);
  });
  // A confirmed send keeps its optimistic row ID until history catches up.
  it('anchors a receipt to its optimistic row without changing speaker identity', () => {
    const own = { executionId: 'a', sourceMessageId: 'server-first' };
    const other = { executionId: 'b', sourceMessageId: 'later' };
    const rows = [{ id: 'pending:local-first', serverMessageId: 'server-first', createdAt: 10 }, messages[1]!];
    const anchors = botGroupWorkAnchors(rows, [other, own]);
    expect(anchors.get('pending:local-first')?.[0]).toBe(own);
    expect(anchors.get('later')?.[0]).toBe(other);
  });
});
