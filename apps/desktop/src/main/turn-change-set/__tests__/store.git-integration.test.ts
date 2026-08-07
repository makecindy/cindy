import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { runGit } from '../../git-review/gitRunner';

const mocks = vi.hoisted(() => ({
  userDataRoot: '',
  query: vi.fn(),
  send: vi.fn(),
  rendererSend: vi.fn(),
  ownerCurrent: true,
  ownerScopeKey: 'owner-a',
}));

vi.mock('electron', () => ({
  app: { getPath: () => mocks.userDataRoot },
  BrowserWindow: {
    getAllWindows: () => [{
      isDestroyed: () => false,
      webContents: { send: mocks.rendererSend },
    }],
  },
}));
vi.mock('../../localDb/client/current.js', () => ({
  getDbClient: () => ({ query: mocks.query }),
}));
vi.mock('../../device-link/broadcast-tap.js', () => ({
  captureDataOwnerBroadcastScope: () => ({
    ownerScopeKey: mocks.ownerScopeKey,
    ownerStamp: undefined,
  }),
  isDataOwnerBroadcastScopeCurrent: (scope: { ownerScopeKey?: string }) =>
    mocks.ownerCurrent && scope.ownerScopeKey === mocks.ownerScopeKey,
  tapWindowBroadcast: mocks.send,
}));

import {
  TurnChangeSetActionError,
  applyTurnChangeSetAction,
  beginTurnChangeSet,
  captureKnownFileBefore,
  clearPendingTurnChangeSets,
  finalizeTurnChangeSet,
  getTurnChangeSets,
  listTurnChangeSets,
  normalizeTurnChangeSetWorkspaceKey,
  noteOpaqueTurnChange,
  noteTurnDiffEvent,
  waitForTurnChangeSetPersistence,
} from '../store';

