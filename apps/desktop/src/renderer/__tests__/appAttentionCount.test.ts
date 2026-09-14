import { describe, expect, it } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';
import {
  countAppAttention,
  type AppAttentionCountInput,
} from '../features/cc-agent/lib/appAttentionCount';

function session(id: string, extra: Partial<Session> = {}): Session {
  return { id, status: 'active', ...extra } as Session;
}

function input(overrides: Partial<AppAttentionCountInput> = {}): AppAttentionCountInput {
  return {
    sessions: [session('a'), session('b'), session('c')],
    attentionKinds: new Map(),
    runningSessionIds: new Set(),
    localActivities: new Map(),
    getRemoteActivity: () => undefined,
    localSchedules: new Map(),
    remoteSchedules: new Map(),
    ...overrides,
  };
}

describe('app attention total', () => {
  it('counts three unread tasks and drops only the task read', () => {
    const attentionKinds = new Map<'a' | 'b' | 'c', 'done'>([
      ['a', 'done'],
      ['b', 'done'],
      ['c', 'done'],
    ]);
    expect(countAppAttention(input({ attentionKinds }))).toBe(3);
    attentionKinds.delete('a');
    expect(countAppAttention(input({ attentionKinds }))).toBe(2);
  });

  it('restores scheduled unread results without in-memory notification events', () => {
    const unread = { hasUnreadRun: true, hasUnreadFailedRun: false };
    expect(
      countAppAttention(
        input({
          localSchedules: new Map([
            ['a', unread],
            ['b', unread],
          ]),
          remoteSchedules: new Map([['c', unread]]),
        }),
      ),
    ).toBe(3);
  });

  it('deduplicates the same task across activity, notifications and schedule history', () => {
    expect(
      countAppAttention(
        input({
          sessions: [session('a'), session('a')],
          attentionKinds: new Map([['a', 'error']]),
          localActivities: new Map([['a', { phase: 'error', attention: true }]]),
          localSchedules: new Map([['a', { hasUnreadRun: true, hasUnreadFailedRun: true }]]),
        }),
      ),
    ).toBe(1);
  });

  it('counts waiting and errors but excludes a running task with an old unread result', () => {
    expect(
      countAppAttention(
        input({
          attentionKinds: new Map([
            ['a', 'done'],
            ['b', 'awaiting'],
            ['c', 'error'],
          ]),
          runningSessionIds: new Set(['a', 'b', 'c']),
        }),
      ),
    ).toBe(2);
  });

  it('includes remote live attention with the same precedence as task rows', () => {
    expect(
      countAppAttention(
        input({
          localActivities: new Map([['a', { phase: 'running' }]]),
          getRemoteActivity: (id) =>
            id === 'a'
              ? { phase: 'completed', attention: true }
              : id === 'b'
                ? { phase: 'needs-interaction' }
                : undefined,
        }),
      ),
    ).toBe(2);
  });

  it('excludes archived, deleted, worker and missing task records', () => {
    expect(
      countAppAttention(
        input({
          sessions: [
            session('a', { status: 'archived' }),
            session('b', { status: 'deleted' }),
            session('c', { orcaRole: 'worker' }),
          ],
          attentionKinds: new Map([
            ['a', 'done'],
            ['b', 'error'],
            ['c', 'awaiting'],
            ['missing', 'done'],
          ]),
        }),
      ),
    ).toBe(0);
  });
});
