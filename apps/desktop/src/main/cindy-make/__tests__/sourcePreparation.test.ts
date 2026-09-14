import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CINDY_SOURCE_REPOSITORY,
  cancelCindySourcePreparation,
  readCurrentCindySourceStatus,
  readCindySourceStatus,
  prepareCindySource,
  sourceTarget,
  subscribeCindySourceStatus,
} from '../sourcePreparation.js';
import {
  selectMakeToolchainEnvironment,
  type MakeToolchainEnvironment,
} from '../toolchainEnvironment.js';
import { runSourceGit } from '../sourceGit.js';
import { runSourcePnpm } from '../sourcePnpm.js';
import type { DoctorProbeResult } from '../doctor.js';

vi.mock('../sourceGit.js', () => ({ runSourceGit: vi.fn() }));
vi.mock('../sourcePnpm.js', () => ({ runSourcePnpm: vi.fn(async () => undefined) }));

describe('Git-only source preparation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-source-'));
    vi.mocked(runSourceGit).mockReset();
    vi.mocked(runSourcePnpm).mockReset().mockResolvedValue(undefined);
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it.each([
    ['win32', 'system', false],
    ['win32', 'managed', true],
    ['darwin', 'system', true],
    ['darwin', 'managed', false],
  ] as const)(
    'uses only %s %s Git for an existing checkout: %s',
    async (platform, source, existing) => {
      const sourcePath = path.join(root, 'source');
      if (existing) await mkdir(path.join(sourcePath, '.git'), { recursive: true });
      const systemGit = path.join(root, 'system', 'git');
      const managedGit = path.join(root, 'tools', 'git');
      const probe = vi.fn(
        async (
          executable: string | undefined,
          command: string,
          args: readonly string[],
        ): Promise<DoctorProbeResult> => {
          if (command !== 'git' || args.join(' ') !== '--version')
            return { status: 'missing', stdout: '' };
          if (source === 'managed' && !executable) return { status: 'missing', stdout: '' };
          return { status: 'ok', stdout: 'git version 2.45.0', path: executable ?? systemGit };
        },
      );
      const native = vi.fn();
      const storage = vi.fn();
      const env = selectMakeToolchainEnvironment(
        (paths) => ({
          platform,
          arch: 'x64',
          probe: (command, args) => probe(paths.git, command, args),
          native,
          storage,
        }),
        { git: managedGit },
        (paths) => ({ CINDY_TEST_GIT: paths.git }),
      );
      const selectedGit = source === 'system' ? systemGit : managedGit;
      vi.mocked(runSourceGit).mockImplementation(async (processEnv, args) => {
        expect(processEnv.CINDY_TEST_GIT).toBe(selectedGit);
        switch (args[0]) {
          case 'ls-remote':
            return '0123456789abcdef\trefs/heads/main';
          case 'remote':
            return CINDY_SOURCE_REPOSITORY;
          case 'rev-parse':
            return '0123456789abcdef';
          // No personal branch yet: preparation must create it from the baseline.
          case 'branch':
            return '';
          default:
            return '';
        }
      });
      const result = await prepareCindySource(
        env,
        root,
        { channel: 'dev', version: '0.0.0' },
        new AbortController().signal,
      );
      expect(result).toMatchObject({
        status: 'ready',
        commit: '0123456789abcdef',
        branch: 'cindy-personal',
        baseCommit: '0123456789abcdef',
      });
      const gitCalls = vi.mocked(runSourceGit).mock.calls;
      const createBranch = gitCalls.find(
        ([, args]) => args[0] === 'branch' && args[1] === 'cindy-personal',
      );
      expect(createBranch?.[1]).toEqual(['branch', 'cindy-personal', '0123456789abcdef']);
      expect(createBranch?.[2]).toBe(sourcePath);
      const checkout = gitCalls.find(([, args]) => args[0] === 'checkout');
      expect(checkout?.[1]).toEqual(['checkout', 'cindy-personal']);
      expect(checkout?.[2]).toBe(sourcePath);
      expect(gitCalls.some(([, args]) => args[0] === 'reset')).toBe(false);
      // Dependencies are installed per task worktree, never in the baseline checkout.
      expect(runSourcePnpm).not.toHaveBeenCalled();
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({
        status: 'ready',
        branch: 'cindy-personal',
        baseCommit: '0123456789abcdef',
      });
      expect(probe).toHaveBeenCalledTimes(source === 'system' ? 1 : 2);
      expect(
        probe.mock.calls.every(
          ([, command, args]) => command === 'git' && args.join(' ') === '--version',
        ),
      ).toBe(true);
      expect(native).not.toHaveBeenCalled();
      expect(storage).not.toHaveBeenCalled();
      const commands = vi.mocked(runSourceGit).mock.calls.map(([, args]) => args[0]);
      expect(commands).toContain(existing ? 'checkout' : 'clone');
      expect(commands).toContain('fetch');
      if (existing) expect(commands).not.toContain('clone');
    },
  );

  it('publishes and cancels global source preparation state', async () => {
    const statuses: string[] = [];
    const unsubscribe = subscribeCindySourceStatus((status) => statuses.push(status.status));
    const env = {
      platform: 'win32',
      probe: vi.fn(
        () =>
          new Promise<DoctorProbeResult>(() => {
            // The test cancels through the global IPC-facing controller.
          }),
      ),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;

    const preparation = prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
    );
    expect(cancelCindySourcePreparation()).toBe(true);
    await expect(preparation).resolves.toMatchObject({ status: 'cancelled' });
    await expect(readCurrentCindySourceStatus(root)).resolves.toMatchObject({
      status: 'cancelled',
      error: 'cancelled',
    });
    expect(statuses).toEqual(['preparing', 'cancelled']);
    expect(cancelCindySourcePreparation()).toBe(false);
    unsubscribe();
  });

  it.each(['missing', 'failed', 'timeout'] as const)(
    'reports unavailable Git (%s) without accessing the remote',
    async (status) => {
      const env = {
        platform: 'win32',
        probe: vi.fn(async () => ({ status, stdout: '' })),
      } as unknown as MakeToolchainEnvironment;
      const result = await prepareCindySource(
        env,
        root,
        { channel: 'dev', version: '0.0.0' },
        new AbortController().signal,
      );
      expect(result).toMatchObject({ status: 'failed', error: 'gitUnavailable' });
      expect(runSourceGit).not.toHaveBeenCalled();
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({
        status: 'failed',
        error: 'gitUnavailable',
      });
    },
  );

  it('keeps an existing personal branch and never resets it to upstream', async () => {
    const sourcePath = path.join(root, 'source');
    await mkdir(path.join(sourcePath, '.git'), { recursive: true });
    const env = {
      platform: 'win32',
      probe: vi.fn(async () => ({ status: 'ok', stdout: 'git version 2.45.0', path: 'git' })),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      switch (args[0]) {
        case 'ls-remote':
          return '0123456789abcdef\trefs/heads/main';
        case 'remote':
          return CINDY_SOURCE_REPOSITORY;
        case 'branch':
          return '  cindy-personal';
        case 'rev-parse':
          return args[1] === 'HEAD' ? 'fedcba9876543210' : '0123456789abcdef';
        default:
          return '';
      }
    });
    const result = await prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({
      status: 'ready',
      commit: 'fedcba9876543210',
      baseCommit: '0123456789abcdef',
      branch: 'cindy-personal',
    });
    const commands = vi.mocked(runSourceGit).mock.calls.map(([, args]) => args);
    expect(commands.some((args) => args[0] === 'branch' && args[1] === 'cindy-personal')).toBe(
      false,
    );
    expect(commands.some((args) => args[0] === 'reset')).toBe(false);
    expect(commands.some((args) => args[0] === 'rev-list')).toBe(false);
  });

  it('refuses a dirty managed checkout instead of discarding its changes', async () => {
    const sourcePath = path.join(root, 'source');
    await mkdir(path.join(sourcePath, '.git'), { recursive: true });
    const env = {
      platform: 'win32',
      probe: vi.fn(async () => ({ status: 'ok', stdout: 'git version 2.45.0', path: 'git' })),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
      if (args[0] === 'status') return ' M apps/desktop/src/x.ts';
      return '';
    });
    const result = await prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: 'failed', error: 'dirty' });
    expect(runSourcePnpm).not.toHaveBeenCalled();
  });

  it('removes the remainder of an interrupted clear before cloning again', async () => {
    const sourcePath = path.join(root, 'source');
    await mkdir(path.join(sourcePath, 'node_modules', 'leftover'), { recursive: true });
    const env = {
      platform: 'win32',
      probe: vi.fn(async () => ({ status: 'ok', stdout: 'git version 2.45.0', path: 'git' })),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'clone') {
        await expect(access(sourcePath)).rejects.toThrow();
        return '';
      }
      if (args[0] === 'rev-parse') return '0123456789abcdef';
      return '';
    });
    const result = await prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
    );
    expect(result).toMatchObject({ status: 'ready' });
    expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'clone')).toBe(true);
  });

  it('attaches a concurrent caller to the running job instead of starting a second one', async () => {
    const sourcePath = path.join(root, 'source');
    await mkdir(path.join(sourcePath, '.git'), { recursive: true });
    const env = {
      platform: 'win32',
      probe: vi.fn(async () => ({ status: 'ok', stdout: 'git version 2.45.0', path: 'git' })),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    let releaseFetch!: () => void;
    const fetchGate = new Promise<void>((resolve) => {
      releaseFetch = resolve;
    });
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
      if (args[0] === 'fetch') {
        await fetchGate;
        return '';
      }
      if (args[0] === 'branch') return '  cindy-personal';
      if (args[0] === 'rev-parse') return '0123456789abcdef';
      return '';
    });
    const broadcast: string[] = [];
    const unsubscribe = subscribeCindySourceStatus((status) => broadcast.push(status.status));
    const first = prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
    );
    await vi.waitFor(() =>
      expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(true),
    );
    const secondProgress = vi.fn();
    const second = prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      new AbortController().signal,
      secondProgress,
    );
    // The late caller gets the current snapshot at once and shares the pipeline.
    expect(secondProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'fetching' }));
    await expect(readCurrentCindySourceStatus(root)).resolves.toMatchObject({
      status: 'preparing',
      phase: 'fetching',
    });
    releaseFetch();
    const [a, b] = await Promise.all([first, second]);
    expect(a).toBe(b);
    expect(a.status).toBe('ready');
    const fetches = vi.mocked(runSourceGit).mock.calls.filter(([, args]) => args[0] === 'fetch');
    expect(fetches).toHaveLength(1);
    expect(broadcast[broadcast.length - 1]).toBe('ready');
    unsubscribe();
  });

  it('cancels during Git discovery without starting a checkout', async () => {
    const controller = new AbortController();
    const env = {
      probe: vi.fn(() => new Promise<DoctorProbeResult>(() => {})),
    } as unknown as MakeToolchainEnvironment;
    const pending = prepareCindySource(
      env,
      root,
      { channel: 'dev', version: '0.0.0' },
      controller.signal,
    );
    await vi.waitFor(() => expect(env.probe).toHaveBeenCalledOnce());
    controller.abort();
    await expect(pending).resolves.toMatchObject({ status: 'cancelled', error: 'cancelled' });
    expect(runSourceGit).not.toHaveBeenCalled();
  });
});

