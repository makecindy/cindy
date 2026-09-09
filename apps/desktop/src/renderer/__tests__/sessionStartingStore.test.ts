import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  applyRemoteSessionActivity,
  clearRemoteSessionActivity,
  getRemoteSessionActivity,
} from '@/features/device-link/remoteSessionActivityStore';
import {
  absorbSessionStarting,
  clearSessionStarting,
  getStartingSessionIds,
  markSessionStarting,
  resetSessionStartingStoreForTests,
  SESSION_STARTING_TTL_MS,
} from '@/lib/sessionStartingStore';

describe('sessionStartingStore', () => {
  beforeEach(() => {
    resetSessionStartingStoreForTests();
    clearRemoteSessionActivity();
    vi.useFakeTimers();
  });

  afterEach(() => {
    resetSessionStartingStoreForTests();
    clearRemoteSessionActivity();
    vi.useRealTimers();
  });

  it('marks a just-sent session until it is absorbed or cleared', () => {
    markSessionStarting('new-task');
    expect([...getStartingSessionIds()]).toEqual(['new-task']);

    absorbSessionStarting(['new-task']);
    expect([...getStartingSessionIds()]).toEqual([]);
  });

  it('keeps snapshot identity when remaking the same session', () => {
    markSessionStarting('s1');
    const first = getStartingSessionIds();
    markSessionStarting('s1');
    expect(getStartingSessionIds()).toBe(first);
  });

  it('does not absorb unknown ids and can clear a leftover mark', () => {
    markSessionStarting('keep');
    absorbSessionStarting(['other']);
    expect([...getStartingSessionIds()]).toEqual(['keep']);

    clearSessionStarting('keep');
    expect([...getStartingSessionIds()]).toEqual([]);
    clearSessionStarting('keep');
  });

  it('drops a stale remote completed mirror on first mark, not on TTL refresh', () => {
    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: true,
    });
    markSessionStarting('s1');
    expect(getRemoteSessionActivity('s1')).toBeUndefined();
    expect([...getStartingSessionIds()]).toEqual(['s1']);

    applyRemoteSessionActivity('dev-1', {
      sessionId: 's1',
      phase: 'completed',
      compactDetail: '',
      attention: true,
    });
    markSessionStarting('s1');
    expect(getRemoteSessionActivity('s1')).toMatchObject({ phase: 'completed' });
    absorbSessionStarting(['s1']);
    expect([...getStartingSessionIds()]).toEqual([]);
  });

  it('expires a starting mark that never becomes running', () => {
    markSessionStarting('stuck');
    vi.advanceTimersByTime(SESSION_STARTING_TTL_MS - 1);
    expect([...getStartingSessionIds()]).toEqual(['stuck']);
    vi.advanceTimersByTime(1);
    expect([...getStartingSessionIds()]).toEqual([]);
  });

  it('clears starting from asynchronous remote optimistic failure settlement', () => {
    const source = readFileSync(resolve(__dirname, '..', 'lib', 'makerChatStore.ts'), 'utf8');
    const start = source.indexOf('function settleRemoteOptimisticFailure');
    const end = source.indexOf('async function pumpRemoteOptimisticSends', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    expect(source.slice(start, end)).toContain('clearSessionStarting(sessionId)');
    expect(source.slice(start, end)).toContain(
      'if (!remoteOptimisticSendRecords(sessionId)?.size)',
    );
  });

  it('clears starting when enqueue only parks the message in a paused or locked queue', () => {
    const source = readFileSync(resolve(__dirname, '..', 'lib', 'makerChatStore.ts'), 'utf8');
    const start = source.indexOf('return operation.api.input');
    const end = source.indexOf('function compactSession', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const enqueueResult = source.slice(start, end);
    expect(enqueueResult).toContain('projection.queuePaused');
    expect(enqueueResult).toContain('clearSessionStarting(sessionId)');
  });
});
