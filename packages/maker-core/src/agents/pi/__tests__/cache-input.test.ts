import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { createPiCacheInputTracker } from '../cache-input.js';

describe('Pi accepted queue provenance', () => {
  function fixture() {
    const digest = (text: string) => createHash('sha256').update(text).digest('hex');
    const tracker = createPiCacheInputTracker(digest);
    const queues = (steering: string[], followUp: string[]) => tracker.observe({ type: 'queue_update', steering, followUp });
    const start = (text: string) => tracker.observe({ type: 'message_start', message: { role: 'user', content: [{ type: 'text', text }], timestamp: 123 } });
    return { tracker, queues, start };
  }

  it('uses accepted expanded queue text, including mixed queue priority and multiple inputs', () => {
    const h = fixture();
    // Raw input events may be transformed/handled; only native accepted
    // queues count. No input counter or unexpanded text is involved.
    h.tracker.observe({ type: 'input', streamingBehavior: 'steer', text: 'handled' });
    h.queues([], ['expanded template', 'second']);
    h.queues(['inserted steer'], ['expanded template', 'second']);
    h.queues([], ['expanded template', 'second']);
    expect(h.start('inserted steer')?.followUp).toBe(false);
    h.queues([], ['second']);
    const first = h.start('expanded template');
    expect(first?.followUp).toBe(true);
    expect(h.tracker.read(first!.key)).toEqual(first);
    expect(h.tracker.read('stale')).toBeUndefined();
    h.queues([], []);
    expect(h.start('second')?.followUp).toBe(true);
    expect(h.start('not queued')?.followUp).toBe(false);
  });

  it('does not mistake clearing/replacement, mismatched messages or tools for consumption', () => {
    const h = fixture();
    h.queues([], ['one', 'two']); h.queues([], []);
    expect(h.start('one')?.followUp).toBe(false);
    h.queues([], ['one']); h.queues([], ['replacement']);
    expect(h.start('one')?.followUp).toBe(false);
    h.queues([], []);
    expect(h.start('different')?.followUp).toBe(false);
    h.queues([], ['one']); h.queues([], []);
    h.tracker.observe({ type: 'agent_start' });
    expect(h.start('one')?.followUp).toBe(false);
    expect(h.tracker.observe({ type: 'message_start', message: { role: 'toolResult' } })).toBeUndefined();
  });

  it('fails closed for identical text across queues, even after it disappears from one queue', () => {
    const h = fixture();
    h.queues(['same'], ['same']);
    h.queues([], ['same']);
    expect(h.start('same')?.followUp).toBe(false);
    h.queues([], []);
    expect(h.start('same')?.followUp).toBe(false);
    h.tracker.observe({ type: 'agent_settled' });
    h.queues([], ['same']); h.queues([], []);
    expect(h.start('same')?.followUp).toBe(true);
  });

  it.each(['agent_settled', 'session_switch', 'session_shutdown'])('discards accepted queues at %s', type => {
    const h = fixture();
    h.queues([], ['old session']);
    h.tracker.observe({ type });
    h.queues([], []);
    expect(h.start('old session')?.followUp).toBe(false);
    h.queues([], ['new input']); h.queues([], []);
    expect(h.start('new input')?.followUp).toBe(true);
  });

  it('does not reuse uncertain or excessive queue state', () => {
    const h = fixture();
    h.tracker.observe({ type: 'queue_update', steering: null, followUp: [] });
    h.queues([], ['one']); h.queues([], []);
    expect(h.start('one')?.followUp).toBe(false);
    h.tracker.observe({ type: 'agent_settled' });
    h.queues([], Array.from({ length: 1025 }, (_, i) => String(i)));
    h.queues([], ['one']); h.queues([], []);
    expect(h.start('one')?.followUp).toBe(false);
  });
});
