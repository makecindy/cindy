import { describe, expect, it } from 'vitest';

import { LIVE_TASK_PRIORITY, liveTaskPriorityRank, taskInboxSection } from '../liveTaskPriority';

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

// Unit: the same persisted task must move identically on desktop and mobile, even after sleep.
describe('task inbox lifecycle', () => {
  const now = Date.parse('2026-11-12T08:00:00Z');
  const task = { status: 'active', snoozedAt: new Date(now).toISOString(), snoozedUntil: new Date(now + 3600000).toISOString() };
  const idle = { running: false, waiting: false };
  it('keeps idle/read tasks in inbox and running interactions out of working', () => {
    expect(taskInboxSection({}, idle, now)).toBe('inbox');
    expect(taskInboxSection({}, { running: true, waiting: false }, now)).toBe('working');
    expect(taskInboxSection({}, { running: true, waiting: true }, now)).toBe('inbox');
  });
  it('defers until the deadline, with archive and new input taking precedence', () => {
    expect(taskInboxSection(task, idle, now)).toBe('snoozed');
    expect(taskInboxSection(task, idle, now + 3600000)).toBe('inbox');
    expect(taskInboxSection(task, { running: true, waiting: false }, now + 3600000)).toBe('working');
    expect(taskInboxSection({ ...task, status: 'archived' }, idle, now)).toBe('archived');
    expect(taskInboxSection({ ...task, userSendAt: new Date(now + 1).toISOString() }, idle, now)).toBe('inbox');
    expect(taskInboxSection({ ...task, snoozedUntil: null }, idle, now)).toBe('inbox');
    expect(taskInboxSection({ snoozedUntil: 'bad date' }, idle, now)).toBe('inbox');
  });
});

it('keeps active follow-up in working between runs, behind user attention, snooze and archive', () => {
  const now = Date.parse('2026-11-13T08:00:00Z');
  const signals = { running: false, waiting: false, following: true };
  expect(taskInboxSection({}, signals, now)).toBe('working');
  expect(taskInboxSection({}, { ...signals, following: false }, now)).toBe('inbox');
  expect(taskInboxSection({}, { ...signals, waiting: true }, now)).toBe('inbox');
  expect(taskInboxSection({ snoozedUntil: new Date(now + 1000).toISOString() }, signals, now)).toBe('snoozed');
  expect(taskInboxSection({ status: 'archived' }, signals, now)).toBe('archived');
});
