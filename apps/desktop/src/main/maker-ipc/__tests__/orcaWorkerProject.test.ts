import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { gitExec } from '../../worktree/gitExec';
import { createWorktree, awaitBackgroundCheckout, getForSession } from '../../worktree/WorktreeManager';
import { createLogger } from '../../logger';
import { MAKER_INVOKE } from '../channels';
import { isDeviceLinkInvoke, runDeviceLinkInvokeContext } from '../../device-link/invoke-context';
import {
  createWorkerWorktree,
  resolveWorkerWorktreeSource,
  resolveWorkerWorktreeSourceSelection,
  getWorkerOwnedWorktree,
  probeWorkerProject,
  readWorkerProjectContext,
} from '../orcaWorkerProject';
import { createOrcaWorkerProjectHandlers } from '../orcaWorkerProjectHandlers';

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
// Keep the production probe and Git output real; isolate unrelated process/runtime services.
vi.mock('../../worktree/gitExec', () => ({
  gitExec: vi.fn(async (args: string[], cwd: string) => ({
    stdout: execFileSync('git', args, { cwd, encoding: 'utf8' }),
    stderr: '',
  })),
}));

const directory = mkdtempSync(path.join(os.tmpdir(), 'cindy-worker-head-'));
afterAll(() => rmSync(directory, { recursive: true, force: true }));

// N07/N09: existing inheritance tests inject probes and miss actual Git HEAD states.
// Integration tier: an empty repo, its first commit, then detached HEAD are the smallest
// inputs proving availability and that the selected revision remains the full commit ID.
describe('Worker project HEAD probe', () => {
  it('distinguishes an unborn HEAD, a branch and a detached commit while retaining dirty status', async () => {
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
    git('init', '--initial-branch=main');
    writeFileSync(path.join(directory, 'file.txt'), 'worker\n');
    expect(await probeWorkerProject(directory)).toMatchObject({
      exists: true,
      headState: 'unborn',
      branch: null,
      dirty: true,
    });
    git('add', 'file.txt');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
    expect(await probeWorkerProject(directory)).toMatchObject({
      headState: 'branch',
      branch: 'main',
      dirty: false,
    });
    const sha = git('rev-parse', 'HEAD');
    git('checkout', '--detach', '--quiet', sha);
    expect(await probeWorkerProject(directory)).toMatchObject({
      headState: 'detached',
      branch: sha,
      dirty: false,
    });
  });
});

// Unit: import the project extension parser used by both register.ts creation entries,
// plus the actual project read handlers; use real device-link identity.
// PR1 requires local project options to stay local; service tests bypass this boundary.
// One new local field must fail parsing before a caller can reach lifecycle creation.
// The existing makerSendToSessionOrdering guard protects lifecycle delegation in register.ts.
const projectChannels = ['maker:worker:project-context', 'maker:worker:project-label'];
const creationChannels = [MAKER_INVOKE.WORKER_CREATE, MAKER_INVOKE.SESSION_ENABLE_ORCA];
type Handler = (event: unknown, ...args: unknown[]) => Promise<unknown>;
function ipcHarness(ssh = false) {
  const lead = {
    id: 'lead',
    remoteHostId: ssh ? 'ssh-host' : null,
    workingDir: '/repo',
    workspaceKind: 'project',
    orcaRole: 'lead',
  };
  const worker = { ...lead, id: 'worker-session', orcaRole: 'worker' };
  const getSession = vi.fn(async () => lead);
  const owner = { userId: 'owner' };
  const info = {
    directory: '/repo',
    baseRepo: '/repo',
    branch: 'main',
    exists: true,
    dirty: false,
    isWorktree: false,
  };
  const readContext = vi.fn(async () => ({
    recordedDirectory: '/repo',
    inherited: info,
    selected: info,
    dialogue: false,
    projects: [],
  }));
  const probe = vi.fn(async () => info);
  const remember = vi.fn(async () => {});
  const trustedRenderer = vi.fn();
  const adapters = createOrcaWorkerProjectHandlers({
    isDeviceLinkInvoke,
    assertTrustedAppRendererEvent: trustedRenderer,
    getOwner: () => owner,
    getSession,
    readContext,
    probe,
    remember,
    getTeamByWorkerSession: async () => ({ leadSessionId: 'lead' }),
    log: { warn: vi.fn() },
  });
  const handlers = new Map<string, Handler>([
    [projectChannels[0]!, (event, id, directory) => adapters.context(event, id, directory)],
    [projectChannels[1]!, (event, id) => adapters.label(event, id)],
  ]);
  const invoke = (channel: string, args: unknown[], remote = true) => {
    const handler = handlers.get(channel)!;
    const call = () => handler({}, ...args);
    return remote
      ? runDeviceLinkInvokeContext({ controllerDeviceId: 'controller', channel }, call)
      : call();
  };
  const options = (
    fields: Record<string, unknown>,
    remote = true,
    channel: string = MAKER_INVOKE.WORKER_CREATE,
  ) => {
    const call = () => adapters.options({}, 'lead', fields);
    return remote
      ? runDeviceLinkInvokeContext({ controllerDeviceId: 'controller', channel }, call)
      : call();
  };
  return {
    invoke,
    options,
    getSession,
    readContext,
    probe,
    remember,
    trustedRenderer,
    lead,
    worker,
  };
}

