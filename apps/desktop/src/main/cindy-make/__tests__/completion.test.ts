import type { AgentEvent } from '@cindy/maker-core';
import { describe, expect, it, vi } from 'vitest';

import {
  CINDY_MAKE_COMMIT_AUTHOR,
  commitCindyMakeChanges,
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

  it('treats a terminal error as the end of the turn', async () => {
    const { session, emit } = fakeSession();
    const persist = vi.fn(async () => undefined);
    const tracker = createCindyMakeCompletionTracker({
      getSession: () => session,
      collectFacts: async () => ({}),
      persist,
      logger: { warn: vi.fn() },
    });
    await tracker.report('make-3');
    emit({ type: 'error', data: { willRetry: true } } as AgentEvent);
    await flush();
    expect(persist).not.toHaveBeenCalled();
    emit({ type: 'error', data: { isTerminal: true } } as AgentEvent);
    await flush();
    expect(persist).toHaveBeenCalledTimes(1);
  });
});

describe('commitCindyMakeChanges', () => {
  it('commits the worktree with a fixed identity and reports the new commit', async () => {
    let head = 'aaaaaaa1111';
    const git = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'cindy-make/run-1\n';
      if (args[0] === 'status') return ' M a.ts\n?? b.ts\n\n';
      if (args[0] === 'add') return '';
      if (args.includes('commit')) {
        head = 'bbbbbbb2222';
        return '';
      }
      if (args[0] === 'rev-parse') return `${head}\n`;
      throw new Error(`unexpected ${args.join(' ')}`);
    });
    await expect(commitCindyMakeChanges(git, 'Cindy Make: 修复闪烁')).resolves.toEqual({
      branch: 'cindy-make/run-1',
      changedFiles: 2,
      commit: 'bbbbbbb2222',
    });
    const commitCall = git.mock.calls.map(([args]) => args).find((args) => args.includes('commit'));
    expect(commitCall).toEqual(
      expect.arrayContaining([
        `user.name=${CINDY_MAKE_COMMIT_AUTHOR}`,
        '--no-verify',
        '--message',
        'Cindy Make: 修复闪烁',
      ]),
    );
    expect(git).toHaveBeenCalledWith(['add', '--all']);
  });

  it('does not commit when nothing changed and keeps whichever answer Git can still give', async () => {
    const clean = vi.fn(async (args: string[]) => {
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'HEAD';
      if (args[0] === 'status') return '';
      if (args[0] === 'rev-parse') return 'abcdef1234567';
      throw new Error('unexpected');
    });
    await expect(commitCindyMakeChanges(clean, 'msg')).resolves.toEqual({
      changedFiles: 0,
      commit: 'abcdef1234567',
    });
    expect(clean.mock.calls.some(([args]) => args.includes('commit'))).toBe(false);

    const broken = vi.fn(async (args: string[]) => {
      if (args[0] === 'status' || args[1] === '--abbrev-ref') throw new Error('not a repo');
      return 'not-a-hash';
    });
    await expect(commitCindyMakeChanges(broken, 'msg')).resolves.toEqual({});
  });
});
