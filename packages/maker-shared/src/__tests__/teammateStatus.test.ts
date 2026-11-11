import { describe, expect, it } from 'vitest';
import { aggregateTeammateStatus, resolveTeammateStatus, teammateGroupActivity, teammateChatActivity } from '../teammateStatus';

// Unit: production roster projection used on all three clients. Previously the strip
// only showed unread and mobile hid waiting while generation remained set. Existing
// session tests do not cover teammate read receipts, connectivity or group plans.
describe('teammate avatar status', () => {
  it('keeps a pending decision visible over concurrent work, errors and unread, even after reading', () => {
    for (const unread of [true, false]) expect(resolveTeammateStatus({ unread, working: true, failed: true,
      activities: [{ phase: 'needs-interaction' }] })).toBe('awaiting');
  });
  it('uses the result and the controller read receipt together; legacy messages stay unread', () => {
    expect(resolveTeammateStatus({ activities: [{ phase: 'completed' }], unread: true })).toBe('done');
    expect(resolveTeammateStatus({ activities: [{ phase: 'completed' }], unread: false })).toBe('idle');
    expect(resolveTeammateStatus({ unread: true })).toBe('unread');
    expect(resolveTeammateStatus({ unread: true, working: true })).toBe('running');
  });
  it('does not turn failed work into successful completion', () => {
    expect(resolveTeammateStatus({ unread: true, activities: [{ phase: 'error' }, { phase: 'completed' }] })).toBe('error');
  });
  it('ignores stale work offline, keeps cloud presence quiet and never invents offline from unknown', () => {
    expect(resolveTeammateStatus({ online: false, working: true })).toBe('error');
    expect(resolveTeammateStatus({ online: false, working: true, quietOffline: true })).toBe('idle');
    expect(resolveTeammateStatus({ online: null })).toBe('idle');
  });
  it('preserves the most actionable hidden entry independently of sorting', () => {
    expect(aggregateTeammateStatus(['done', 'running', 'awaiting', 'unread'])).toBe('awaiting');
    expect(aggregateTeammateStatus(['unread', 'error', 'running'])).toBe('error');
    expect(aggregateTeammateStatus([])).toBe('idle');
  });
  it('distinguishes actionable group plans, ordinary human messages and archived activity', () => {
    const group = { speakingBotIds: [], lastMessage: { authorKind: 'user' } };
    expect(teammateGroupActivity(group).phase).toBe('idle');
    expect(teammateGroupActivity({ ...group, openPlan: { status: 'proposed' } }).phase).toBe('needs-interaction');
    expect(teammateGroupActivity({ ...group, openPlan: { status: 'waiting', currentStepStatus: 'failed' } }).phase).toBe('needs-interaction');
    expect(teammateGroupActivity({ ...group, speakingBotIds: ['bot'] }).phase).toBe('running');
    expect(teammateGroupActivity({ ...group, archived: true, speakingBotIds: ['bot'] }).phase).toBe('idle');
  });
});

it('uses server executions instead of unread messages and ignores stale terminal runs', () => {
  const input = { executions: [{ status: 'succeeded', updated_at: '2026-10-29T01:00:00Z' }], plans: [], lastMessageAt: Date.parse('2026-10-29T00:59:59Z') };
  expect(teammateChatActivity(input).phase).toBe('completed');
  expect(teammateChatActivity({ ...input, lastMessageAt: Date.parse('2026-10-29T01:01:00Z') }).phase).toBe('idle');
  expect(teammateChatActivity({ ...input, executions: [{ status: 'failed', updated_at: '2026-10-29T01:00:00Z' }] }).phase).toBe('error');
  // Unit regression: a concurrent topic must not hide a recent main-chat failure;
  // the existing single-execution assertions could not exercise this priority.
  const failedAndRunning = { ...input, executions: [
    { status: 'failed', updated_at: '2026-10-29T01:00:00Z' }, { status: 'running' },
  ] };
  expect(teammateChatActivity(failedAndRunning).phase).toBe('error');
  expect(teammateChatActivity({ ...failedAndRunning, lastMessageAt: Date.parse('2026-10-29T01:01:00Z') }).phase).toBe('running');
  expect(teammateChatActivity({ ...failedAndRunning, plans: [{ status: 'waiting' }] }).phase).toBe('needs-interaction');
  expect(teammateChatActivity({ ...input, executions: [{ status: 'needs_input' }, { status: 'running' }] }).phase).toBe('needs-interaction');
  expect(teammateChatActivity({ ...input, plans: [{ status: 'waiting' }] }).phase).toBe('needs-interaction');
});