// Released pre-project-picker clients: mobile formWireFields with default placement or an
// execution device + selected directory, and Desktop's executionDeviceId + workingDir.
// These are protocol samples, deliberately independent of current client serializers:
// breaking them would reject old clients or create their Worker in the wrong directory.
const legacyWireFields = {
  'mobile-default': { workerPermissionMode: 'auto' },
  'mobile-execution-dir': {
    model: 'chosen-model',
    effort: 'high',
    fast: false,
    providerId: 'provider',
    workerPermissionMode: 'auto',
    executionDeviceId: 'execution-pc',
    workingDir: '/remote/project',
  },
  'desktop-execution-dir': { executionDeviceId: ' execution-pc ', workingDir: ' /remote/project ' },
};
describe('Worker project IPC cross-device boundary', () => {
  it.each(
    creationChannels.flatMap((channel) =>
      ['worktree', 'projectPath', 'workingDir'].flatMap((field) =>
        (field === 'workingDir' ? [false] : [false, true]).map((execution) => ({
          channel,
          field,
          execution,
        })),
      ),
    ),
  )(
    'rejects device-link $channel with local $field before creation (execution=$execution)',
    async ({ channel, field, execution }) => {
      const h = ipcHarness();
      const value = field === 'worktree' ? { sourceBranch: 'main' } : path.resolve('local-project');
      await expect(
        h.options(
          { [field]: value, ...(execution ? { executionDeviceId: 'execution-pc' } : {}) },
          true,
          channel,
        ),
      ).rejects.toMatchObject({ code: 'PERMISSION_DENIED' });
      expect(h.getSession).not.toHaveBeenCalled();
      expect(h.readContext).not.toHaveBeenCalled();
      expect(h.probe).not.toHaveBeenCalled();
      expect(h.remember).not.toHaveBeenCalled();
    },
  );
  it.each(creationChannels)(
    'rejects local project options for an SSH Lead through %s',
    async (channel) => {
      const h = ipcHarness(true);
      await expect(
        h.options({ worktree: { sourceBranch: 'main' } }, false, channel),
      ).rejects.toMatchObject({ code: 'INVALID_PARAMS' });
      expect(h.remember).not.toHaveBeenCalled();
    },
  );

  // Parsing exposes only the extension fields and a deferred success callback. It must
  // not write history while validation/creation can still fail; register owns dispatch.
  it.each(creationChannels)(
    'returns local fields and defers history until success through %s',
    async (channel) => {
      const h = ipcHarness();
      const directory = path.resolve('selected-project');
      const worktree = { sourceBranch: 'feature' };
      const project = await h.options(
        { workingDir: directory, worktree, projectPath: directory },
        false,
        channel,
      );
      expect(project.fields).toEqual({ workingDir: directory, worktree });
      expect(h.remember).not.toHaveBeenCalled();
      await project.remember();
      expect(h.remember).toHaveBeenCalledExactlyOnceWith(directory, 'owner');
    },
  );
  it.each(projectChannels.flatMap((channel) => [false, true].map((ssh) => ({ channel, ssh }))))(
    'denies project reads $channel (SSH=$ssh)',
    async ({ channel, ssh }) => {
      const h = ipcHarness(ssh);
      await expect(
        h.invoke(channel, [channel.endsWith('label') ? 'worker-session' : 'lead'], !ssh),
      ).rejects.toMatchObject({ code: ssh ? 'INVALID_PARAMS' : 'PERMISSION_DENIED' });
      expect(h.readContext).not.toHaveBeenCalled();
      expect(h.probe).not.toHaveBeenCalled();
    },
  );
  it('rejects a local worker project label when its Lead is SSH', async () => {
    const h = ipcHarness(true);
    h.getSession.mockResolvedValueOnce({ ...h.worker, remoteHostId: null });
    await expect(h.invoke(projectChannels[1]!, ['worker-session'], false)).rejects.toMatchObject({
      code: 'INVALID_PARAMS',
    });
    expect(h.probe).not.toHaveBeenCalled();
  });
  it.each(
    creationChannels.flatMap((channel) =>
      ['mobile-default', 'mobile-execution-dir', 'desktop-execution-dir'].map((client) => ({
        channel,
        client,
      })),
    ),
  )(
    'adds no project fields or history for released $client through $channel',
    async ({ channel, client }) => {
      const h = ipcHarness();
      const fields = legacyWireFields[client as keyof typeof legacyWireFields];
      const project = await h.options(fields, true, channel);
      expect(project.fields).toEqual({});
      await project.remember();
      expect(h.trustedRenderer).not.toHaveBeenCalled();
      expect(h.getSession).not.toHaveBeenCalled();
      expect(h.remember).not.toHaveBeenCalled();
    },
  );
});

