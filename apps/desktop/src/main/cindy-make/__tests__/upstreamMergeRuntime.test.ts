import os from 'node:os';
import path from 'node:path';
import { beforeEach, expect, it, vi } from 'vitest';
import type { CindyMakeMergeState } from '../../../shared/cindyMakeMerge';
import type { CindyMakeHistoryRecord, MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';
import type { MakeBuildRollbackEntry } from '../historyStore';
import type { MakeSourceStatus } from '../../../shared/cindyMakeDoctor';
const h = vi.hoisted(() => ({
  saved: null as string | null,
  workspace: false,
  running: false,
  locked: false,
  current: 'owner',
  phase: [] as string[],
  close: vi.fn(async () => {}),
  rollback: vi.fn(async () => {}),
  actualRollback: false,
  receipt: vi.fn(),
  discard: vi.fn(),
  record: undefined as CindyMakeHistoryRecord | undefined,
  rollbackEntries: [] as MakeBuildRollbackEntry[],
  refs: new Map<string, string>(),
  commits: new Map<string, string>(),
  git: vi.fn<(args: string[]) => Promise<string>>(),
  afterReadError: undefined as unknown,
  head: 'c'.repeat(40),
  tree: 'd'.repeat(40),
  dirty: false,
  projected: undefined as CindyMakeMergeState | undefined,
  source: {
    status: 'ready',
    path: 'managed-source',
    channel: 'dev',
    ref: 'main',
  } as MakeSourceStatus,
  fetch: vi.fn(),
}));
vi.mock('electron', () => ({
  app: {
    getPath: () => path.join(os.tmpdir(), 'make-cancel-unit-no-io'),
    isPackaged: true,
    getVersion: () => '1.2.3',
  },
  net: { fetch: h.fetch },
}));
vi.mock('node:fs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:fs')>()),
  existsSync: () => h.workspace,
}));
vi.mock('../../utils/atomicWriteFile.js', () => ({
  readAtomicFileSync: () => h.saved,
  atomicWriteFileSync: (_file: string, raw: string) => {
    h.saved = raw;
  },
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({ ownerScopeKey: h.current }),
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));
vi.mock('../personalBuild.js', () => ({
  personalBuildError: (code: string) => Object.assign(new Error(code), { code }),
}));
vi.mock('../historyOwner.js', () => ({
  captureMakeHistoryStore: () => ({
    receipt: h.receipt,
    read: () => structuredClone(h.record),
    list: () => (h.record ? [structuredClone(h.record)] : []),
    readBuildRollback: () => structuredClone(h.rollbackEntries),
    saveBuildRollback: (entries: MakeBuildRollbackEntry[]) => {
      h.rollbackEntries = structuredClone(entries);
    },
    rollbackReceipt: (_run: string, id: string) => {
      if (h.record?.receipts.at(-1)?.id !== id) throw new Error('Unexpected rollback receipt');
      h.record.receipts.pop();
    },
  }),
}));
vi.mock('../buildRollback.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../buildRollback')>();
  return {
    rollbackUnbuiltHistory: async (...args: Parameters<typeof actual.rollbackUnbuiltHistory>) => {
      h.phase.push('rollback');
      await h.rollback();
      if (h.actualRollback) await actual.rollbackUnbuiltHistory(...args);
    },
  };
});
vi.mock('../sourceContent.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../sourceContent')>()),
  snapshotContent: async () => h.tree,
}));
vi.mock('../versionStore.js', () => ({ hasPublishedPersonalVersionCommit: () => false }));
vi.mock('../toolchainEnvironment.js', () => ({
  createMakeToolchainEnvironment: async () => ({}),
  resolveMakeToolEnvironment: async () => ({}),
}));
vi.mock('../sourcePreparation.js', () => ({ readCurrentCindySourceStatus: async () => h.source }));
vi.mock('../sourceGit.js', () => ({
  runSourceGit: async (_env: unknown, args: string[]) => h.git(args),
}));
vi.mock('../taskRuntime.js', () => ({ validateCindyMakeTaskStart: () => ({}) }));
vi.mock('../../localDb/sessionRouteLock.js', () => ({
  withSessionRouteLock: async (_id: string, run: () => unknown) => run(),
}));
vi.mock('../manager.js', () => ({
  cindyMakeManager: {
    setUpstreamMerge: (state: CindyMakeMergeState) => {
      h.projected = state;
    },
    withProjectUse: async (_root: string, run: () => unknown) => run(),
    withProject: async (_root: string, run: () => unknown) => {
      expect(h.locked).toBe(false);
      h.locked = true;
      try {
        return await run();
      } finally {
        h.locked = false;
      }
    },
    isPreparingSource: () => false,
    refreshSourceStatus: async () => {},
  },
}));
vi.mock('../upstreamMergeSession.js', () => ({
  ensureUpstreamMergeSession: async (
    _root: string,
    _state: unknown,
    _options: unknown,
    bind: (id: string) => void,
  ) => {
    bind('resolver');
    h.running = true;
    return 'resolver';
  },
  assertUpstreamMergeSession: async () => {},
}));
vi.mock('../taskManagement.js', () => ({
  cleanupCompletedMakeMergeTask: async (
    id: string,
    _dir: string,
    current: () => boolean,
    cleanup: (current: () => boolean) => Promise<boolean>,
    stopRunning: boolean,
  ) => {
    expect(id).toBe('resolver');
    expect(stopRunning).toBe(true);
    expect(h.locked).toBe(false);
    h.phase.push('stop');
    await h.close();
    h.running = false;
    return cleanup(current);
  },
}));
vi.mock('../upstreamMerge.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../upstreamMerge')>();
  return {
    ...actual,
    verifyMergeWorktree: async () => {},
    prepareUpstreamMerge: async (_root: string, state: CindyMakeMergeState) => ({
      ...state,
      status: 'merged',
      hasWorkspace: false,
    }),
    prepareFeatureMerge: async (_root: string, state: CindyMakeMergeState) => {
      h.workspace = true;
      return {
        ...state,
        status: 'conflict',
        hasWorkspace: true,
        baselineCommit: 'a'.repeat(40),
        baselineTree: 'b'.repeat(40),
        upstreamCommit: 'a'.repeat(40),
      };
    },
    discardFeatureMerge: async (
      _root: string,
      state: CindyMakeMergeState,
      _git: unknown,
      current: () => boolean,
    ) => {
      expect(h.locked).toBe(true);
      expect(h.running).toBe(false);
      expect(state.cancellationRequested).toBe(true);
      expect(current()).toBe(true);
      h.discard();
      h.phase.push('discard');
      h.workspace = false;
      return true;
    },
  };
});
import {
  configureUpstreamMerge,
  integrateMakeHistory,
  waitForMakeHistoryMerge,
  actUpstreamMerge,
  syncSourceBeforeCindyMakeBuild,
  syncSourceBeforeCindyMakeTask,
  prepareUpstreamMergeTurn,
  interruptUpstreamMergeTurn,
} from '../upstreamMergeRuntime';
beforeEach(() => {
  vi.clearAllMocks();
  h.saved = null;
  h.workspace = false;
  h.running = false;
  h.locked = false;
  h.current = 'owner';
  h.phase = [];
  h.projected = undefined;
  h.source = { status: 'ready', path: 'managed-source', channel: 'dev', ref: 'main' };
  h.fetch.mockReset();
  h.head = 'c'.repeat(40);
  h.tree = 'd'.repeat(40);
  h.dirty = false;
  h.actualRollback = false;
  h.afterReadError = undefined;
  h.refs = new Map();
  h.commits = new Map([
    ['a'.repeat(40), 'b'.repeat(40)],
    [h.head, h.tree],
  ]);
  h.rollbackEntries = [];
  h.record = {
    schema: 1,
    runId: 'run',
    sessionId: 'original',
    title: 'test',
    request: 'test',
    createdAt: 1,
    updatedAt: 1,
    receipts: [],
    completions: [],
    versions: [],
  };
  h.receipt.mockImplementation((_run: string, receipt: MakeFeatureReceipt) => {
    if (!h.record!.receipts.some((entry) => entry.id === receipt.id))
      h.record!.receipts.push(structuredClone(receipt));
  });
  h.git.mockImplementation(async (args) => {
    if (args[0] === 'show-ref') {
      if (args.at(-1)?.endsWith('/after') && h.afterReadError) throw h.afterReadError;
      const value = h.refs.get(args.at(-1)!);
      if (!value) throw Object.assign(new Error('Missing ref'), { exitCode: 1 });
      return value;
    }
    if (args[0] === 'rev-parse') {
      if (args[1] === '--abbrev-ref') return 'cindy-personal';
      if (args[1] === 'HEAD') return h.head;
      const expression = args.at(-1)!;
      const target = expression.replace(/\^\{(?:tree|commit)\}$/, '');
      const value = h.refs.get(target) ?? target;
      if (expression.endsWith('^{commit}') && h.commits.has(value)) return value;
      if (expression.endsWith('^{tree}')) {
        const tree = h.commits.get(value);
        if (tree) return tree;
        if ([...h.commits.values()].includes(value)) return value;
      }
      throw Object.assign(new Error('Invalid Git object'), { exitCode: 128 });
    }
    if (args[0] === 'status') return h.dirty ? ' M preserve-user-edit.txt' : '';
    if (args[0] === 'merge-base') return '';
    if (args[0] === 'update-ref') {
      if (args[1] === '-d') h.refs.delete(args[2]);
      else h.refs.set(args[1], args[2]);
      return '';
    }
    if (args[0] === 'reset' && args[1] === '--keep') {
      h.head = args[2];
      h.tree = h.commits.get(h.head)!;
      return '';
    }
    throw new Error('Unexpected Git command: ' + args.join(' '));
  });
  configureUpstreamMerge(() => h.running);
});
it.each(['dev', 'beta', 'release'] as const)(
  'syncs a packaged personal version using its recorded %s source channel',
  async (channel) => {
    const ref = channel === 'dev' ? 'main' : channel === 'beta' ? 'v2.0.0-beta.1' : 'v2.0.0';
    h.source = { ...h.source, channel, ref };
    if (channel !== 'dev') {
      const release = { draft: false, prerelease: channel === 'beta', tag_name: ref };
      h.fetch.mockResolvedValueOnce(
        new Response(JSON.stringify(channel === 'beta' ? [release] : release)),
      );
    }
    h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'f'.repeat(40) })));
    expect(await actUpstreamMerge({ action: 'update' })).toMatchObject({
      status: 'merged',
      ref,
      upstreamCommit: 'f'.repeat(40),
    });
    const api = 'https://api.github.com/repos/makecindy/cindy';
    expect(h.fetch.mock.calls.map(([url]) => url)).toEqual([
      ...(channel === 'dev'
        ? []
        : [channel === 'beta' ? `${api}/releases?per_page=100&page=1` : `${api}/releases/latest`]),
      `${api}/commits/${ref}`,
    ]);
  },
);
it('uses the same fresh official sync before a task worktree is created', async () => {
  h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'f'.repeat(40) })));
  await syncSourceBeforeCindyMakeTask(new AbortController().signal);
  expect(h.fetch).toHaveBeenCalledOnce();
  expect(h.projected).toMatchObject({
    status: 'merged',
    taskOwned: true,
    upstreamCommit: 'f'.repeat(40),
  });
});
it('stops task preparation when latest source cannot be fetched', async () => {
  h.fetch.mockRejectedValue(new Error('offline'));
  await expect(syncSourceBeforeCindyMakeTask(new AbortController().signal)).rejects.toMatchObject({
    code: 'unavailable',
  });
});
it('publishes source sync as a distinct personal build step', async () => {
  h.fetch.mockResolvedValueOnce(new Response(JSON.stringify({ sha: 'f'.repeat(40) })));
  const publish = vi.fn(async () => {});
  await syncSourceBeforeCindyMakeBuild(new AbortController().signal, publish);
  expect(publish).toHaveBeenCalledWith({ status: 'syncing', syncLatestSource: true });
  expect(h.projected).toMatchObject({
    status: 'merged',
    taskOwned: true,
    upstreamCommit: 'f'.repeat(40),
  });
});
it('reports optional build source sync failures separately from packaging failures', async () => {
  h.fetch.mockRejectedValue(new Error('offline'));
  const publish = vi.fn(async () => {});
  await expect(
    syncSourceBeforeCindyMakeBuild(new AbortController().signal, publish),
  ).rejects.toMatchObject({ code: 'sourceSyncFailed' });
  expect(publish).toHaveBeenCalledWith({ status: 'syncing', syncLatestSource: true });
});
async function conflict() {
  return (await integrateMakeHistory({
    runId: 'run',
    taskSessionId: 'original',
    action: 'integrate',
    taskTree: 'b'.repeat(40),
    steps: [],
    nextStep: 0,
  }))!;
}
it('keeps the stopped build ended when a late dispatch callback or a fresh user message arrives', async () => {
  const state = await conflict();
  const oldDispatch = prepareUpstreamMergeTurn('resolver');
  const waiting = waitForMakeHistoryMerge(
    state,
    new AbortController().signal,
    async () => {},
  ).catch((error) => error);
  await interruptUpstreamMergeTurn('resolver');
  h.running = false;
  oldDispatch?.();
  expect(h.projected).toMatchObject({
    status: 'failed',
    error: 'interrupted',
    sessionId: 'resolver',
    hasWorkspace: true,
  });
  expect(await waiting).toMatchObject({ code: 'interrupted' });
  prepareUpstreamMergeTurn('resolver')?.();
  expect(h.projected?.status).toBe('resolving');
  expect(h.phase).toEqual([]);
  expect(h.workspace).toBe(true);
});
it('holds the build in stopping until its resolver exits, then reclaims and rolls back under the Git lock', async () => {
  const state = await conflict();
  let exit!: () => void;
  h.close.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        exit = resolve;
      }),
  );
  const abort = new AbortController();
  const wait = waitForMakeHistoryMerge(state, abort.signal, async () => {}).catch((error) => error);
  abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  await vi.waitFor(() => expect(h.close).toHaveBeenCalled());
  expect(h.phase).toEqual(['stop']);
  expect(h.workspace).toBe(true);
  exit();
  expect(await wait).toMatchObject({ code: 'cancelled' });
  expect(h.phase).toEqual(['stop', 'discard', 'rollback']);
  expect(h.projected).toMatchObject({
    status: 'cancelled',
    sessionId: 'resolver',
    hasWorkspace: false,
  });
});
it('retries failed rollback after restart even after the candidate directory has gone', async () => {
  const state = await conflict();
  h.rollback.mockRejectedValueOnce(new Error('disk busy'));
  const abort = new AbortController();
  abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  await expect(waitForMakeHistoryMerge(state, abort.signal, async () => {})).rejects.toMatchObject({
    code: 'cleanupFailed',
  });
  expect(h.projected).toMatchObject({
    status: 'failed',
    cancellationRequested: true,
    hasWorkspace: false,
  });
  h.phase = [];
  configureUpstreamMerge(() => h.running);
  expect(h.phase).toEqual([]);
  await actUpstreamMerge({ action: 'cancel', operationId: state.id });
  expect(h.phase).toEqual(['stop', 'discard', 'rollback']);
  expect(h.projected?.status).toBe('cancelled');
});
it('retains the resolver when the application exits without a confirmed cancellation', async () => {
  const state = await conflict();
  const abort = new AbortController();
  abort.abort();
  await expect(waitForMakeHistoryMerge(state, abort.signal, async () => {})).rejects.toBeTruthy();
  expect(h.phase).toEqual([]);
  expect(h.running).toBe(true);
  expect(h.workspace).toBe(true);
});
it.each([false, true])(
  'repairs a missing adoption receipt only if the source has not already rolled back (restored=%s)',
  async (restored) => {
    const state = await conflict();
    const saved = JSON.parse(h.saved!);
    saved.state = {
      ...saved.state,
      cancellationRequested: true,
      status: 'checking',
      commit: 'c'.repeat(40),
      tree: 'd'.repeat(40),
    };
    h.saved = JSON.stringify(saved);
    if (restored) h.head = 'a'.repeat(40);
    configureUpstreamMerge(() => h.running);
    await actUpstreamMerge({ action: 'cancel', operationId: state.id });
    expect(h.receipt).toHaveBeenCalledTimes(restored ? 0 : 1);
    if (!restored)
      expect(h.receipt).toHaveBeenCalledWith(
        'run',
        expect.objectContaining({
          id: state.id,
          commit: 'c'.repeat(40),
          baselineCommit: 'a'.repeat(40),
        }),
      );
    expect(h.projected?.status).toBe('cancelled');
  },
);

