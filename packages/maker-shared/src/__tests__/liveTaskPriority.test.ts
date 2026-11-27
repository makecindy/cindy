import { describe, expect, it } from 'vitest';

import { INDEFINITE_SNOOZE_UNTIL, isTeammateOwnInboxTask, taskSnoozeUntil, LIVE_TASK_PRIORITY, liveTaskPriorityRank, taskInboxSection, teammateInboxSection } from '../liveTaskPriority';

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
  it('keeps indefinite deferrals out of expiry timers and wakes them on new input', () => {
    const indefinite = { ...task, snoozedUntil: INDEFINITE_SNOOZE_UNTIL };
    expect(taskSnoozeUntil(indefinite)).toBe(Infinity);
    expect(taskInboxSection(indefinite, idle, now + 2 * 365 * 86400000)).toBe('snoozed');
    expect(taskInboxSection({ ...indefinite, userSendAt: new Date(now + 1).toISOString() }, idle, now)).toBe('inbox');
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

it('keeps a quiet follow-up in working; results, waiting, snooze and archive take precedence', () => {
  const now = Date.parse('2026-11-13T08:00:00Z');
  const signals = { running: false, waiting: false, following: true };
  expect(taskInboxSection({}, signals, now)).toBe('working');
  expect(taskInboxSection({}, { ...signals, following: false }, now)).toBe('inbox');
  expect(taskInboxSection({}, { ...signals, waiting: true }, now)).toBe('inbox');
  // Bug 2026-11-17: a followed task stayed in working after a round left a result.
  expect(taskInboxSection({}, { ...signals, unread: true }, now)).toBe('inbox');
  expect(taskInboxSection({}, { ...signals, unread: true, running: true }, now)).toBe('working');
  expect(taskInboxSection({ snoozedUntil: new Date(now + 1000).toISOString() }, signals, now)).toBe('snoozed');
  expect(taskInboxSection({ status: 'archived' }, signals, now)).toBe('archived');
});

// 2026-11-18 user decision: the phone's inbox filled with teammates' routine results. A teammate's
// task is listed only while it needs the user (Pending) or runs (Working); idle ones are left out.
it('lists a teammate task only while it needs the user or runs', () => {
  const now = Date.parse('2026-11-18T08:00:00Z');
  const teammate = { running: false, waiting: false, teammate: true };
  expect(taskInboxSection({}, { ...teammate, unread: true }, now)).toBeNull();
  expect(taskInboxSection({}, teammate, now)).toBeNull();
  expect(taskInboxSection({}, { ...teammate, running: true }, now)).toBe('working');
  expect(taskInboxSection({}, { ...teammate, waiting: true }, now)).toBe('inbox');
  expect(taskInboxSection({ snoozedUntil: new Date(now + 1000).toISOString() }, teammate, now)).toBe('snoozed');
  expect(taskInboxSection({ status: 'archived' }, teammate, now)).toBe('archived');
});

// 2026-11-20 user decision: a teammate's main conversation is one inbox row. Idle and read it is
// left out (the teammate section still lists it); a snooze must not swallow a later request.
it('lists a teammate conversation by whose turn it is and wakes its snooze on new input', () => {
  const now = Date.parse('2026-11-20T08:00:00Z');
  expect(teammateInboxSection('awaiting', null, now)).toBe('inbox');
  expect(teammateInboxSection('error', null, now)).toBe('inbox');
  expect(teammateInboxSection('done', null, now)).toBe('inbox');
  expect(teammateInboxSection('unread', null, now)).toBe('inbox');
  expect(teammateInboxSection('running', null, now)).toBe('working');
  expect(teammateInboxSection('idle', null, now)).toBeNull();
  const snooze = { snoozedAt: new Date(now).toISOString(), snoozedUntil: INDEFINITE_SNOOZE_UNTIL };
  expect(teammateInboxSection('awaiting', snooze, now + 1)).toBe('snoozed');
  expect(teammateInboxSection('idle', snooze, now + 1)).toBe('snoozed');
  expect(teammateInboxSection('awaiting', { ...snooze, userSendAt: new Date(now + 1).toISOString() }, now + 2)).toBe('inbox');
  expect(teammateInboxSection('idle', { ...snooze, snoozedUntil: new Date(now + 1000).toISOString() }, now + 1000)).toBeNull();
});

// 2026-11-22 user decision: a task a teammate opened in the owner's project was left out of the
// inbox with its result, while the hand-off skill told the teammate not to ask for it back: the
// result was in neither place and work went unfinished. Only the teammate's own conversations and
// its own project's tasks stay with the teammate; what it opens elsewhere is the owner's work.
it('keeps only a teammate\'s own conversations and project tasks with the teammate', () => {
  const project = '/Users/me/Library/Application Support/Cindy/owners/o1/bots/bot_mia/workspace';
  expect(isTeammateOwnInboxTask({ source: 'bot', companion: { role: 'channel' } })).toBe(true);
  expect(isTeammateOwnInboxTask({ source: 'bot', companion: { role: 'group' } })).toBe(true);
  expect(isTeammateOwnInboxTask({ source: 'scheduler', workingDir: project })).toBe(true);
  expect(isTeammateOwnInboxTask({ source: 'desktop', projectDir: project, workingDir: '/tmp/elsewhere' })).toBe(true);
  // Opened by the teammate in the owner's repository (or a worktree of it): ordinary work.
  expect(isTeammateOwnInboxTask({ source: 'desktop', workingDir: '/Users/me/code/app' })).toBe(false);
  expect(isTeammateOwnInboxTask({ source: 'desktop', workingDir: '/Users/me/code/app/.cindy-worktrees/calm-ada' })).toBe(false);
  const now = Date.now();
  expect(taskInboxSection({}, { running: false, waiting: false, unread: true,
    teammate: isTeammateOwnInboxTask({ source: 'desktop', workingDir: '/Users/me/code/app' }) }, now)).toBe('inbox');
});


// Unit regression: both inboxes must drop the read, idle pin and surface its next result.
it('keeps idle read pins out of Pending until they need attention again', () => {
  const pin = { status: 'active', pinnedAt: '2026-11-25T00:00:00Z' };
  const idle = { waiting: false, running: false, unread: false };
  expect(taskInboxSection(pin, idle, 0)).toBeNull();
  expect(taskInboxSection(pin, { ...idle, unread: true }, 0)).toBe('inbox');
  expect(taskInboxSection(pin, { ...idle, waiting: true }, 0)).toBe('inbox');
});
