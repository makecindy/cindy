import os from 'node:os';
import path from 'node:path';
import { mkdtempSync, rmSync } from 'node:fs';
import { afterEach, expect, it, vi } from 'vitest';
import { historyBuildRollback } from '../buildRollback';
import { CindyMakeHistoryStore } from '../historyStore';
import type { MakeFeatureReceipt } from '../../../shared/cindyMakeHistory';
import type { ContentGit } from '../sourceContent';

vi.mock('../sourceContent', () => ({
  snapshotContent: (git: ContentGit, source: string) => git(['snapshot'], source),
  contentRef: (git: ContentGit, source: string, ref: string) =>
    git(['ref', ref], source).then((value) => value || undefined),
  taskContentRef: (run: string) => 'refs/cindy-make/tasks/' + run + '/integrated',
}));
const roots: string[] = [];
afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const root = mkdtempSync(path.join(os.tmpdir(), 'cindy-build-rollback-'));
  roots.push(root);
  const store = new CindyMakeHistoryStore(root);
  let head = { commit: 'a'.repeat(40), tree: '1'.repeat(40) };
  let dirty = false;
  const commits = new Map([[head.commit, head.tree]]);
  const refs = new Map<string, string>();
  const git = vi.fn<ContentGit>(async (args) => {
    if (args[0] === 'snapshot') return head.tree;
    if (args[0] === 'status') return dirty ? ' M keep.txt' : '';
    if (args[0] === 'rev-parse') return args[1] === 'HEAD' ? head.commit : 'cindy-personal';
    if (args[0] === 'ref') return refs.get(args[1]) ?? '';
    if (args[0] === 'update-ref') {
      if (args[1] === '-d') refs.delete(args[2]);
      else refs.set(args[1], args[2]);
    }
    if (args[0] === 'reset') head = { commit: args[2], tree: commits.get(args[2])! };
    return '';
  });
  const integrate = (runId: string, id: string, commit: string, tree: string) => {
    store.seed({
      runId,
      sessionId: runId,
      title: runId,
      request: runId,
      createdAt: 1,
      updatedAt: 1,
    });
    const receipt: MakeFeatureReceipt = {
      id,
      action: 'integrate',
      at: commits.size,
      baselineCommit: head.commit,
      beforeTree: head.tree,
      commit: commit.repeat(40),
      tree: tree.repeat(40),
      taskTree: tree.repeat(40),
    };
    store.receipt(runId, receipt);
    refs.set('refs/cindy-make/tasks/' + runId + '/integrated', receipt.taskTree);
    head = { commit: receipt.commit, tree: receipt.tree };
    commits.set(head.commit, head.tree);
    return receipt;
  };
  const rollback = (isPublishedCommit?: (commit: string) => boolean) =>
    historyBuildRollback(store, root, isPublishedCommit).prepareRollback(head, git);
  return {
    store,
    git,
    integrate,
    rollback,
    refs,
    root,
    head: () => head,
    dirty: () => {
      dirty = true;
    },
    advance: () => {
      head = { commit: 'f'.repeat(40), tree: '6'.repeat(40) };
    },
  };
}

it('withdraws consecutive unpublished integrations but keeps the last generated source and task records', async () => {
  const h = fixture();
  const saved = h.integrate('first', 'saved', 'b', '2');
  h.store.version('first', { operationId: saved.id, commit: saved.commit });
  h.integrate('first', 'next-round', 'c', '3');
  h.integrate('second', 'new-task', 'd', '4');
  await h.rollback()();
  expect(h.head()).toEqual({ commit: saved.commit, tree: saved.tree });
  expect(h.store.read('first')?.receipts).toEqual([saved]);
  expect(h.store.read('second')?.receipts).toEqual([]);
  expect(h.store.list()).toHaveLength(2);
  expect(h.refs.get('refs/cindy-make/tasks/first/integrated')).toBe(saved.taskTree);
  expect(h.refs.has('refs/cindy-make/tasks/second/integrated')).toBe(false);
  expect(h.refs.get('refs/cindy-make/failed-builds/' + 'd'.repeat(40))).toBe('d'.repeat(40));
  expect(h.store.readBuildRollback()).toEqual([]);
});

it('resumes cleanup after Git has restored the source but persisting history failed', async () => {
  const h = fixture();
  h.integrate('task', 'operation', 'b', '2');
  const real = h.store.rollbackReceipt.bind(h.store);
  vi.spyOn(h.store, 'rollbackReceipt')
    .mockImplementationOnce(() => {
      throw new Error('disk busy');
    })
    .mockImplementation(real);
  await expect(h.rollback()()).rejects.toThrow('disk busy');
  expect(h.head().commit).toBe('a'.repeat(40));
  expect(h.store.readBuildRollback()).toHaveLength(1);
  const reopened = new CindyMakeHistoryStore(h.root);
  await historyBuildRollback(reopened, h.root).recoverRollback(h.git);
  expect(reopened.readBuildRollback()).toEqual([]);
  expect(reopened.read('task')?.receipts).toEqual([]);
  expect(h.git.mock.calls.filter(([args]) => args[0] === 'reset')).toHaveLength(1);
});

it.each(['dirty', 'advance'] as const)(
  'preserves source edits made during packaging: %s',
  async (change) => {
    const h = fixture();
    const receipt = h.integrate('task', 'operation', 'b', '2');
    const rollback = h.rollback();
    h[change]();
    await expect(rollback()).rejects.toThrow('Personal source changed');
    expect(h.git.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
    expect(h.store.read('task')?.receipts).toEqual([receipt]);
    expect(h.store.readBuildRollback()).toHaveLength(1);
  },
);

it('checks saved versions again before touching Git during recovery', async () => {
  const h = fixture();
  const receipt = h.integrate('task', 'operation', 'b', '2');
  const rollback = h.rollback();
  h.store.version('task', { operationId: receipt.id, commit: receipt.commit });
  await expect(rollback()).rejects.toThrow('Integration changed');
  expect(h.git.mock.calls.some(([args]) => args[0] === 'reset')).toBe(false);
});

it('does not roll past a saved version whose latest integration changed no files', async () => {
  const h = fixture();
  h.integrate('first', 'first-operation', 'b', '2');
  const saved = h.integrate('second', 'no-change', 'b', '2');
  h.store.version('second', { operationId: saved.id, commit: saved.commit });
  await h.rollback()();
  expect(h.head().commit).toBe(saved.commit);
  expect(h.git).not.toHaveBeenCalled();
});

it('does not roll back a published snapshot whose history registration was interrupted', async () => {
  const h = fixture();
  const published = h.integrate('task', 'published-operation', 'b', '2');
  await h.rollback((commit) => commit === published.commit)();
  expect(h.head()).toEqual({ commit: published.commit, tree: published.tree });
  expect(h.store.read('task')?.receipts).toEqual([published]);
  expect(h.git).not.toHaveBeenCalled();
});
