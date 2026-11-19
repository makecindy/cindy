/**
 * snooze_sessions / complete_sessions tool contract (unit tier, in-process fakes).
 *
 * Production entry: the registry handlers plugins reach through cindy.host.call('cindy_helper').
 * Rule: docs/product-rules/task-inbox.md (snooze limits, inbox "Done", one computer per call).
 * Gap: no existing test covers these tools; the archive tests cover only status writes.
 * Minimal failing inputs: a past wake time, a qualified id mixed with a local one, a remote
 * complete (which must not reach the host), and completing the caller's own task.
 */
import { describe, expect, it, vi } from 'vitest';

import { INDEFINITE_SNOOZE_UNTIL } from '@cindy/maker-shared/live-task-priority';
import { XdtHelperToolRegistry, type XdtHelperToolResult } from '../lizi_xdtHelperToolRegistry.js';
import { registerTaskInboxTools, type TaskInboxDeps } from '../xdt-helper/task_inbox.js';

function parse(result: XdtHelperToolResult) {
  const [block] = result.content;
  if (block?.type !== 'text') throw new Error('Expected text');
  return JSON.parse(block.text);
}

function setup(sessionId = 'caller') {
  const setSessionsSnooze = vi.fn<TaskInboxDeps['setSessionsSnooze']>(async ({ sessionIds, snoozedUntil }) => ({
    ok: true,
    changed: sessionIds.map((id) => ({ sessionId: id, title: id, snoozedUntil, snoozedAt: snoozedUntil ? '2026-11-20T00:00:00.000Z' : null })),
  }));
  const completeSessions = vi.fn<NonNullable<TaskInboxDeps['completeSessions']>>(async ({ sessionIds }) => ({
    ok: true,
    items: sessionIds.map((id) => ({ sessionId: id, title: id, outcome: id === 'busy' ? 'blocked' as const : 'archived' as const,
      ...(id === 'busy' ? { reason: 'RUNNING' as const } : {}) })),
  }));
  const registry = new XdtHelperToolRegistry();
  registerTaskInboxTools(registry, {
    getSessionContext: () => ({ sessionId, agentKind: 'claude-code', workingDir: '/tmp' }),
    setSessionsSnooze,
    completeSessions,
  });
  return { registry, setSessionsSnooze, completeSessions };
}

describe('snooze_sessions', () => {
  it('accepts the sidebar wake times and rejects the rest before writing', async () => {
    const { registry, setSessionsSnooze } = setup();
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString();
    expect(parse(await registry.call('snooze_sessions', { session_ids: ['a'], until: tomorrow })).ok).toBe(true);
    expect(parse(await registry.call('snooze_sessions', { session_ids: ['a'], until: 'indefinite' })).ok).toBe(true);
    expect(parse(await registry.call('snooze_sessions', { session_ids: ['local::a'], until: null })).ok).toBe(true);
    expect(setSessionsSnooze.mock.calls.map(([call]) => call)).toEqual([
      { sessionIds: ['a'], snoozedUntil: tomorrow },
      { sessionIds: ['a'], snoozedUntil: INDEFINITE_SNOOZE_UNTIL },
      { sessionIds: ['a'], snoozedUntil: null },
    ]);
    for (const until of [new Date(Date.now() - 1_000).toISOString(), new Date(Date.now() + 400 * 86_400_000).toISOString(), 'soon']) {
      expect(parse(await registry.call('snooze_sessions', { session_ids: ['a'], until })).errorCode).toBe('INVALID_ARGS');
    }
    expect(parse(await registry.call('snooze_sessions', { session_ids: ['a', 'studio::b'], until: null })).errorCode).toBe('INVALID_ARGS');
    expect(parse(await registry.call('snooze_sessions', { session_ids: ['a', 'local::a'], until: null })).errorCode).toBe('INVALID_ARGS');
    expect(setSessionsSnooze).toHaveBeenCalledTimes(3);
  });

  it('routes one remote computer per call and qualifies receipts, including partial failures', async () => {
    const { registry, setSessionsSnooze } = setup();
    setSessionsSnooze.mockResolvedValueOnce({
      ok: false, errorCode: 'REMOTE_UNSUPPORTED', message: 'old', changed: [{ sessionId: 'a', title: 'a', snoozedUntil: null, snoozedAt: null }],
      failedSessionId: 'b', remainingSessionIds: ['c'],
    });
    const result = parse(await registry.call('snooze_sessions', { session_ids: ['studio::a', 'studio::b', 'studio::c'], until: null }));
    expect(setSessionsSnooze).toHaveBeenCalledWith({ deviceId: 'studio', sessionIds: ['a', 'b', 'c'], snoozedUntil: null });
    expect(result).toMatchObject({
      ok: false,
      errorCode: 'REMOTE_UNSUPPORTED',
      data: { partial: true, changed: [{ session_id: 'studio::a' }], failed_session_id: 'studio::b', remaining_session_ids: ['studio::c'] },
    });
  });
});

describe('complete_sessions', () => {
  it('returns per-task outcomes and never forwards remote or self completion', async () => {
    const { registry, completeSessions } = setup('caller');
    expect(parse(await registry.call('complete_sessions', { session_ids: ['done', 'busy'] }))).toMatchObject({
      ok: true,
      count: 1,
      items: [{ session_id: 'done', outcome: 'archived' }, { session_id: 'busy', outcome: 'blocked', reason: 'RUNNING' }],
    });
    expect(parse(await registry.call('complete_sessions', { session_ids: ['studio::a'] })).errorCode).toBe('REMOTE_UNSUPPORTED');
    expect(parse(await registry.call('complete_sessions', { session_ids: ['caller'] })).errorCode).toBe('INVALID_ARGS');
    expect(completeSessions).toHaveBeenCalledTimes(1);
  });
});
