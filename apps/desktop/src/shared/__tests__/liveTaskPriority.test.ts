import { describe, expect, it } from 'vitest';

import { LIVE_TASK_PRIORITY, liveTaskPriorityRank } from '../liveTaskPriority';

describe('liveTaskPriorityRank', () => {
  it('puts waiting (including error) ahead of unread, then running, then rest', () => {
    expect(liveTaskPriorityRank({ waiting: true, unread: true, running: false })).toBe(
      LIVE_TASK_PRIORITY.waiting,
    );
    expect(liveTaskPriorityRank({ waiting: false, unread: true, running: true })).toBe(
      LIVE_TASK_PRIORITY.running,
    );
    expect(liveTaskPriorityRank({ waiting: false, unread: true, running: false })).toBe(
      LIVE_TASK_PRIORITY.unread,
    );
    expect(liveTaskPriorityRank({ waiting: false, unread: false, running: true })).toBe(
      LIVE_TASK_PRIORITY.running,
    );
    expect(liveTaskPriorityRank({ waiting: false, unread: false, running: false })).toBe(
      LIVE_TASK_PRIORITY.rest,
    );
  });
});
