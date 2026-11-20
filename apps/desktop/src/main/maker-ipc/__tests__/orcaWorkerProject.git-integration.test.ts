import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { awaitBackgroundCheckout, createWorktree } from '../../worktree/WorktreeManager';
import { createWorkerWorktree } from '../orcaWorkerProject';

vi.mock('../../maker-host/codex-credential-switch', () => ({
  isCredentialModeSwitchBusyError: () => false,
}));
vi.mock('../../device-link/subscriptions', () => ({}));
vi.mock('electron', () => ({ app: {} }));
vi.mock('../../logger', () => {
  const log = { warn: vi.fn() };
  return { createLogger: () => log };
});
vi.mock('../../maker-host/override-settings-file', () => ({
  createOverrideSettingsFile: () => ({}),
}));
vi.mock('../../localDb/client/current', () => ({}));
vi.mock('../../localDb/ipc/recentWorkdirs', () => ({}));
vi.mock('../../git-context/sessionDirResolver', () => ({}));
vi.mock('../../worktree/WorktreeManager', () => ({
  createWorktree: vi.fn(),
  getForSession: vi.fn(),
  awaitBackgroundCheckout: vi.fn(),
}));

/*
 * #11823: createWorkerWorktree invoked from a linked worktree must resolve worktree-local
 * revision expressions (HEAD, HEAD@{0}, @, @~1) inside the linked worktree rather than
 * passing them verbatim to baseRepo. Real linked-worktree ref resolution requires git-integration.
 */
describe('Worker worktree linked-worktree ref resolution', () => {
  let fixture: string;
  let repo: string;
  let linkedWt: string;
  let target: string;
  let mainSha: string;
  let linkedSha: string;

  const gitIn = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

  beforeAll(() => {
    fixture = mkdtempSync(path.join(os.tmpdir(), 'cindy-worker-linked-ref-'));
    repo = path.join(fixture, 'repo');
    linkedWt = path.join(fixture, 'linked-wt');
    target = path.join(fixture, 'acp-wt');
    mkdirSync(repo, { recursive: true });
    mkdirSync(target, { recursive: true });

    gitIn(repo, 'init', '--initial-branch=main');
    writeFileSync(path.join(repo, 'base.txt'), 'base commit\n');
    gitIn(repo, 'add', 'base.txt');
    gitIn(
      repo,
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'base commit',
    );
    mainSha = gitIn(repo, 'rev-parse', 'HEAD');

    gitIn(repo, 'worktree', 'add', '-b', 'linked-branch', linkedWt, 'HEAD');
    writeFileSync(path.join(linkedWt, 'linked.txt'), 'linked commit\n');
    gitIn(linkedWt, 'add', 'linked.txt');
    gitIn(
      linkedWt,
      '-c', 'user.name=Fixture',
      '-c', 'user.email=fixture@example.invalid',
      '-c', 'commit.gpgsign=false',
      'commit', '-m', 'linked commit',
    );
    linkedSha = gitIn(linkedWt, 'rev-parse', 'HEAD');
    expect(linkedSha).not.toBe(mainSha);
  });

  afterAll(() => {
    rmSync(fixture, { recursive: true, force: true });
  });

  it('resolves worktree-local refs inside the linked worktree before creating the worker worktree', async () => {
    vi.mocked(createWorktree).mockResolvedValue({
      ok: true,
      meta: { path: target, branch: 'cindy/acp', baseRepo: repo },
    } as never);
    vi.mocked(awaitBackgroundCheckout).mockReset();

    for (const [ref, expectedSha] of [
      ['HEAD', linkedSha],
      ['HEAD@{0}', linkedSha],
      ['@', linkedSha],
      ['@~1', mainSha],
    ] as const) {
      expect(await createWorkerWorktree('acp-linked', linkedWt, ref, { awaitFullCheckout: true })).toBe(target);
      const calls = vi.mocked(createWorktree).mock.calls;
      const [req, opts] = calls[calls.length - 1]!;
      expect(path.resolve(req.baseRepo)).toBe(path.resolve(repo));
      expect(req).toMatchObject({
        sessionId: 'acp-linked',
        name: '',
        sourceBranch: expectedSha,
      });
      expect(opts).toEqual({ trackBackgroundCheckout: true, awaitFullCheckout: true });
    }
    expect(awaitBackgroundCheckout).not.toHaveBeenCalled();
  });
});
