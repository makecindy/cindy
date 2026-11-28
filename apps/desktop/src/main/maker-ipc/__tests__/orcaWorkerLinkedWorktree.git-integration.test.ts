import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { WorktreeMeta } from '../../worktree/types';
import '../../worktree/WorktreeManagerPorts.desktop';
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

  /*
   * Test value (docs/dev-rules/engineering-conventions.md §3.2):
   * - Entry and observable result: createWorkerWorktree from a linked worktree with an origin source; the new
   *   Worker starts at the origin default branch as fetched at creation time, not at the stale local ref.
   * - Basis: WorktreeManager refreshes the origin default by ref name only. Resolving every source to a commit ID
   *   inside the linked worktree (#11823) would skip that refresh silently.
   * - Gap: the test above only covers local refs; unit tests mock WorktreeManager and cannot observe the fetch.
   * - Minimal failing input: a linked worktree, origin/main published ahead of the local origin/main ref.
   * - Tier: git-integration (local bare remote, real fetch and worktree add).
   */
  it('keeps refreshing the origin default branch for a remote source created from a linked worktree', async () => {
    const remote = path.join(fixture, 'remote.git');
    const project = path.join(fixture, 'fresh-project');
    const projectLinked = path.join(fixture, 'fresh-linked');
    const publisher = path.join(fixture, 'publisher');
    gitIn(fixture, 'init', '--bare', '--initial-branch=main', remote);
    mkdirSync(project, { recursive: true });
    gitIn(project, 'init', '--initial-branch=main');
    commitFile(project, 'base.txt', 'base\n', 'base commit');
    gitIn(project, 'remote', 'add', 'origin', remote);
    gitIn(project, 'push', '--quiet', 'origin', 'main');
    gitIn(project, 'worktree', 'add', '-b', 'fresh-linked', projectLinked);

    // Another clone publishes a newer origin/main, so the project's origin/main ref is now stale.
    gitIn(fixture, 'clone', '--quiet', remote, publisher);
    const freshSha = commitFile(publisher, 'fresh.txt', 'fresh\n', 'origin commit');
    gitIn(publisher, 'push', '--quiet', 'origin', 'main');
    expect(gitIn(project, 'rev-parse', 'refs/remotes/origin/main')).not.toBe(freshSha);

    const source = await resolveWorkerWorktreeSource(projectLinked, 'origin/main');
    expect(source).toBe('refs/remotes/origin/main');
    const workerDir = await createWorkerWorktree('acp-linked-origin', projectLinked, source, { awaitFullCheckout: true });
    expect(gitIn(workerDir, 'rev-parse', 'HEAD')).toBe(freshSha);
    expect(existsSync(path.join(workerDir, 'fresh.txt'))).toBe(true);
  }, 30_000);

  /*
   * Test value (docs/dev-rules/engineering-conventions.md §3.2):
   * - Entry and observable result: createWorkerWorktree from a linked worktree whose branch shares its name with a tag;
   *   the Worker starts at the branch tip, not at the tag's commit.
   * - Basis: rev-parse prefers a tag over a branch of the same name, so resolving the source inside the linked worktree
   *   (#11823) started the Worker from the tag without any error, where `git worktree add` refuses the ambiguous name.
   * - Gap: the cases above use revision expressions and an origin ref; none has a branch and a tag with one name.
   * - Minimal failing input: branch `feature` ahead of a tag `feature`, with the source omitted (the attached branch)
   *   or given as `feature`.
   * - Tier: git-integration (real refs and a real worktree add).
   */
  it.each([
    ['the attached branch when the source is omitted', undefined],
    ['an explicit short name', 'feature'],
  ] as const)('starts from the branch, not from a tag with the same name: %s', async (_label, explicit) => {
    const key = explicit ?? 'attached';
    const project = path.join(fixture, `tag-project-${key}`);
    const projectLinked = path.join(fixture, `tag-linked-${key}`);
    mkdirSync(project, { recursive: true });
    gitIn(project, 'init', '--initial-branch=main');
    const taggedSha = commitFile(project, 'base.txt', 'base\n', 'tagged commit');
    gitIn(project, 'worktree', 'add', '-b', 'feature', projectLinked, taggedSha);
    const branchTip = commitFile(projectLinked, 'feature.txt', 'feature\n', 'branch commit');
    gitIn(project, 'tag', 'feature', taggedSha);

    const source = await resolveWorkerWorktreeSource(projectLinked, explicit);
    expect(source).toBe('feature');
    const workerDir = await createWorkerWorktree(`acp-linked-tag-${key}`, projectLinked, source, { awaitFullCheckout: true });
    expect(gitIn(workerDir, 'rev-parse', 'HEAD')).toBe(branchTip);
    expect(existsSync(path.join(workerDir, 'feature.txt'))).toBe(true);
  }, 30_000);

  /*
   * Test value (docs/dev-rules/engineering-conventions.md §3.2):
   * - Entry and observable result: createWorkerWorktree from a linked worktree with a fully qualified source; the Worker
   *   starts at that exact ref even when another branch is named like the qualified spelling.
   * - Basis: the branch-over-tag rule above must not prefix a qualified ref again, or `refs/heads/main` would select the
   *   branch `refs/heads/refs/heads/main`.
   * - Gap: the cases above only use short names.
   * - Minimal failing input: `main` at one commit, a branch literally named `refs/heads/main` at another, source `refs/heads/main`.
   * - Tier: git-integration (real refs and a real worktree add).
   */
  it('keeps a fully qualified source exact even when a branch is named like it', async () => {
    const project = path.join(fixture, 'qualified-project');
    const projectLinked = path.join(fixture, 'qualified-linked');
    mkdirSync(project, { recursive: true });
    gitIn(project, 'init', '--initial-branch=main');
    const older = commitFile(project, 'base.txt', 'base\n', 'older commit');
    const mainTip = commitFile(project, 'main.txt', 'main\n', 'main commit');
    gitIn(project, 'worktree', 'add', '-b', 'qualified-linked', projectLinked, older);
    gitIn(project, 'update-ref', 'refs/heads/refs/heads/main', older);

    const source = await resolveWorkerWorktreeSource(projectLinked, 'refs/heads/main');
    expect(source).toBe('refs/heads/main');
    const workerDir = await createWorkerWorktree('acp-linked-qualified', projectLinked, source, { awaitFullCheckout: true });
    expect(gitIn(workerDir, 'rev-parse', 'HEAD')).toBe(mainTip);
    expect(existsSync(path.join(workerDir, 'main.txt'))).toBe(true);
  }, 30_000);
});
