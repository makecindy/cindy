import { describe, it, expect, vi } from 'vitest';
import { createBotLearningTracker } from '../botLearningTracker.js';
import { botLearningRows } from '@cindy/maker-shared/bot-learning';
const memory = {
  kind: 'memory' as const,
  key: 'preference',
  title: '先讲结论',
  action: 'created' as const,
};
const skill = {
  kind: 'skill' as const,
  key: 'weekly-report',
  title: '工作周报',
  action: 'updated' as const,
};
describe('teammate learning receipt ownership', () => {
  it('withholds early saves, then publishes both rows on the corresponding reply', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    tracker.capture('s')(memory);
    tracker.capture('s')(skill);
    expect(publish).not.toHaveBeenCalled();
    tracker.seal('s', 'instance:1', 'reply-one');
    expect(publish).toHaveBeenCalledWith('reply-one', [memory, skill]);
  });
  it('a late save stays with its original bubble while a new reply is running', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    const save = tracker.capture('s');
    tracker.seal('s', 'instance:1', 'reply-one');
    tracker.observe('s', 'instance:2', publish);
    save(memory);
    expect(publish).toHaveBeenLastCalledWith('reply-one', [memory]);
    tracker.capture('s')(skill);
    tracker.seal('s', 'instance:2', 'reply-two');
    expect(publish).toHaveBeenLastCalledWith('reply-two', [skill]);
  });
  it('never invents a bubble or moves an abandoned save to a later turn', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'instance:1', publish);
    const save = tracker.capture('s');
    tracker.seal('s', 'instance:1');
    tracker.observe('s', 'replacement:1', publish);
    save(memory);
    tracker.seal('s', 'instance:1', 'wrong');
    tracker.seal('s', 'replacement:1', 'new');
    expect(publish).not.toHaveBeenCalled();
  });
  it('deduplicates repeated saves and keeps at most two separate rows across history JSON', () => {
    const tracker = createBotLearningTracker(),
      publish = vi.fn();
    tracker.observe('s', 'i:1', publish);
    tracker.capture('s')(memory);
    tracker.capture('s')(memory);
    tracker.capture('s')(skill);
    tracker.capture('s')({ ...memory, key: 'another', title: '简短说明' });
    tracker.seal('s', 'i:1', 'reply');
    const rows = botLearningRows(JSON.parse(JSON.stringify(publish.mock.calls[0][1])));
    expect(rows.map((r) => r.kind)).toEqual(['memory', 'skill']);
    expect(rows[0].title).toBe('先讲结论 · 简短说明');
  });
});
