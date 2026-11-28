import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { probeWorkerProject } from '../orcaWorkerProject';

vi.mock('electron', () => ({ app: {} }));
vi.mock('../../logger', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../../maker-host/override-settings-file', () => ({ createOverrideSettingsFile: () => ({}) }));
vi.mock('../../localDb/client/current', () => ({}));
vi.mock('../../localDb/ipc/recentWorkdirs', () => ({}));
vi.mock('../../git-context/sessionDirResolver', () => ({}));
vi.mock('../../worktree/WorktreeManager', () => ({}));

// N07/N09 + CI #12846: preserve the original real-Git HEAD matrix through the
// production probe AND gitExec (including its 5s budget). The old unit fixture
// replaced gitExec with unbounded execFileSync; a timed-out HEAD case continued
// calling the alias case's shared spy. Separate tier/lifecycle prevents that
// contamination without deleting the real-Git semantics or extending timeouts.
// Minimal input: empty repo -> first commit (probe via a subproject alias) ->
// detached HEAD. Retain real Git root discovery from the old subproject fixture.
// No credentials or network; all generated files stay in one temporary fixture. Unit porcelain
// cases cannot establish what Git actually emits, so retain this integration.
const exec = promisify(execFile);
let root: string;
let directory: string;
let running: Promise<void> | undefined;
beforeAll(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), 'cindy-worker-head-'));
  directory = path.join(root, 'repo');
  await mkdir(directory);
});
afterAll(async () => {
  // Vitest timing out does not cancel an async test. Drain its bounded Git work
  // before removing the fixture, even when the case has already been reported.
  await running?.catch(() => {});
  if (root) await rm(root, { recursive: true, force: true });
});

async function checkHeadStates(): Promise<void> {
  const git = async (...args: string[]) => (await exec('git', args, {
    cwd: directory, encoding: 'utf8', windowsHide: true, timeout: 5000,
  })).stdout.trim();
  await git('init', '--initial-branch=main');
  await writeFile(path.join(directory, 'file.txt'), 'worker\n');
  expect(await probeWorkerProject(directory)).toMatchObject({
    exists: true, headState: 'unborn', branch: null, dirty: true,
  });
  await git('add', 'file.txt');
  await git('-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    '-c', 'commit.gpgsign=false', 'commit', '-m', 'fixture');
  const subproject = path.join(directory, 'apps', 'web');
  const alias = path.join(root, 'repo-alias');
  await mkdir(subproject, { recursive: true });
  await symlink(directory, alias, process.platform === 'win32' ? 'junction' : 'dir');
  expect(await probeWorkerProject(path.join(alias, 'apps', 'web'))).toMatchObject({
    headState: 'branch', branch: 'main', dirty: false,
    checkoutRoot: await realpath(directory), realDirectory: await realpath(subproject),
  });
  const sha = await git('rev-parse', 'HEAD');
  await git('checkout', '--detach', '--quiet', sha);
  expect(await probeWorkerProject(directory)).toMatchObject({
    headState: 'detached', branch: sha, dirty: false,
  });
}

it('distinguishes an unborn HEAD, a branch and a detached commit while retaining dirty status', () => {
  running = checkHeadStates();
  return running;
});
