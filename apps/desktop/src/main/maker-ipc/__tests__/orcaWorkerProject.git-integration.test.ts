import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorktreeMeta } from '../../worktree/types';
import { createWorkerWorktree, resolveWorkerWorktreeSource } from '../orcaWorkerProject';

const worktrees = new Map<string, WorktreeMeta>();

vi.mock('../../maker-host/codex-credential-switch', () => ({
  isCredentialModeSwitchBusyError: () => false,
}));
vi.mock('../../device-link/subscriptions', () => ({}));
vi.mock('../../logger', () => {
  const log = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { createLogger: () => log };
});
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: () => ({}),
}));
vi.mock('../../localDb/client/current', () => ({ getDbClient: () => null }));
vi.mock('../../localDb/ipc/recentWorkdirs', () => ({}));
vi.mock('../../git-context/sessionDirResolver', () => ({}));
vi.mock('../../worktree/worktreeStore', () => ({
  get: (sessionId: string) => worktrees.get(sessionId),
  getAll: () => Array.from(worktrees.values()),
  set: async (sessionId: string, meta: WorktreeMeta) => {
    worktrees.set(sessionId, meta);
  },
  del: async (sessionId: string) => {
    worktrees.delete(sessionId);
  },
  getPendingSafeDirectoryCleanups: () => [],
  addPendingSafeDirectoryCleanups: () => {},
  removePendingSafeDirectoryCleanups: () => {},
}));

/*
 * #11823 / #11828: createWorkerWorktree invoked from a linked worktree must resolve
 * worktree-local revision expressions (@~1, HEAD@{1}, HEAD, HEAD@{0}, @) inside the
 * linked worktree before creating a real managed worktree, so the new Worker branch starts
 * at the linked worktree's commit (not main's) with tracked files fully checked out.
 */
describe('Worker worktree linked-worktree ref resolution', () => {
  let fixture: string;
  let repo: string;
  let linkedWt: string;
  let mainPrevSha: string;
  let mainHeadSha: string;
  let linkedPrevSha: string;
  let linkedHeadSha: string;

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  const commitFile = (cwd: string, name: string, content: string, message: string) => {
    writeFileSync(path.join(cwd, name), content);
    gitIn(cwd, 'add', name);
    gitIn(
      cwd,
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', message,
    );
    return gitIn(cwd, 'rev-parse', 'HEAD');
  };

  beforeAll(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'cindy-worker-linked-ref-'));
    const gitconfig = path.join(fixture, 'gitconfig');
    writeFileSync(gitconfig, '');
    vi.stubEnv('GIT_CONFIG_GLOBAL', gitconfig);
    vi.stubEnv('GIT_CONFIG_NOSYSTEM', '1');

    repo = path.join(fixture, 'repo');
    linkedWt = path.join(fixture, 'linked-wt');
    mkdirSync(repo, { recursive: true });

    gitIn(repo, 'init', '--initial-branch=main');
    const baseSha = commitFile(repo, 'base.txt', 'base\n', 'base commit');
    mainPrevSha = commitFile(repo, 'main-1.txt', 'main 1\n', 'main commit 1');
    mainHeadSha = commitFile(repo, 'main-2.txt', 'main 2\n', 'main commit 2');

    // Linked worktree branches from baseSha and creates two commits so both @~1 and
    // HEAD@{1} resolve cleanly in main and in linkedWt, to different commits in each.
    gitIn(repo, 'worktree', 'add', '-b', 'linked-branch', linkedWt, baseSha);
    linkedPrevSha = commitFile(linkedWt, 'linked-1.txt', 'linked 1\n', 'linked commit 1');
    linkedHeadSha = commitFile(linkedWt, 'linked-2.txt', 'linked 2\n', 'linked commit 2');

    expect(gitIn(repo, 'rev-parse', '@~1')).toBe(mainPrevSha);
    expect(gitIn(repo, 'rev-parse', 'HEAD@{1}')).toBe(mainPrevSha);
    expect(gitIn(linkedWt, 'rev-parse', '@~1')).toBe(linkedPrevSha);
    expect(gitIn(linkedWt, 'rev-parse', 'HEAD@{1}')).toBe(linkedPrevSha);
    expect(linkedPrevSha).not.toBe(mainPrevSha);
    expect(linkedHeadSha).not.toBe(mainHeadSha);
  });

  afterAll(() => {
    worktrees.clear();
    vi.unstubAllEnvs();
    rmSync(fixture, { recursive: true, force: true });
  });

  it('creates real worker worktrees at the linked worktree commit for @~1, HEAD@{1}, HEAD, HEAD@{0}, and @', async () => {
    const cases = [
      ['@~1', linkedPrevSha, 'linked-1.txt'],
      ['HEAD@{1}', linkedPrevSha, 'linked-1.txt'],
      ['HEAD', linkedHeadSha, 'linked-2.txt'],
      ['HEAD@{0}', linkedHeadSha, 'linked-2.txt'],
      ['@', linkedHeadSha, 'linked-2.txt'],
    ] as const;

    for (let i = 0; i < cases.length; i += 1) {
      const [ref, expectedSha, expectedFile] = cases[i]!;
      const sessionId = `acp-linked-${i}`;
      const validatedSource = await resolveWorkerWorktreeSource(linkedWt, ref);
      const workerDir = await createWorkerWorktree(sessionId, linkedWt, validatedSource, { awaitFullCheckout: true });
      expect(gitIn(workerDir, 'rev-parse', 'HEAD')).toBe(expectedSha);
      expect(existsSync(path.join(workerDir, expectedFile))).toBe(true);
      expect(existsSync(path.join(workerDir, 'main-1.txt'))).toBe(false);
    }
  }, 30_000);
});
