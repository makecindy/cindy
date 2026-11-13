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
});