function restartUnrecordedCancellation(state: CindyMakeMergeState) {
  const saved = JSON.parse(h.saved!);
  saved.state = { ...saved.state, cancellationRequested: true, status: 'checking' };
  delete saved.state.commit;
  delete saved.state.tree;
  h.saved = JSON.stringify(saved);
  h.refs.set('refs/cindy-make/features/' + state.id + '/after', 'c'.repeat(40));
  configureUpstreamMerge(() => h.running);
}

it.each([false, true])(
  'rolls back adoption after restart when its state and receipt were never saved (integrated ref=%s)',
  async (integrated) => {
    const state = await conflict();
    const integratedRef = 'refs/cindy-make/tasks/run/integrated';
    if (integrated) h.refs.set(integratedRef, state.feature!.taskTree);
    h.actualRollback = true;
    restartUnrecordedCancellation(state);
    await actUpstreamMerge({ action: 'cancel', operationId: state.id });
    expect(h.receipt).toHaveBeenCalledExactlyOnceWith(
      'run',
      expect.objectContaining({
        id: state.id,
        commit: 'c'.repeat(40),
        tree: 'd'.repeat(40),
        baselineCommit: 'a'.repeat(40),
        beforeTree: 'b'.repeat(40),
      }),
    );
    expect(h.receipt.mock.invocationCallOrder[0]).toBeLessThan(
      h.discard.mock.invocationCallOrder[0],
    );
    expect(h.head).toBe('a'.repeat(40));
    expect(h.tree).toBe('b'.repeat(40));
    expect(h.refs.has(integratedRef)).toBe(false);
    expect(h.refs.get('refs/cindy-make/failed-builds/' + 'c'.repeat(40))).toBe('c'.repeat(40));
    expect(h.record?.receipts).toEqual([]);
    expect(h.rollbackEntries).toEqual([]);
    expect(h.projected).toMatchObject({ status: 'cancelled', hasWorkspace: false });
  },
);