// Performance regression, unit: recent lists can contain hundreds of projects. Existing
// HEAD/creation tests do not limit list-time Git work or selection-time list reloads.
describe('Worker project read cost', () => {
  it('builds 100 recent rows with bounded stat work and no Git, retaining order and current-worktree deduplication', async () => {
    const inherited = {
      directory: '/repo/.cindy-worktrees/lead',
      baseRepo: '/repo',
      branch: 'feature',
      exists: true,
      dirty: false,
      isWorktree: true,
      checkoutRoot: '/repo/.cindy-worktrees/lead',
      commonDir: '/repo/.git',
      realDirectory: '/repo/.cindy-worktrees/lead',
    };
    const inherit = vi.fn(async () => inherited);
    const recent = Array.from({ length: 100 }, (_, index) => `/projects/project-${index}`);
    let active = 0;
    let peak = 0;
    const isDirectory = vi.fn(async (directory: string) => {
      active++;
      peak = Math.max(peak, active);
      await Promise.resolve();
      active--;
      return directory !== recent[99];
    });
    vi.mocked(gitExec).mockClear();
    const result = await readWorkerProjectContext(
      { id: 'lead', workingDir: inherited.directory },
      {
        inherit,
        // Worker history precedes global recents; normalized aliases must not add rows.
        recentDirectories: async () => [
          recent[42]!,
          '/repo/.',
          inherited.directory,
          ...recent,
          `${recent[42]}/.`,
        ],
        isDirectory,
        realpath: async (directory) => {
          active++;
          peak = Math.max(peak, active);
          await Promise.resolve();
          active--;
          return directory;
        },
      },
    );
    expect(inherit).toHaveBeenCalledTimes(1);
    expect(gitExec).not.toHaveBeenCalled();
    expect(isDirectory).toHaveBeenCalledTimes(101);
    expect(peak).toBeLessThanOrEqual(4);
    expect(result.projects.map((row) => row.path)).toEqual([
      '/repo',
      recent[42],
      ...recent.filter((value) => value !== recent[42]),
    ]);
    expect(result.projects.at(-1)).toMatchObject({ path: recent[99], missing: true });
    expect(result.selected).toBe(inherited);
  });

  it('switches a project with exactly one target probe and no list or Lead inheritance reload', async () => {
    const h = ipcHarness();
    const selected = {
      directory: '/other',
      baseRepo: '/other',
      branch: 'other',
      exists: true,
      dirty: true,
      isWorktree: false,
    };
    h.probe.mockResolvedValue(selected);
    await h.invoke(projectChannels[0]!, ['lead'], false);
    const initialReads = h.readContext.mock.calls.length;
    expect(await h.invoke(projectChannels[0]!, ['lead', '/other'], false)).toEqual(selected);
    expect(h.readContext).toHaveBeenCalledTimes(initialReads);
    expect(h.probe).toHaveBeenCalledExactlyOnceWith('/other', true);
  });
});