describe('Cindy Make source target', () => {
  it('uses main for development builds', () => {
    expect(sourceTarget({ channel: 'dev', version: '0.0.0' })).toMatchObject({
      ref: 'main',
      candidates: ['main'],
    });
  });

  it('prefers the beta tag for beta builds and falls back to release', () => {
    expect(sourceTarget({ channel: 'beta', version: '0.1.75-beta' })).toMatchObject({
      candidates: ['v0.1.75-beta', 'v0.1.75'],
    });
  });

  it('prefers the release tag for release builds and keeps beta as fallback', () => {
    expect(sourceTarget({ channel: 'release', version: 'v0.1.75' })).toMatchObject({
      candidates: ['v0.1.75', 'v0.1.75-beta'],
    });
  });

  it('returns no candidates for an invalid version', () => {
    expect(sourceTarget({ channel: 'release', version: 'latest' }).candidates).toEqual([]);
  });

  it('clears a missing checkout locally without invoking remote resolution', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-source-'));
    const env = { processEnvironment: () => ({}) } as MakeToolchainEnvironment;
    try {
      const result = await prepareCindySource(
        env,
        root,
        { channel: 'dev', version: '0.0.0' },
        new AbortController().signal,
        undefined,
        { clearOnly: true },
      );
      expect(result).toMatchObject({ status: 'ready', cleared: true });
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({ status: 'missing' });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
