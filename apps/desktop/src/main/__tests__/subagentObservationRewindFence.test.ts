import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __resetSubagentObservationRewindStateForTesting,
  beginSubagentRewindFence,
  captureSubagentObservationGeneration,
  clearSubagentObservationRewindState,
  enqueueSubagentObservationWrite,
  finishSubagentRewindFence,
  noteSubagentObservationTurnStarted,
  primeSubagentRewindFence,
} from '../subagentObservationRewindFence.js';

const SESSION = 'session-1';

function update(
  taskId: string,
  kind: 'spawn' | 'progress' | 'terminal',
  status: 'running' | 'completed' = kind === 'terminal' ? 'completed' : 'running',
) {
  return {
    provider: 'claude-code',
    taskId,
    status,
    subagentObservation: {
      kind,
      logicalSubagentId: taskId,
    },
  };
}

function enqueueWrite(data: unknown, writes: string[], value: string) {
  const stamp = captureSubagentObservationGeneration({
    sessionId: SESSION,
    data,
    source: 'claude-code',
  });
  if (!stamp) return Promise.resolve(null);
  return enqueueSubagentObservationWrite({
    sessionId: SESSION,
    stamp,
    enqueue: async () => {
      writes.push(value);
      return value;
    },
  });
}

beforeEach(() => {
  __resetSubagentObservationRewindStateForTesting();
});

afterEach(() => {
  __resetSubagentObservationRewindStateForTesting();
  vi.useRealTimers();
});