// P2 regression: lexical path normalization misses filesystem aliases (/var vs /private/var,
// or a user-created symlink). Real filesystem identities must merge rows without invoking Git
// or rewriting the selected path. Unit tier: tiny temp directories, no timers or Git processes.
describe('Worker project filesystem aliases', () => {
  const base = path.join(directory, 'alias-fixture');
  const linked = path.join(directory, 'linked-projects');
  const projectA = path.join(base, 'proj-a');
  const checkout = path.join(projectA, '.cindy-worktrees', 'worker');
  const projectB = path.join(base, 'proj-b');
  const projectC = path.join(base, 'proj-c');
  const aliasB = path.join(linked, 'proj-b');
  const missing = path.join(linked, 'missing');
  // The parent fixture's afterAll removes both the target and its link.
  beforeAll(() => {
    mkdirSync(checkout, { recursive: true });
    mkdirSync(projectB, { recursive: true });
    mkdirSync(projectC, { recursive: true });
    symlinkSync(base, linked, 'junction');
  });

  it('merges current checkout/base aliases and ordinary project aliases, preserving the first path and failed-realpath rows', async () => {
    const canonicalA = await realpath(projectA);
    const canonicalCheckout = await realpath(checkout);
    const inherited = {
      directory: canonicalCheckout,
      baseRepo: canonicalA,
      checkoutRoot: canonicalCheckout,
      realDirectory: canonicalCheckout,
      commonDir: path.join(canonicalA, '.git'),
      branch: 'feature',
      exists: true,
      dirty: false,
      isWorktree: true,
    };
    vi.mocked(gitExec).mockClear();
    const result = await readWorkerProjectContext(
      { id: 'lead', workingDir: canonicalCheckout, worktreePath: checkout },
      {
        inherit: async () => inherited,
        recentDirectories: async () => [
          path.join(linked, 'proj-a'),
          projectA,
          path.join(linked, 'proj-a/.cindy-worktrees/worker'),
          // Worker history can retain both spellings; the list must show one row.
          aliasB,
          projectB,
          missing,
          projectC,
        ],
        realpath,
        isDirectory: async (directory) => {
          try {
            return (await stat(directory)).isDirectory();
          } catch {
            return false;
          }
        },
      },
    );
    expect(result.projects.map((row) => row.path)).toEqual([canonicalA, aliasB, missing, projectC]);
    expect(result.projects[1]).toMatchObject({ path: aliasB, description: aliasB, missing: false });
    expect(result.projects[2]).toMatchObject({ path: missing, missing: true });
    expect(result.projects[3]).toMatchObject({ missing: false });
    expect(gitExec).not.toHaveBeenCalled();
  });
});

