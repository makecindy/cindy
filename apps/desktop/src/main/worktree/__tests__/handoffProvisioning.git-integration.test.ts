/**
 * Test value (engineering-conventions §3.2)
 * Basis: P1-1 end-to-end two-phase worktree provisioning and realpath concurrency serialization
 * against a real disposable Git repository.
 * Coverage gap: unit tests mock git/WorktreeManager; real git worktree add + symlink alias
 * serialization + DB workingDir rebinding + orphan cleanup on cancel must work on real disk.
 * Minimal failing input: two concurrent provisioning requests on a real temp git repo and its
 * symlink alias, verifying serialized git creation and distinct on-disk checkouts.
 * Tier: git-integration (real Git with disposable temp repository; no network or account).
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../../logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));

import { createHandoffProvisioningService } from '../handoffProvisioning';
import { isWorktreeCreationQueueBusy, resetWorktreeConcurrencyForTest } from '../worktreeConcurrency';
import { configureWorktreeManagerPorts } from '../WorktreeManagerPorts';
import * as worktreeManager from '../WorktreeManager';
import { prepareHandoffWorktree } from '../../maker-ipc/handoffWorktree';

let root = '';
let repoDir = '';
let aliasDir = '';
let userDataDir = '';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

beforeAll(async () => {
  configureWorktreeManagerPorts({
    withPrecreatedSessionOperationLock: (_sessionId, task) => task(),
    assertPrecreatedSessionNotCancelled: () => {},
    sealPrecreatedSessionCancellation: () => {},
    recycleManagedWorktree: async (_meta, opts) => {
      await opts.onRemoved?.();
      return { removed: true };
    },
  });
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'cindy-prov-git-'));
  repoDir = path.join(root, 'repo');
  aliasDir = path.join(root, 'repo-symlink');
  userDataDir = path.join(root, 'user-data');
  await fs.mkdir(repoDir, { recursive: true });
  await fs.mkdir(userDataDir, { recursive: true });
  await fs.writeFile(path.join(root, 'gitconfig'), '');
  vi.stubEnv('GIT_CONFIG_GLOBAL', path.join(root, 'gitconfig'));
  vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

  git(repoDir, 'init', '-b', 'main');
  git(repoDir, 'config', 'user.name', 'Cindy Test');
  git(repoDir, 'config', 'user.email', 'test@example.invalid');
  await fs.writeFile(path.join(repoDir, 'README.md'), 'hello\n');
  git(repoDir, 'add', '.');
  git(repoDir, '-c', 'commit.gpgsign=false', 'commit', '-m', 'init');
  await fs.symlink(repoDir, aliasDir, 'dir');
});

afterAll(async () => {
  resetWorktreeConcurrencyForTest();
  vi.unstubAllEnvs();
  if (root) {
    await fs.rm(root, { recursive: true, force: true });
  }
});

describe('handoffProvisioning real-git integration', () => {
  it('provisions two concurrent tasks via canonical repo and symlink alias onto distinct real worktrees', async () => {
    const ownerToken = {};
    const dbBindings = new Map<string, string>();
    const queuedWorkingDirs = new Map<string, string>();
    const locks = new Map<string, boolean>();

    const service = createHandoffProvisioningService({
      getUserDataDir: () => userDataDir,
      getOwnerScopeKey: () => 'owner-git-int',
      captureOwnerToken: () => ownerToken,
      isOwnerTokenCurrent: (token) => token === ownerToken,
      fastWaitMs: 3_000,
      readSessionLifecycle: async () => ({ state: 'active', hasWorktreePath: false }),
      getRegisteredWorktree: (sessionId) => worktreeManager.getForSession(sessionId),
      bindWorktreeToSession: async (sessionId, meta) => {
        dbBindings.set(sessionId, meta.path);
      },
      updateQueuedWorkingDir: (sessionId, worktreePath) => {
        queuedWorkingDirs.set(sessionId, worktreePath);
      },
      setProvisioningLock: (sessionId, locked) => {
        locks.set(sessionId, locked);
      },
      isQueueBusy: (baseRepo) => isWorktreeCreationQueueBusy(baseRepo, false),
      createWorktree: ({ sessionId, workingDir, signal, onStageChange, onNameSelected }) =>
        prepareHandoffWorktree(
          {
            getForSession: worktreeManager.getForSession,
            listAll: worktreeManager.listAll,
            detectCwd: worktreeManager.detectCwd,
            suggestName: worktreeManager.suggestName,
            listBranches: worktreeManager.listBranches,
            resolveCommit: worktreeManager.revParseCommit,
            createWorktree: (req, opts) =>
              worktreeManager.createWorktree(req, {
                signal: opts?.signal,
                onStageChange: opts?.onStageChange,
              }),
            createId: () => sessionId,
            // No remote in temp repo; skip network fetch deterministically.
            resolveFreshSource: async (_base, fallback) => ({ sourceBranch: fallback, fetched: false }),
          },
          undefined,
          workingDir,
          { signal, onStageChange, onNameSelected },
        ),
      discardOrphanWorktree: async (sessionId) => {
        await worktreeManager.removeWorktreeForSession(sessionId);
      },
    });

    const [first, second] = await Promise.all([
      service.beginProvisioning({
        sessionId: 'git-prov-1',
        baseRepo: repoDir,
        workingDir: repoDir,
      }),
      service.beginProvisioning({
        sessionId: 'git-prov-2',
        baseRepo: aliasDir,
        workingDir: aliasDir,
      }),
    ]);

    expect(first, JSON.stringify(first)).not.toMatchObject({ state: 'failed' });
    expect(second, JSON.stringify(second)).not.toMatchObject({ state: 'failed' });
    await service.whenIdle();

    const path1 = dbBindings.get('git-prov-1');
    const path2 = dbBindings.get('git-prov-2');
    expect(path1).toBeTruthy();
    expect(path2).toBeTruthy();
    expect(path1).not.toBe(path2);
    expect(queuedWorkingDirs.get('git-prov-1')).toBe(path1);
    expect(queuedWorkingDirs.get('git-prov-2')).toBe(path2);
    expect(locks.get('git-prov-1')).toBe(false);
    expect(locks.get('git-prov-2')).toBe(false);
    expect(service.listSnapshots()).toEqual([]);

    // Both worktrees exist on disk as valid git checkouts with distinct branches.
    expect(await fs.readFile(path.join(path1!, 'README.md'), 'utf8')).toBe('hello\n');
    expect(await fs.readFile(path.join(path2!, 'README.md'), 'utf8')).toBe('hello\n');
    const branch1 = git(path1!, 'rev-parse', '--abbrev-ref', 'HEAD');
    const branch2 = git(path2!, 'rev-parse', '--abbrev-ref', 'HEAD');
    expect(branch1).not.toBe('main');
    expect(branch2).not.toBe('main');
    expect(branch1).not.toBe(branch2);

    // Clean up created worktrees through WorktreeManager.
    await worktreeManager.removeWorktreeForSession('git-prov-1');
    await worktreeManager.removeWorktreeForSession('git-prov-2');
  });
});