it.each([false, true])(
  'does not reinsert the retained adoption after the source was restored (past baseline=%s)',
  async (pastBaseline) => {
    const state = await conflict();
    h.actualRollback = true;
    h.head = pastBaseline ? 'e'.repeat(40) : 'a'.repeat(40);
    h.tree = pastBaseline ? 'f'.repeat(40) : 'b'.repeat(40);
    if (pastBaseline) h.refs.set('refs/cindy-make/failed-builds/' + 'c'.repeat(40), 'c'.repeat(40));
    const head = h.head;
    restartUnrecordedCancellation(state);
    await actUpstreamMerge({ action: 'cancel', operationId: state.id });
    expect(h.receipt).not.toHaveBeenCalled();
    expect(h.head).toBe(head);
    expect(h.git.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(h.projected?.status).toBe('cancelled');
  },
);

it.each([
  'read-error',
  'invalid-object',
  'dirty',
  'advanced-head',
  'changed-tree',
  'receipt-write',
] as const)(
  'retains the cancellation and candidate when adoption recovery cannot finish: %s',
  async (failure) => {
    const state = await conflict();
    restartUnrecordedCancellation(state);
    if (failure === 'read-error')
      h.afterReadError = Object.assign(new Error('Git read failed'), { exitCode: 128 });
    if (failure === 'invalid-object')
      h.refs.set('refs/cindy-make/features/' + state.id + '/after', 'b'.repeat(40));
    if (failure === 'dirty') h.dirty = true;
    if (failure === 'advanced-head') h.head = 'e'.repeat(40);
    if (failure === 'changed-tree') h.tree = 'e'.repeat(40);
    if (failure === 'receipt-write')
      h.receipt.mockImplementationOnce(() => {
        throw new Error('History write failed');
      });
    const head = h.head;
    await expect(
      actUpstreamMerge({ action: 'cancel', operationId: state.id }),
    ).rejects.toMatchObject({
      code: 'PRECONDITION_FAILED',
    });
    expect(h.projected).toMatchObject({
      status: 'failed',
      error: 'cancelFailed',
      cancellationRequested: true,
      hasWorkspace: true,
    });
    expect(h.discard).not.toHaveBeenCalled();
    expect(h.rollback).not.toHaveBeenCalled();
    expect(h.workspace).toBe(true);
    expect(h.head).toBe(head);
  },
);

it('keeps cleanup failure visible when a queued progress update also observes cancellation', async () => {
  const state = await conflict();
  const abort = new AbortController();
  h.rollback.mockRejectedValueOnce(new Error('Cannot restore source'));
  const waiting = waitForMakeHistoryMerge(state, abort.signal, async () => {
    abort.signal.throwIfAborted();
  });
  abort.abort(Object.assign(new Error('cancelled'), { code: 'cancelled' }));
  await expect(waiting).rejects.toMatchObject({ code: 'cleanupFailed' });
  expect(h.projected?.cancellationRequested).toBe(true);
});