// Review P1: a subproject Worker must start beside its own rules, after checkout.
// Unit orchestration with real filesystem/Git probe: a deferred checkout is the
// smallest input exposing the race; root selections must keep asynchronous startup.
// A source-branch symlink outside the checkout must not redirect the validated cwd.
describe('Worker worktree subproject directory', () => {
  const fixture = mkdtempSync(path.join(os.tmpdir(), 'cindy-worker-subproject-'));
  const repo = path.join(fixture, 'repo');
  const alias = path.join(fixture, 'repo-alias');
  beforeAll(() => {
    mkdirSync(path.join(repo, 'apps', 'web'), { recursive: true });
    writeFileSync(path.join(repo, 'apps', 'web', 'AGENTS.md'), 'Subproject rules');
    mkdirSync(path.join(repo, '..web'));
    writeFileSync(path.join(repo, '..web', 'AGENTS.md'), 'Dot-prefixed subproject rules');
    symlinkSync(repo, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, encoding: 'utf8' });
    git('init', '--initial-branch=main');
    git('add', '.');
    git(
      '-c',
      'user.name=Fixture',
      '-c',
      'user.email=fixture@example.invalid',
      '-c',
      'commit.gpgsign=false',
      'commit',
      '-m',
      'fixture',
    );
  });
  afterAll(() => rmSync(fixture, { recursive: true, force: true }));

  it.each(['subproject', 'dot-prefixed', 'root', 'missing', 'external-symlink'] as const)(
    'keeps the correct startup directory for %s',
    async (scenario) => {
      const sessionId = `worker-${scenario}`;
      const target = path.join(fixture, sessionId);
      mkdirSync(target);
      vi.mocked(createWorktree).mockResolvedValueOnce({
        ok: true,
        meta: {
          sessionId,
          path: target,
          baseRepo: repo,
          name: sessionId,
          branch: `cindy/${sessionId}`,
          sourceBranch: 'main',
          createdAt: new Date(0).toISOString(),
        },
      });
      const relative = scenario === 'dot-prefixed' ? '..web' : path.join('apps', 'web');
      const subproject = path.join(target, relative);
      const present = scenario === 'subproject' || scenario === 'dot-prefixed';
      let finishCheckout!: () => void;
      const checkout = new Promise<void>((resolve) => {
        finishCheckout = resolve;
      });
      let signalCheckoutStarted!: () => void;
      const checkoutStarted = new Promise<void>((resolve) => { signalCheckoutStarted = resolve; });
      vi.mocked(awaitBackgroundCheckout).mockReset().mockImplementation(() => {
        signalCheckoutStarted();
        return checkout;
      });
      const source = scenario === 'root' ? alias : path.join(alias, relative);
      let settled = false;
      const result = createWorkerWorktree(sessionId, source, 'main').then((value) => {
        settled = true;
        return value;
      });
      try {
        if (scenario === 'root') {
          expect(await result).toBe(target);
          expect(awaitBackgroundCheckout).not.toHaveBeenCalled();
          return;
        }
        // Windows CI can spend >1s in the real Git probe. Await the actual
        // boundary (or an early result/failure), not vi.waitFor's 1s deadline.
        await Promise.race([checkoutStarted, result]);
        expect(awaitBackgroundCheckout).toHaveBeenCalledWith(sessionId);
        expect(settled).toBe(false);
        if (present) {
          mkdirSync(subproject, { recursive: true });
          writeFileSync(path.join(subproject, 'AGENTS.md'), 'Checked out rules');
        }
        if (scenario === 'external-symlink') {
          const external = path.join(fixture, 'outside-checkout');
          mkdirSync(external);
          mkdirSync(path.dirname(subproject), { recursive: true });
          symlinkSync(external, subproject, process.platform === 'win32' ? 'junction' : 'dir');
        }
        finishCheckout();
        expect(await result).toBe(present ? subproject : target);
        if (scenario === 'missing' || scenario === 'external-symlink')
          expect(createLogger('test').warn).toHaveBeenCalledWith(
            'Worker subproject is unavailable within the new worktree; using its root',
            { sessionId },
          );
      } finally {
        // A failed assertion must not leave a task using the next case's mocks
        // or the fixture after afterAll removes it.
        finishCheckout();
        await result.catch(() => {});
      }
    },
  );
});

