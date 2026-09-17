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

  it('excludes local scheduled unread results from the system badge', () => {
    const unread = { hasUnreadRun: true, hasUnreadFailedRun: false };
    expect(
      countAppAttention(
        input({
          localSchedules: new Map([
            ['a', unread],
            ['b', unread],
          ]),
        }),
      ),
    ).toBe(0);
  });

  it('excludes remote and automated sessions from the system badge', () => {
    expect(
      countAppAttention(
        input({
          sessions: [
            session('local'),
            session('remote', { deviceLinkDeviceId: 'device-a' }),
            session('scheduler', { source: 'scheduler' }),
            session('learn', { source: 'learn' }),
            session('legacy', { title: '[Schedule] nightly', source: 'desktop' }),
          ],
          attentionKinds: new Map([
            ['local', 'done'],
            ['remote', 'done'],
            ['scheduler', 'error'],
            ['learn', 'awaiting'],
            ['legacy', 'done'],
          ]),
          localSchedules: new Map([
            ['remote', { hasUnreadRun: true, hasUnreadFailedRun: true }],
            ['scheduler', { hasUnreadRun: true, hasUnreadFailedRun: true }],
          ]),
        }),
      ),
    ).toBe(1);
  });

  it('still counts user-driven attention on ordinary tasks bound by a heartbeat schedule', () => {
    expect(
      countAppAttention(
        input({
          sessions: [
            session('bound-read'),
            session('bound-unread'),
            session('bound-paused'),
            session('scheduler', { source: 'scheduler' }),
          ],
          attentionKinds: new Map([
            ['bound-read', 'done'],
            ['bound-unread', 'awaiting'],
            ['bound-paused', 'error'],
            ['scheduler', 'done'],
          ]),
          localSchedules: new Map([
            ['bound-read', { hasUnreadRun: false, hasUnreadFailedRun: false }],
            ['bound-unread', { hasUnreadRun: true, hasUnreadFailedRun: false }],
            ['bound-paused', { hasUnreadRun: false, hasUnreadFailedRun: false }],
            ['scheduler', { hasUnreadRun: true, hasUnreadFailedRun: true }],
          ]),
        }),
      ),
    ).toBe(3);
  });

  it('excludes heartbeat-generated done on a bound ordinary task without dropping later user attention', () => {
    const sessions = [session('bound')];
    const localSchedules = new Map([['bound', { hasUnreadRun: true, hasUnreadFailedRun: false }]]);
    expect(
      countAppAttention(
        input({
          sessions,
          attentionKinds: new Map([['bound', 'done']]),
          localSchedules,
        }),
      ),
    ).toBe(0);
    expect(
      countAppAttention(
        input({
          sessions,
          attentionKinds: new Map([['bound', 'awaiting']]),
          localSchedules,
        }),
      ),
    ).toBe(1);
    expect(
      countAppAttention(
        input({
          sessions,
          attentionKinds: new Map([['bound', 'error']]),
          localSchedules: new Map([['bound', { hasUnreadRun: false, hasUnreadFailedRun: false }]]),
        }),
      ),
    ).toBe(1);
  });

  it('deduplicates the same local task across activity and notifications', () => {
    expect(
      countAppAttention(
        input({
          sessions: [session('a'), session('a')],
          attentionKinds: new Map([['a', 'error']]),
          localActivities: new Map([['a', { phase: 'error', attention: true }]]),
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

  it('does not promote local activity without an attention signal', () => {
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
