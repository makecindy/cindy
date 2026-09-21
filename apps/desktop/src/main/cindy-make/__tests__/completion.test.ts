import type { AgentEvent } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  collectCindyMakeChanges,
  createCindyMakeCompletionTracker,
  type CindyMakeCompletionSession,
} from '../completion';

function fakeSession(running = true) {
  const listeners = new Set<(event: AgentEvent) => void>();
  const session: CindyMakeCompletionSession = {
    isTurnRunning: () => running,
    onEvent: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    session,
    emit: (event: AgentEvent) => listeners.forEach((listener) => listener(event)),
    listenerCount: () => listeners.size,
  };
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('cindy_make completion tracker', () => {
  it('persists the record only after the running turn ends, once', async () => {
    const { session, emit, listenerCount } = fakeSession();
    const persist = vi.fn(async () => undefined);
    const collectFacts = vi.fn(async () => ({
      changedFiles: 3,
      commit: 'abcdef1234',
      branch: 'cindy-make/run-1',
    }));
    const tracker = createCindyMakeCompletionTracker({
      getSession: () => session,
      collectFacts,
      persist,
      logger: { warn: vi.fn() },
      now: () => 1234,
    });

    await tracker.report('make-1');
    await tracker.report('make-1');
    expect(tracker.isPending('make-1')).toBe(true);
    expect(persist).not.toHaveBeenCalled();
    expect(listenerCount()).toBe(1);

    emit({ type: 'text', data: { text: 'summary' } } as AgentEvent);
    expect(persist).not.toHaveBeenCalled();

    emit({ type: 'done', data: {} } as AgentEvent);
    await flush();
    expect(collectFacts).toHaveBeenCalledWith('make-1');
    expect(persist).toHaveBeenCalledTimes(1);
    expect(persist).toHaveBeenCalledWith('make-1', {
      changedFiles: 3,
      commit: 'abcdef1234',
      branch: 'cindy-make/run-1',
      reportedAt: 1234,
    });
    expect(tracker.isPending('make-1')).toBe(false);
    expect(listenerCount()).toBe(0);
  });

  it('persists immediately when no turn is running and tolerates missing facts', async () => {
    const { session } = fakeSession(false);
    const persist = vi.fn(async () => undefined);
    const warn = vi.fn();
    const tracker = createCindyMakeCompletionTracker({
      getSession: () => session,
      collectFacts: async () => {
        throw new Error('git missing');
      },
      persist,
      logger: { warn },
      now: () => 99,
    });
    await tracker.report('make-2');
    expect(persist).toHaveBeenCalledWith('make-2', { reportedAt: 99 });
    expect(warn).toHaveBeenCalled();
  });

  it('does not commit or publish completion when the turn ends with an error after reporting', async () => {
    const { session, emit } = fakeSession();
    const persist = vi.fn(async () => undefined);
    const collectFacts = vi.fn(async () => ({}));
    const tracker = createCindyMakeCompletionTracker({
      getSession: () => session,
      collectFacts,
      persist,
      logger: { warn: vi.fn() },
    });
    await tracker.report('make-3');
    emit({ type: 'error', data: { willRetry: true } } as AgentEvent);
    await flush();
    expect(persist).not.toHaveBeenCalled();
    emit({ type: 'error', data: { isTerminal: true } } as AgentEvent);
    await flush();
    expect(persist).not.toHaveBeenCalled();
    expect(collectFacts).not.toHaveBeenCalled();
    expect(tracker.isPending('make-3')).toBe(false);
  });

  it.each([
    { status: 'cancelled' },
    { status: 'interrupted' },
    { status: 'failed' },
    { is_error: true },
  ])('does not commit a reported change after an unsuccessful done: %j', async (data) => {
    const { session, emit, listenerCount } = fakeSession();
    const collectFacts = vi.fn(async () => ({}));
    const persist = vi.fn(async () => undefined);
    const tracker = createCindyMakeCompletionTracker({
      getSession: () => session,
      collectFacts,
      persist,
      logger: { warn: vi.fn() },
    });
    await tracker.report('make-stopped');
    emit({ type: 'done', data } as AgentEvent);
    await flush();
    expect(collectFacts).not.toHaveBeenCalled();
    expect(persist).not.toHaveBeenCalled();
    expect(tracker.isPending('make-stopped')).toBe(false);
    expect(listenerCount()).toBe(0);

    // A later successful turn must explicitly report its own completion.
    emit({ type: 'done', data: {} } as AgentEvent);
    await flush();
    expect(collectFacts).not.toHaveBeenCalled();
    await tracker.report('make-stopped');
    emit({ type: 'done', data: {} } as AgentEvent);
    await flush();
    expect(collectFacts).toHaveBeenCalledOnce();
    expect(persist).toHaveBeenCalledOnce();
  });
});

describe('completion branch protection', () => {
  it.each(['main', 'cindy-personal', 'HEAD', 'cindy-make/another'])(
    'refuses to snapshot an unexpected branch: %s',
    async (branch) => {
      const git = vi.fn(async () => branch);
      await expect(
        collectCindyMakeChanges(git, 'profile', 'profile/cindy-make/worktrees/run'),
      ).rejects.toThrow('Unexpected Cindy Make worktree');
      expect(git).toHaveBeenCalledTimes(1);
    },
  );
});