// PR2 unit: validate the tool's optional source before any worktree side effect.
// UI only supplied a revision; injected probe isolates HEAD states without new Git processes.
describe('Worker worktree source resolution', () => {
  const target = {directory: '/repo', exists: true, baseRepo: '/repo', branch: 'main',
    headState: 'branch' as const, dirty: false, isWorktree: false, commonDir: '/repo/.git', checkoutRoot: '/repo', realDirectory: '/repo'};
  it.each([
    {headState: 'branch' as const, branch: 'feature', source: undefined, expected: 'feature'},
    {headState: 'detached' as const, branch: 'a'.repeat(40), source: undefined, expected: 'a'.repeat(40)},
    {headState: 'branch' as const, branch: 'main', source: 'release', expected: 'release'},
    {headState: 'unborn' as const, branch: null, source: 'main', expected: 'main'},
  ])('resolves $headState with source $source', async ({headState, branch, source, expected}) => {
    if (source !== undefined) vi.mocked(gitExec).mockResolvedValueOnce({stdout: 'a'.repeat(40) + '\n', stderr: ''});
    await expect(resolveWorkerWorktreeSource('/repo', source, async () => ({...target, headState, branch}))).resolves.toBe(expected);
    if (source !== undefined) expect(gitExec).toHaveBeenLastCalledWith(
      ['rev-parse', '--verify', '--quiet', '--end-of-options', `${source}^{commit}`], '/repo', {timeoutMs: 5000});
  });
  it.each([
    {exists: false}, {baseRepo: null}, {headState: 'unborn' as const, branch: null}, {branch: null},
  ])('rejects an unavailable target %j', async changes => {
    await expect(resolveWorkerWorktreeSource('/repo', undefined, async () => ({...target, ...changes}))).rejects.toThrow();
  });
  // #6623 P2 (unit): explicit refs need commit verification, not a born current HEAD.
  // The probe-only cases did not reject an absent ref before creating a worktree.
  it('rejects an explicit reference with no commit, including an empty repository', async () => {
    vi.mocked(gitExec).mockRejectedValueOnce(new Error('revision not found'));
    await expect(resolveWorkerWorktreeSource('/repo', 'missing', async () => ({
      ...target, headState: 'unborn', branch: null,
    }))).rejects.toThrow('source_branch must reference an existing commit');
  });
  it.each(['', ' ', '-bad', 'bad\nbranch', 'x'.repeat(1025)])('rejects malformed source before probing', async source => {
    const probe = vi.fn(async () => target);
    await expect(resolveWorkerWorktreeSource('/repo', source, probe)).rejects.toThrow('source_branch');
    expect(probe).not.toHaveBeenCalled();
  });
  // Defaults parity: previous source tests did not read repository preferences.
  // Real resolver, injected read/probe; invalid remembered refs must fall back, explicit refs must fail.
  // PR #7933 P2 (unit): a different subdirectory/checkout of the same repo must keep its HEAD.
  // Previously only identical directories bypassed the repository preference.
  it.each(['valid', 'missing', 'read-failed', 'same', 'same-subdir', 'same-worktree', 'same-main', 'explicit'])(
    'resolves remembered source: %s', async scenario => {
      const read = vi.fn(() => {
        if (scenario === 'read-failed') throw new Error('store unavailable');
        return { baseRepo: '/repo', sourceBranch: 'release', revision: 1 };
      });
      const sameRepo = scenario.startsWith('same');
      const directory = scenario === 'same-subdir' ? '/repo/apps/api'
        : scenario === 'same-worktree' ? '/repo/.cindy-worktrees/other' : '/repo';
      const leadDirectory = scenario === 'same' ? directory
        : scenario === 'same-subdir' ? '/repo/apps/web'
        : scenario === 'same-worktree' ? '/repo'
        : scenario === 'same-main' ? '/repo/.cindy-worktrees/lead' : '/lead';
      const probe = async (dir: string) => ({ ...target, directory: dir,
        baseRepo: dir === '/lead' ? '/lead' : dir === leadDirectory ? '/repo/' : '/repo' });
      await vi.mocked(gitExec).withImplementation(async () => {
        if (scenario === 'missing') throw new Error('not found');
        return {stdout: 'abc', stderr: ''};
      }, async () => {
        const result = await resolveWorkerWorktreeSourceSelection(directory, scenario === 'explicit' ? 'picked' : undefined,
          probe, leadDirectory, read);
        expect(result.sourceBranch).toBe(scenario === 'valid' ? 'release' : scenario === 'explicit' ? 'picked' : 'main');
        if (scenario === 'missing' || scenario === 'read-failed') expect(result.fallbackReason).toContain('current checkout');
        if (sameRepo || scenario === 'explicit') expect(read).not.toHaveBeenCalled();
        else expect(read).toHaveBeenCalledWith('/repo');
      });
    },
  );
  it('projects only metadata registered under the Worker session, not a directory spelling', () => {
    vi.mocked(getForSession).mockReturnValueOnce({path: '/checkout', branch: 'cindy/new', baseRepo: '/repo'} as never).mockReturnValueOnce(null);
    expect(getWorkerOwnedWorktree('owned')).toEqual({path: '/checkout', branch: 'cindy/new'});
    expect(getForSession).toHaveBeenLastCalledWith('owned');
    expect(getWorkerOwnedWorktree('inherited')).toBeUndefined();
  });
});
