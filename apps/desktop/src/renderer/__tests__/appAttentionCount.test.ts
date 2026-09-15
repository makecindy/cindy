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
    localSchedules: new Map(),
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

  it('keeps local scheduled unread on an ordinary task but drops automation tasks', () => {
    const unread = { hasUnreadRun: true, hasUnreadFailedRun: false };
    expect(
      countAppAttention(
        input({
          sessions: [
            session('a'),
            session('scheduler-task', { source: 'scheduler' }),
            session('legacy-task', { title: '[Schedule] daily' }),
            session('learn-task', { source: 'learn' }),
          ],
          localSchedules: new Map([
            ['a', unread],
            ['scheduler-task', unread],
          ]),
        }),
      ),
    ).toBe(1);
  });

  it('drops device-link remote tasks from the system badge', () => {
    expect(
      countAppAttention(
        input({
          sessions: [
            session('a'),
            session('remote', { deviceLinkDeviceId: 'device-a' }),
            session('remote-scheduler', { deviceLinkDeviceId: 'device-b', source: 'scheduler' }),
          ],
          attentionKinds: new Map([
            ['a', 'done'],
            ['remote', 'error'],
            ['remote-scheduler', 'awaiting'],
          ]),
          localSchedules: new Map([
            ['remote', { hasUnreadRun: true, hasUnreadFailedRun: true }],
          ]),
        }),
      ),
    ).toBe(1);
  });

  it('deduplicates the same task across activity and notifications', () => {
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

  it('does not promote live activity that carries no attention signal', () => {
    expect(
      countAppAttention(
        input({
          localActivities: new Map([['a', { phase: 'running' }]]),
        }),
      ),
    ).toBe(0);
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