describe('turn change-set sidecar store', () => {
  let root = '';
  let workdir = '';

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-turn-change-set-'));
    workdir = path.join(root, 'workspace');
    await fs.mkdir(workdir);
    mocks.userDataRoot = path.join(root, 'user-data');
    mocks.query.mockReset();
    mocks.send.mockReset();
    mocks.rendererSend.mockReset();
    mocks.ownerCurrent = true;
    mocks.ownerScopeKey = 'owner-a';
    mocks.query.mockImplementation(async (sql: string, params?: readonly unknown[]) => {
      if (sql.includes('working_dir AS workingDir')) {
        return [{ workingDir: workdir, remoteHostId: null }];
      }
      if (sql.includes('SELECT id FROM sessions')) {
        return [{ id: String(params?.[0] ?? 'session-1') }];
      }
      if (sql.includes('client_id IN')) return [{ clientId: 'user-1' }, { clientId: 'user-2' }];
      return [];
    });
    clearPendingTurnChangeSets('session-1');
    clearPendingTurnChangeSets('session-2');
  });

  afterEach(async () => {
    clearPendingTurnChangeSets('session-1');
    clearPendingTurnChangeSets('session-2');
    await fs.rm(root, { recursive: true, force: true });
  });

  it('persists the native Codex patch under the dispatch anchor without a database write', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-1',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          'index 1111111..2222222 100644',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    finalizeTurnChangeSet('session-1', 'turn-1', 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      anchorClientId: 'user-1',
      provider: 'codex',
      providerTurnId: 'turn-1',
      state: 'complete',
      additions: 1,
      deletions: 1,
    });
  });

  it('drains queued sidecar persistence before shutdown returns', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-shutdown-drain',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });

    void finalizeTurnChangeSet('session-1', 'turn-shutdown-drain', 'complete');
    await waitForTurnChangeSetPersistence();

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ anchorClientId: 'user-1', state: 'complete' });
    const [detail] = await getTurnChangeSets('session-1', [summary!.id]);
    expect(detail?.diffs[0]?.rawPatch).toContain('diff --git a/a.ts b/a.ts');
  });

  it('marks a safely composed Codex subset partial when another file conflict was omitted', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-partial-compose',
        cwd: workdir,
        isComplete: false,
        diff: [
          'diff --git a/safe.ts b/safe.ts',
          '--- a/safe.ts',
          '+++ b/safe.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    finalizeTurnChangeSet('session-1', 'turn-partial-compose', 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['provider-diff-conflict'],
      isReversible: true,
      fileCount: 1,
    });
  });

  it('keeps overlapping same-workspace captures parallel and degrades both to review-only', async () => {
    const target = path.join(workdir, 'shared.txt');
    const workspaceAlias = path.join(root, 'workspace-alias');
    await fs.writeFile(target, 'old\n', 'utf8');
    await fs.symlink(workdir, workspaceAlias, process.platform === 'win32' ? 'junction' : 'dir');
    expect(normalizeTurnChangeSetWorkspaceKey(workspaceAlias))
      .toBe(normalizeTurnChangeSetWorkspaceKey(workdir));

    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'shared.txt',
    });

    // The second dispatch through the workspace alias must not wait for the first
    // session's turn — overlap is marked instead of serialized.
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workspaceAlias,
    });
    await captureKnownFileBefore({
      sessionId: 'session-2',
      provider: 'pi',
      cwd: workspaceAlias,
      targetPath: 'shared.txt',
    });

    await fs.writeFile(target, 'first\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');
    await fs.writeFile(target, 'second\n', 'utf8');
    await finalizeTurnChangeSet('session-2', null, 'complete');

    const [first] = await listTurnChangeSets('session-1');
    const [second] = await listTurnChangeSets('session-2');
    expect(first).toMatchObject({
      state: 'partial',
      incompleteReasons: expect.arrayContaining(['concurrent-workspace']),
      isReversible: false,
    });
    expect(second).toMatchObject({
      state: 'partial',
      incompleteReasons: expect.arrayContaining(['concurrent-workspace']),
      isReversible: false,
    });
    // Captures are still recorded for review even though they overlapped.
    const [firstDetail] = await getTurnChangeSets('session-1', [first!.id]);
    expect(firstDetail?.diffs[0]?.rawPatch).toContain('-old');
    await expect(applyTurnChangeSetAction('session-1', first!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'unsupported' } satisfies Partial<TurnChangeSetActionError>);
  });

  it('does not degrade sequential turns or different workspaces', async () => {
    const target = path.join(workdir, 'seq.txt');
    await fs.writeFile(target, 'a\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'seq.txt',
    });
    await fs.writeFile(target, 'b\n', 'utf8');

    // A concurrent turn in a *different* directory shares nothing.
    const otherDir = path.join(root, 'other-workspace');
    await fs.mkdir(otherDir);
    const otherTarget = path.join(otherDir, 'other.txt');
    await fs.writeFile(otherTarget, 'x\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: otherDir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-2',
      provider: 'pi',
      cwd: otherDir,
      targetPath: 'other.txt',
    });
    await fs.writeFile(otherTarget, 'y\n', 'utf8');

    await finalizeTurnChangeSet('session-1', null, 'complete');
    await finalizeTurnChangeSet('session-2', null, 'complete');

    expect((await listTurnChangeSets('session-1'))[0]).toMatchObject({
      state: 'complete',
      incompleteReasons: [],
      isReversible: true,
    });
    expect((await listTurnChangeSets('session-2'))[0]).toMatchObject({
      state: 'complete',
      incompleteReasons: [],
      isReversible: true,
    });

    // A sequential turn in the same directory (begun after the prior finalize) is
    // untouched by overlap marking.
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-2',
      provider: 'pi',
      cwd: workdir,
      targetPath: 'seq.txt',
    });
    await fs.writeFile(target, 'c\n', 'utf8');
    await finalizeTurnChangeSet('session-2', null, 'complete');
    const sequential = (await listTurnChangeSets('session-2')).find(
      (entry) => entry.cwd === workdir,
    );
    expect(sequential).toMatchObject({
      state: 'complete',
      incompleteReasons: [],
      isReversible: true,
    });
  });

  it('waits for the prior after-image seal instead of marking a non-overlapping dispatch', async () => {
    const target = path.join(workdir, 'seal.txt');
    await fs.writeFile(target, 'before\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'seal.txt',
    });
    await fs.writeFile(target, 'after\n', 'utf8');

    // Finalize is not awaited: the next dispatch must wait for the seal, then see
    // no active capture — no degradation on either side.
    const sealing = finalizeTurnChangeSet('session-1', null, 'complete');
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    });
    await sealing;
    await finalizeTurnChangeSet('session-2', null, 'complete');

    expect((await listTurnChangeSets('session-1'))[0]).toMatchObject({
      state: 'complete',
      incompleteReasons: [],
      isReversible: true,
    });
    expect(await listTurnChangeSets('session-2')).toHaveLength(0);
  });

  it('drops an overlapping turn that never touched files instead of persisting an empty card', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    const target = path.join(workdir, 'busy-work.txt');
    await fs.writeFile(target, 'v1\n', 'utf8');
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'busy-work.txt',
    });
    // Chat-only turn overlapping in the same directory: no captures, no card.
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    });
    await finalizeTurnChangeSet('session-2', null, 'complete');
    await fs.writeFile(target, 'v2\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');

    expect(await listTurnChangeSets('session-2')).toHaveLength(0);
    expect((await listTurnChangeSets('session-1'))[0]).toMatchObject({
      state: 'partial',
      incompleteReasons: expect.arrayContaining(['concurrent-workspace']),
      isReversible: false,
      fileCount: 1,
    });
  });

  it('undoes and reapplies an exact text patch without changing chat history', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-action',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-action', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    const undo = await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('old\n');
    expect(undo).toMatchObject({ action: 'undo', changed: true });
    expect(undo.summary.workspaceState).toBe('undone');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('undone');

    const reapply = await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    expect(reapply.summary.workspaceState).toBe('applied');
  });

  it('keeps a zero-context deletion reviewable without offering unsafe actions', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'head\ntail\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-zero-context-delete',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -2 +1,0 @@',
          '-old',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-zero-context-delete', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    expect(recorded).toMatchObject({ isReversible: false, fileCount: 1 });
    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'unsupported' });
    expect(await fs.readFile(target, 'utf8')).toBe('head\ntail\n');
  });

  it('reports a missing Git executable without changing the workspace', async () => {
    const target = path.join(workdir, 'missing-git.ts');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-missing-git',
        cwd: workdir,
        diff: [
          'diff --git a/missing-git.ts b/missing-git.ts',
          '--- a/missing-git.ts',
          '+++ b/missing-git.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-missing-git', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    const originalPath = process.env.PATH;

    try {
      process.env.PATH = root;
      await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
        .rejects.toMatchObject({ kind: 'git-missing' } satisfies Partial<TurnChangeSetActionError>);
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
    }

    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
  });

  it('keeps every file unchanged when one hunk conflicts', async () => {
    const first = path.join(workdir, 'a.ts');
    const second = path.join(workdir, 'b.ts');
    await fs.writeFile(first, 'new-a\n', 'utf8');
    await fs.writeFile(second, 'new-b\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-conflict',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old-a',
          '+new-a',
          'diff --git a/b.ts b/b.ts',
          '--- a/b.ts',
          '+++ b/b.ts',
          '@@ -1 +1 @@',
          '-old-b',
          '+new-b',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-conflict', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    await fs.writeFile(second, 'user-edit\n', 'utf8');

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'conflict' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(first, 'utf8')).toBe('new-a\n');
    expect(await fs.readFile(second, 'utf8')).toBe('user-edit\n');
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
  });

  it('undoes and reapplies a newly created file for Claude without a Git repository', async () => {
    const target = path.join(workdir, 'created.txt');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'created.txt',
    });
    await fs.writeFile(target, 'created\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('created\n');
  });

  it('undoes and reapplies a deleted file for Pi without a Git repository', async () => {
    const target = path.join(workdir, 'deleted.txt');
    await fs.writeFile(target, 'before deletion\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'pi',
      cwd: workdir,
      targetPath: 'deleted.txt',
    });
    await fs.rm(target);
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('before deletion\n');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    await expect(fs.stat(target)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('preserves a UTF-8 BOM byte-for-byte through Claude undo and reapply', async () => {
    const target = path.join(workdir, 'bom.txt');
    const before = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('old\n')]);
    const after = Buffer.from([0xef, 0xbb, 0xbf, ...Buffer.from('new\n')]);
    await fs.writeFile(target, before);
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'bom.txt',
    });
    await fs.writeFile(target, after);
    await finalizeTurnChangeSet('session-1', null, 'complete');
    const [recorded] = await listTurnChangeSets('session-1');

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(target)).toEqual(before);
    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(target)).toEqual(after);
  });

  it('keeps legacy sidecar patches review-only', async () => {
    const target = path.join(workdir, 'legacy.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-legacy',
        cwd: workdir,
        diff: [
          'diff --git a/legacy.txt b/legacy.txt',
          '--- a/legacy.txt',
          '+++ b/legacy.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-legacy', 'complete');
    const sidecarDir = path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1');
    const indexPath = path.join(sidecarDir, 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ id: string }>;
    };
    index.version = 1;
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');
    const detailPath = path.join(sidecarDir, `${index.entries[0]!.id}.json`);
    const detail = JSON.parse(await fs.readFile(detailPath, 'utf8')) as {
      reversibleFormat?: string;
    };
    delete detail.reversibleFormat;
    await fs.writeFile(detailPath, `${JSON.stringify(detail)}\n`, 'utf8');

    expect((await listTurnChangeSets('session-1'))[0]?.isReversible).toBe(false);
    await expect(applyTurnChangeSetAction('session-1', index.entries[0]!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'unsupported' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
  });

  it('rejects undo while another task is changing the same workspace', async () => {
    const target = path.join(workdir, 'busy.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-busy',
        cwd: workdir,
        diff: [
          'diff --git a/busy.txt b/busy.txt',
          '--- a/busy.txt',
          '+++ b/busy.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-busy', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    await beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    });

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'busy' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    clearPendingTurnChangeSets('session-2');
  });

  it('fails closed before mutation when the data-owner scope is stale', async () => {
    const target = path.join(workdir, 'owner.txt');
    await fs.writeFile(target, 'new\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-owner',
        cwd: workdir,
        diff: [
          'diff --git a/owner.txt b/owner.txt',
          '--- a/owner.txt',
          '+++ b/owner.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-owner', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    mocks.ownerCurrent = false;

    await expect(applyTurnChangeSetAction('session-1', recorded!.id, 'undo'))
      .rejects.toMatchObject({ kind: 'busy' } satisfies Partial<TurnChangeSetActionError>);
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    mocks.ownerCurrent = true;
    expect((await listTurnChangeSets('session-1'))[0]?.workspaceState).toBe('applied');
    expect(mocks.send).not.toHaveBeenCalled();
  });

  it('does not broadcast a completed turn into a newer data-owner scope', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-old-owner',
        cwd: workdir,
        diff: [
          'diff --git a/owner.txt b/owner.txt',
          '--- a/owner.txt',
          '+++ b/owner.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });

    const finalized = finalizeTurnChangeSet('session-1', 'turn-old-owner', 'complete');
    mocks.ownerScopeKey = 'owner-b';
    await finalized;

    expect(await listTurnChangeSets('session-1')).toHaveLength(1);
    expect(mocks.rendererSend).not.toHaveBeenCalled();
  });

  it('reverses and reapplies a pure Codex rename through Git apply', async () => {
    await runGit(['init', '-q'], { cwd: workdir });
    const oldTarget = path.join(workdir, 'old.txt');
    const newTarget = path.join(workdir, 'new.txt');
    await fs.writeFile(oldTarget, 'same\n', 'utf8');
    await runGit(['add', 'old.txt'], { cwd: workdir });
    await fs.rename(oldTarget, newTarget);
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-rename',
        cwd: workdir,
        diff: [
          'diff --git a/old.txt b/new.txt',
          'similarity index 100%',
          'rename from old.txt',
          'rename to new.txt',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-rename', 'complete');
    const [recorded] = await listTurnChangeSets('session-1');
    expect(recorded?.isReversible).toBe(true);

    await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
    expect(await fs.readFile(oldTarget, 'utf8')).toBe('same\n');
    await expect(fs.stat(newTarget)).rejects.toMatchObject({ code: 'ENOENT' });

    await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
    expect(await fs.readFile(newTarget, 'utf8')).toBe('same\n');
    await expect(fs.stat(oldTarget)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('does not advertise a binary-only native patch as reversible', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-binary',
        cwd: workdir,
        diff: [
          'diff --git a/image.png b/image.png',
          'index 1111111..2222222 100644',
          'Binary files a/image.png and b/image.png differ',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-binary', 'complete');

    const [recorded] = await listTurnChangeSets('session-1');
    expect(recorded).toMatchObject({ isReversible: false });
  });

  it('captures only the first preimage for a known-path Claude write', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await fs.writeFile(target, 'middle\n', 'utf8');
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ provider: 'claude-code', state: 'complete' });
    expect(summary?.files[0]).toMatchObject({ path: 'a.ts', additions: 1, deletions: 1 });
  });

  it.runIf(process.platform === 'win32')(
    'deduplicates case-insensitive Windows paths before building an exact patch',
    async () => {
      const target = path.join(workdir, 'Foo.ts');
      await fs.writeFile(target, 'old\n', 'utf8');
      await beginTurnChangeSet({
        sessionId: 'session-1',
        anchorClientId: 'user-1',
        provider: 'claude-code',
        cwd: workdir,
      });
      await captureKnownFileBefore({
        sessionId: 'session-1',
        provider: 'claude-code',
        cwd: workdir,
        targetPath: 'Foo.ts',
      });
      await fs.writeFile(target, 'middle\n', 'utf8');
      await captureKnownFileBefore({
        sessionId: 'session-1',
        provider: 'claude-code',
        cwd: workdir,
        targetPath: 'foo.ts',
      });
      await fs.writeFile(target, 'new\n', 'utf8');
      await finalizeTurnChangeSet('session-1', null, 'complete');

      const [recorded] = await listTurnChangeSets('session-1');
      expect(recorded).toMatchObject({ fileCount: 1, isReversible: true });

      await applyTurnChangeSetAction('session-1', recorded!.id, 'undo');
      expect(await fs.readFile(target, 'utf8')).toBe('old\n');
      await applyTurnChangeSetAction('session-1', recorded!.id, 'reapply');
      expect(await fs.readFile(target, 'utf8')).toBe('new\n');
    },
  );

  it('filters sensitive files from a native Codex patch', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-1',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          'diff --git a/.env b/.env',
          '--- a/.env',
          '+++ b/.env',
          '@@ -1 +1 @@',
          '-TOKEN=old',
          '+TOKEN=new',
          '',
        ].join('\n'),
      },
    });
    finalizeTurnChangeSet('session-1', 'turn-1', 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'partial', incompleteReasons: ['sensitive-file'] });
    expect(summary?.files.map((file) => file.path)).toEqual(['a.ts']);
    const detailRaw = await fs.readFile(
      path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });

  it('labels the captured subset partial after an opaque Pi tool result', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'pi',
      cwd: workdir,
      targetPath: target,
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['opaque-tool'],
      isReversible: true,
    });

    await applyTurnChangeSetAction('session-1', summary!.id, 'undo');
    expect(await fs.readFile(target, 'utf8')).toBe('old\n');
    await applyTurnChangeSetAction('session-1', summary!.id, 'reapply');
    expect(await fs.readFile(target, 'utf8')).toBe('new\n');
  });

  it('reads a v2 partial index with the exact captured-subset capability', async () => {
    const target = path.join(workdir, 'legacy-partial.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: target,
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'claude-code', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const indexPath = path.join(
      mocks.userDataRoot,
      'turn-change-sets',
      'session-1',
      'index.json',
    );
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ isReversible: boolean }>;
    };
    index.version = 2;
    index.entries[0]!.isReversible = false;
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');

    const [legacySummary] = await listTurnChangeSets('session-1');
    expect(legacySummary?.isReversible).toBe(true);
    expect(JSON.parse(await fs.readFile(indexPath, 'utf8'))).toMatchObject({ version: 2 });

    const nextTarget = path.join(workdir, 'next.ts');
    await fs.writeFile(nextTarget, 'before\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: nextTarget,
    });
    await fs.writeFile(nextTarget, 'after\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'complete');
    expect(await listTurnChangeSets('session-1')).toHaveLength(2);

    const upgradedIndex = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ id: string; isReversible: boolean }>;
    };
    expect(upgradedIndex.version).toBe(3);
    expect(upgradedIndex.entries.find((entry) => entry.id === legacySummary!.id))
      .toMatchObject({ isReversible: true });
  });

  it('persists a zero-file partial entry for an opaque tool with unknown targets', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['opaque-tool'],
      fileCount: 0,
      files: [],
      isReversible: false,
    });
  });

  it('drops the change set when a turn fails without any capture activity', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await finalizeTurnChangeSet('session-1', null, 'partial');

    expect(await listTurnChangeSets('session-1')).toHaveLength(0);
  });

  it('drops the change set when a failed turn only touched files without changing them', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'same\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await finalizeTurnChangeSet('session-1', null, 'partial');

    expect(await listTurnChangeSets('session-1')).toHaveLength(0);
  });

  it('persists a partial entry with turn-failed when a failed turn changed files', async () => {
    const target = path.join(workdir, 'a.ts');
    await fs.writeFile(target, 'old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await fs.writeFile(target, 'new\n', 'utf8');
    await finalizeTurnChangeSet('session-1', null, 'partial');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: ['turn-failed'],
      fileCount: 1,
      additions: 1,
      deletions: 1,
    });
  });

  it('hides legacy zero-file turn-failed-only entries persisted by earlier builds', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');
    expect(await listTurnChangeSets('session-1')).toHaveLength(1);

    // Rewrite the sidecar as an earlier build would have persisted a failed turn
    // with no capture activity: zero files, incompleteReasons = ['turn-failed'].
    const sidecarDir = path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1');
    const indexPath = path.join(sidecarDir, 'index.json');
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      version: number;
      entries: Array<{ id: string; incompleteReasons: string[] }>;
    };
    index.entries[0]!.incompleteReasons = ['turn-failed'];
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');

    expect(await listTurnChangeSets('session-1')).toHaveLength(0);
  });

  it('keeps the zero-file partial entry when a failed turn also ran an opaque tool', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'partial');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      incompleteReasons: expect.arrayContaining(['opaque-tool', 'turn-failed']),
      fileCount: 0,
      files: [],
    });
  });

  it.each([
    ['absolute path', 'diff --git /outside.txt /outside.txt'],
    ['parent traversal', 'diff --git a/../escape.txt b/../escape.txt'],
  ])('fails closed for Codex diffs with an unsafe %s', async (_label, header) => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-unsafe-path',
        cwd: workdir,
        diff: [
          header,
          '--- a/../escape.txt',
          '+++ b/../escape.txt',
          '@@ -1 +1 @@',
          '-secret',
          '+leaked',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-unsafe-path', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      fileCount: 0,
      incompleteReasons: ['outside-workspace'],
    });
    const [detail] = await getTurnChangeSets('session-1', [summary!.id]);
    expect(detail?.diffs).toHaveLength(0);
    expect(JSON.stringify(detail)).not.toContain('secret');
  });

  it('fails closed for a malformed Codex diff block while retaining valid blocks', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-malformed-diff',
        cwd: workdir,
        diff: [
          'diff --git',
          '---',
          '+++',
          '',
          'diff --git a/ok.txt b/ok.txt',
          '--- a/ok.txt',
          '+++ b/ok.txt',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-malformed-diff', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({
      state: 'partial',
      fileCount: 1,
      incompleteReasons: ['outside-workspace'],
    });
    expect(summary?.files[0]?.path).toBe('ok.txt');
  });

  it('fails closed when a rename diff oldPath escapes the workspace', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-rename-unsafe',
        cwd: workdir,
        diff: [
          'diff --git a/../secret.txt b/renamed.txt',
          'similarity index 100%',
          'rename from ../secret.txt',
          'rename to renamed.txt',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-rename-unsafe', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary?.fileCount).toBe(0);
    expect(summary?.incompleteReasons).toContain('outside-workspace');
  });

  it('skips local workspace capture locks while remote review is unsupported', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
      remote: true,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
      remote: true,
    });
    noteOpaqueTurnChange({
      sessionId: 'session-1',
      provider: 'pi',
      cwd: workdir,
      remote: true,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-remote',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    }, true);

    let localBeginResolved = false;
    const localBegin = beginTurnChangeSet({
      sessionId: 'session-2',
      anchorClientId: 'user-2',
      provider: 'pi',
      cwd: workdir,
    }).then(() => {
      localBeginResolved = true;
    });
    await vi.waitFor(() => expect(localBeginResolved).toBe(true));
    await localBegin;
    await finalizeTurnChangeSet('session-2', null, 'complete');
    await finalizeTurnChangeSet('session-1', 'turn-remote', 'complete');

    expect(await listTurnChangeSets('session-1')).toEqual([]);
  });

  it('bounds the card index while preserving the complete patch for exact review', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    const diff = Array.from({ length: 55 }, (_, index) => [
      `diff --git a/file-${index}.ts b/file-${index}.ts`,
      `--- a/file-${index}.ts`,
      `+++ b/file-${index}.ts`,
      '@@ -1 +1 @@',
      '-old',
      '+new',
      '',
    ].join('\n')).join('');
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: { turnId: 'turn-many-files', cwd: workdir, diff },
    });
    await finalizeTurnChangeSet('session-1', 'turn-many-files', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'complete', fileCount: 55 });
    expect(summary?.files).toHaveLength(50);
    const [detail] = await getTurnChangeSets('session-1', [summary!.id]);
    expect(detail?.diffs).toHaveLength(55);
  });

  it('matches detail summaries independently of persisted property order', async () => {
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'codex',
      cwd: workdir,
    });
    noteTurnDiffEvent('session-1', {
      type: 'turn_diff',
      source: 'codex',
      data: {
        turnId: 'turn-reordered-summary',
        cwd: workdir,
        diff: [
          'diff --git a/a.ts b/a.ts',
          '--- a/a.ts',
          '+++ b/a.ts',
          '@@ -1 +1 @@',
          '-old',
          '+new',
          '',
        ].join('\n'),
      },
    });
    await finalizeTurnChangeSet('session-1', 'turn-reordered-summary', 'complete');

    const [summary] = await listTurnChangeSets('session-1');
    const indexPath = path.join(
      mocks.userDataRoot,
      'turn-change-sets',
      'session-1',
      'index.json',
    );
    const index = JSON.parse(await fs.readFile(indexPath, 'utf8')) as {
      entries: Array<Record<string, unknown>>;
    };
    const entry = index.entries[0]!;
    const files = (entry.files as Array<Record<string, unknown>>).map((file) =>
      Object.fromEntries(Object.entries(file).reverse()));
    index.entries[0] = Object.fromEntries(
      Object.entries({ ...entry, files }).reverse(),
    );
    await fs.writeFile(indexPath, `${JSON.stringify(index)}\n`, 'utf8');

    const [detail] = await getTurnChangeSets('session-1', [summary!.id]);
    expect(detail).toMatchObject({
      id: summary!.id,
      providerTurnId: 'turn-reordered-summary',
    });
    expect(detail?.diffs).toHaveLength(1);
  });

  it('removes orphan detail files after the next successful index publish', async () => {
    const sidecarDir = path.join(
      mocks.userDataRoot,
      'turn-change-sets',
      'session-1',
    );
    await fs.mkdir(sidecarDir, { recursive: true });
    const orphanPath = path.join(sidecarDir, 'orphan.json');
    await fs.writeFile(orphanPath, '{}\n', 'utf8');

    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'pi',
      cwd: workdir,
    });
    noteOpaqueTurnChange({ sessionId: 'session-1', provider: 'pi', cwd: workdir });
    await finalizeTurnChangeSet('session-1', null, 'complete');

    await expect(fs.stat(orphanPath)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await listTurnChangeSets('session-1')).toHaveLength(1);
  });

  it('never persists sensitive file contents in a captured subset', async () => {
    const safeTarget = path.join(workdir, 'a.ts');
    const secretTarget = path.join(workdir, '.env');
    await fs.writeFile(safeTarget, 'old\n', 'utf8');
    await fs.writeFile(secretTarget, 'TOKEN=old\n', 'utf8');
    await beginTurnChangeSet({
      sessionId: 'session-1',
      anchorClientId: 'user-1',
      provider: 'claude-code',
      cwd: workdir,
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: 'a.ts',
    });
    await captureKnownFileBefore({
      sessionId: 'session-1',
      provider: 'claude-code',
      cwd: workdir,
      targetPath: '.env',
    });
    await fs.writeFile(safeTarget, 'new\n', 'utf8');
    await fs.writeFile(secretTarget, 'TOKEN=new\n', 'utf8');
    finalizeTurnChangeSet('session-1', null, 'complete');

    await vi.waitFor(async () => expect(await listTurnChangeSets('session-1')).toHaveLength(1));
    const [summary] = await listTurnChangeSets('session-1');
    expect(summary).toMatchObject({ state: 'partial', incompleteReasons: ['sensitive-file'] });
    expect(summary?.files.map((file) => file.path)).toEqual(['a.ts']);
    const detailRaw = await fs.readFile(
      path.join(mocks.userDataRoot, 'turn-change-sets', 'session-1', `${summary?.id}.json`),
      'utf8',
    );
    expect(detailRaw).not.toContain('TOKEN=');
  });
});