describe('Subagent observation Rewind generation fence', () => {
  it('drops Stop/SDK-rollback lifecycle frames that arrive inside a committed Rewind', async () => {
    const writes: string[] = [];
    await expect(enqueueWrite(update('old-task', 'spawn'), writes, 'old-spawn')).resolves.toBe(
      'old-spawn',
    );

    const fence = beginSubagentRewindFence(SESSION);
    primeSubagentRewindFence(fence, [
      { provider: 'claude-code', identities: ['old-task'] },
    ]);
    const lateSpawn = enqueueWrite(update('late-task', 'spawn'), writes, 'late-spawn');
    const lateProgress = enqueueWrite(update('old-task', 'progress'), writes, 'late-progress');
    const lateTerminal = enqueueWrite(update('old-task', 'terminal'), writes, 'late-terminal');

    expect(writes).toEqual(['old-spawn']);
    finishSubagentRewindFence(fence, true);

    await expect(Promise.all([lateSpawn, lateProgress, lateTerminal])).resolves.toEqual([
      null,
      null,
      null,
    ]);
    expect(writes).toEqual(['old-spawn']);
  });

  it('freezes generation when the event is observed, before its durable enqueue runs', async () => {
    const writes: string[] = [];
    const data = update('boundary-task', 'spawn');
    const stamp = captureSubagentObservationGeneration({
      sessionId: SESSION,
      data,
      source: 'claude-code',
    });
    if (!stamp) throw new Error('expected generation stamp');

    const fence = beginSubagentRewindFence(SESSION);
    const pending = enqueueSubagentObservationWrite({
      sessionId: SESSION,
      stamp,
      enqueue: async () => {
        writes.push('boundary-task');
        return 'boundary-task';
      },
    });
    finishSubagentRewindFence(fence, true);

    await expect(pending).resolves.toBeNull();
    expect(writes).toEqual([]);
  });

  it('keeps duplicate/out-of-order old-task frames hidden but accepts a new task after commit', async () => {
    const writes: string[] = [];
    await enqueueWrite(update('old-task', 'spawn'), writes, 'old-spawn');
    const fence = beginSubagentRewindFence(SESSION);
    finishSubagentRewindFence(fence, true);

    await expect(enqueueWrite(update('old-task', 'spawn'), writes, 'old-spawn-again')).resolves.toBeNull();
    await expect(enqueueWrite(update('old-task', 'terminal'), writes, 'old-terminal')).resolves.toBeNull();
    await expect(enqueueWrite(update('old-task', 'progress'), writes, 'old-progress')).resolves.toBeNull();
    await expect(enqueueWrite(update('new-task', 'spawn'), writes, 'premature-new-spawn')).resolves.toBeNull();
    noteSubagentObservationTurnStarted(SESSION);
    await expect(enqueueWrite(update('new-task', 'spawn'), writes, 'new-spawn')).resolves.toBe(
      'new-spawn',
    );
    await expect(enqueueWrite(update('new-task', 'terminal'), writes, 'new-terminal')).resolves.toBe(
      'new-terminal',
    );

    expect(writes).toEqual(['old-spawn', 'new-spawn', 'new-terminal']);
  });

  it('migrates still-visible tasks and preserves their buffered and later terminal updates', async () => {
    const writes: string[] = [];
    await enqueueWrite(update('survivor', 'spawn'), writes, 'survivor-spawn');
    await enqueueWrite(update('withdrawn', 'spawn'), writes, 'withdrawn-spawn');
    const fence = beginSubagentRewindFence(SESSION);
    primeSubagentRewindFence(fence, [
      { provider: 'claude-code', identities: ['survivor'] },
      { provider: 'claude-code', identities: ['withdrawn'] },
    ]);
    const survivorProgress = enqueueWrite(
      update('survivor', 'progress'),
      writes,
      'survivor-progress',
    );
    const survivorTerminal = enqueueWrite(
      update('survivor', 'terminal'),
      writes,
      'survivor-terminal',
    );
    const withdrawnTerminal = enqueueWrite(
      update('withdrawn', 'terminal'),
      writes,
      'withdrawn-terminal',
    );

    finishSubagentRewindFence(fence, true, [
      { provider: 'claude-code', identities: ['survivor'] },
    ]);

    await expect(Promise.all([
      survivorProgress,
      survivorTerminal,
      withdrawnTerminal,
    ])).resolves.toEqual(['survivor-progress', 'survivor-terminal', null]);
    await expect(
      enqueueWrite(update('survivor', 'progress'), writes, 'survivor-late-progress'),
    ).resolves.toBe('survivor-late-progress');
    await expect(
      enqueueWrite(update('withdrawn', 'progress'), writes, 'withdrawn-late-progress'),
    ).resolves.toBeNull();

    expect(writes).toEqual([
      'survivor-spawn',
      'withdrawn-spawn',
      'survivor-progress',
      'survivor-terminal',
      'survivor-late-progress',
    ]);
  });

  it('replays buffered observations in arrival order when Rewind fails', async () => {
    const writes: string[] = [];
    await enqueueWrite(update('task', 'spawn'), writes, 'spawn');
    const fence = beginSubagentRewindFence(SESSION);
    const progress = enqueueWrite(update('task', 'progress'), writes, 'progress');
    const terminal = enqueueWrite(update('task', 'terminal'), writes, 'terminal');

    finishSubagentRewindFence(fence, false);

    await expect(Promise.all([progress, terminal])).resolves.toEqual(['progress', 'terminal']);
    expect(writes).toEqual(['spawn', 'progress', 'terminal']);
  });

  it('applies the same session-local fence to every provider without blocking other sessions', async () => {
    const writes: string[] = [];
    const fence = beginSubagentRewindFence(SESSION);
    const providers = ['claude-code', 'codex', 'pi'] as const;
    const pending = providers.map((provider) => {
        const data = {
          provider,
          taskId: `${provider}-task`,
          status: 'running',
          subagentObservation: { kind: 'spawn', logicalSubagentId: `${provider}-task` },
        };
        const stamp = captureSubagentObservationGeneration({
          sessionId: SESSION,
          data,
          source: provider,
        });
        if (!stamp) return Promise.resolve(null);
        return enqueueSubagentObservationWrite({
          sessionId: SESSION,
          stamp,
          enqueue: async () => {
            writes.push(provider);
            return provider;
          },
        });
    });
    const otherData = update('other-task', 'spawn');
    const otherStamp = captureSubagentObservationGeneration({
      sessionId: 'other-session',
      data: otherData,
      source: 'claude-code',
    });
    if (!otherStamp) throw new Error('expected other session stamp');
    await expect(
      enqueueSubagentObservationWrite({
        sessionId: 'other-session',
        stamp: otherStamp,
        enqueue: async () => {
          writes.push('other-session');
          return 'other-session';
        },
      }),
    ).resolves.toBe('other-session');

    finishSubagentRewindFence(fence, true);

    await expect(Promise.all(pending)).resolves.toEqual([null, null, null]);
    expect(writes).toEqual(['other-session']);
  });

  it('drops buffered writes when a closing session finishes its active Rewind', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const fence = beginSubagentRewindFence(SESSION);
    const pending = enqueueWrite(update('closing-task', 'progress'), writes, 'progress');

    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);
    finishSubagentRewindFence(fence, false);

    await expect(pending).resolves.toBeNull();
    expect(writes).toEqual([]);
    expect(vi.getTimerCount()).toBe(0);
    expect(() => beginSubagentRewindFence(SESSION)).not.toThrow();
  });

  it('bounds deferred cleanup when an active Rewind never finishes', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const fence = beginSubagentRewindFence(SESSION);
    const pending = enqueueWrite(update('stuck-task', 'terminal'), writes, 'terminal');

    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);
    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);
    expect(vi.getTimerCount()).toBe(1);

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(writes).toEqual([]);

    const nextFence = beginSubagentRewindFence(SESSION);
    finishSubagentRewindFence(fence, false);
    finishSubagentRewindFence(nextFence, false);
    expect(clearSubagentObservationRewindState(SESSION)).toBe(true);
  });

  it('lets a rebuilt session replace deferred state before the timeout', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    const staleFence = beginSubagentRewindFence(SESSION);
    const stalePending = enqueueWrite(update('stale-task', 'progress'), writes, 'stale');
    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);

    const freshFence = beginSubagentRewindFence(SESSION);
    await expect(stalePending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    const freshWrite = enqueueWrite(update('fresh-task', 'spawn'), writes, 'fresh');

    finishSubagentRewindFence(staleFence, false);
    finishSubagentRewindFence(freshFence, false);
    await expect(freshWrite).resolves.toBe('fresh');
    expect(writes).toEqual(['fresh']);
  });

  it('lets a rebuilt provider turn replace deferred state before the timeout', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    beginSubagentRewindFence(SESSION);
    const stalePending = enqueueWrite(update('stale-task', 'progress'), writes, 'stale');
    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);

    noteSubagentObservationTurnStarted(SESSION);
    await expect(stalePending).resolves.toBeNull();
    expect(vi.getTimerCount()).toBe(0);
    await expect(enqueueWrite(update('fresh-task', 'spawn'), writes, 'fresh')).resolves.toBe('fresh');
    expect(writes).toEqual(['fresh']);
  });

  it('keeps deferred cleanup isolated to the closing session', async () => {
    vi.useFakeTimers();
    const writes: string[] = [];
    beginSubagentRewindFence(SESSION);
    const pending = enqueueWrite(update('closing-task', 'progress'), writes, 'closing');
    expect(clearSubagentObservationRewindState(SESSION)).toBe(false);

    const otherData = update('other-task', 'spawn');
    const otherStamp = captureSubagentObservationGeneration({
      sessionId: 'other-session',
      data: otherData,
      source: 'claude-code',
    });
    if (!otherStamp) throw new Error('expected other session stamp');
    await expect(
      enqueueSubagentObservationWrite({
        sessionId: 'other-session',
        stamp: otherStamp,
        enqueue: async () => {
          writes.push('other');
          return 'other';
        },
      }),
    ).resolves.toBe('other');

    await vi.runAllTimersAsync();
    await expect(pending).resolves.toBeNull();
    expect(writes).toEqual(['other']);
  });
});
