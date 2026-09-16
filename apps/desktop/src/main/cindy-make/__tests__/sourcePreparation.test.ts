import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { access, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
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

async function createExistingCheckout(sourcePath: string): Promise<void> {
  await mkdir(path.join(sourcePath, '.git'), { recursive: true });
  await writeFile(path.join(sourcePath, '.git', 'index'), 'test');
  await writeFile(path.join(sourcePath, 'package.json'), '{}');
}

async function probeReadyTool(command: string): Promise<DoctorProbeResult> {
  const stdout =
    command === 'git'
      ? 'git version 2.45.0'
      : command === 'node'
        ? 'v24.16.0'
        : command === 'pnpm'
          ? '10.33.2'
          : command === 'python3'
            ? 'Python 3.12.10'
            : '';
  return { status: stdout ? 'ok' : 'missing', stdout, path: command };
}

describe('Source and dependency preparation', () => {
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
    'uses %s %s tools to prepare source and dependencies (existing checkout: %s)',
    async (platform, source, existing) => {
      const sourcePath = path.join(root, 'source');
      if (existing) await createExistingCheckout(sourcePath);
      const systemGit = path.join(root, 'system', 'git');
      const managedGit = path.join(root, 'tools', 'git');
      const probe = vi.fn(
        async (
          executable: string | undefined,
          command: string,
          args: readonly string[],
        ): Promise<DoctorProbeResult> => {
          if (args.join(' ') !== '--version') return { status: 'missing', stdout: '' };
          if (source === 'managed' && !executable) return { status: 'missing', stdout: '' };
          return {
            ...(await probeReadyTool(command)),
            path: executable ?? path.join(root, 'system', command),
          };
        },
      );
      const native = vi.fn();
      const storage = vi.fn();
      const env = selectMakeToolchainEnvironment(
        (paths) => ({
          platform,
          arch: 'x64',
          probe: (command, args) =>
            probe(
              command === 'node'
                ? paths.node
                : command === 'pnpm'
                  ? paths.pnpm
                  : command === 'python3'
                    ? paths.python
                    : paths.git,
              command,
              args,
            ),
          native,
          storage,
        }),
        {
          git: managedGit,
          node: path.join(root, 'tools', 'node'),
          pnpm: path.join(root, 'tools', 'pnpm'),
          python: path.join(root, 'tools', 'python3'),
        },
        (paths) => ({
          CINDY_TEST_GIT: paths.git,
          CINDY_TEST_NODE: paths.node,
          CINDY_TEST_PNPM: paths.pnpm,
          CINDY_TEST_PYTHON: paths.python,
        }),
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
            return args[1] === '--abbrev-ref' ? 'cindy-personal' : '0123456789abcdef';
          case 'merge-base':
            return '0123456789abcdef';
          case 'rev-list':
            return '0\t0';
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
        currentBranch: 'cindy-personal',
        baseCommit: '0123456789abcdef',
        mainCommit: '0123456789abcdef',
        mainRemoteCommit: '0123456789abcdef',
        mainBehind: 0,
        mainAhead: 0,
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
      expect(runSourcePnpm).toHaveBeenCalledExactlyOnceWith(
        {
          CINDY_TEST_GIT: selectedGit,
          CINDY_TEST_NODE: path.join(root, source === 'system' ? 'system' : 'tools', 'node'),
          CINDY_TEST_PNPM: path.join(root, source === 'system' ? 'system' : 'tools', 'pnpm'),
          CINDY_TEST_PYTHON: path.join(root, source === 'system' ? 'system' : 'tools', 'python3'),
        },
        ['install', '--frozen-lockfile', '--prefer-offline', '--prod=false'],
        sourcePath,
        expect.any(AbortSignal),
      );
      const checkoutIndex = gitCalls.findIndex(([, args]) => args[0] === 'checkout');
      expect(vi.mocked(runSourceGit).mock.invocationCallOrder[checkoutIndex]).toBeLessThan(
        vi.mocked(runSourcePnpm).mock.invocationCallOrder[0],
      );
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({
        status: 'ready',
      });
      await expect(readCindySourceStatus(root)).resolves.not.toHaveProperty('mainCommit');
      expect(probe).toHaveBeenCalledTimes(source === 'system' ? 4 : 8);
      expect(
        probe.mock.calls.every(
          ([, command, args]) =>
            ['git', 'node', 'pnpm', 'python3'].includes(command) && args.join(' ') === '--version',
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

  describe('personal branch dependencies', () => {
    let env: MakeToolchainEnvironment;
    beforeEach(async () => {
      await createExistingCheckout(path.join(root, 'source'));
      env = {
        platform: 'darwin',
        probe: vi.fn(probeReadyTool),
        processEnvironment: () => ({}),
      } as unknown as MakeToolchainEnvironment;
      vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
        if (args[0] === 'ls-remote') return '0123456789abcdef	refs/heads/main';
        if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
        if (args[0] === 'branch') return 'cindy-personal';
        if (args[0] === 'rev-parse') return '0123456789abcdef';
        return '';
      });
    });

    it('keeps the shared job preparing until installation completes, including late subscribers', async () => {
      let finishInstall!: () => void;
      vi.mocked(runSourcePnpm).mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            finishInstall = resolve;
          }),
      );
      const progress = vi.fn();
      const first = prepareCindySource(
        env,
        root,
        { channel: 'dev', version: '0.0.0' },
        new AbortController().signal,
        progress,
      );
      await vi.waitFor(() => expect(runSourcePnpm).toHaveBeenCalledOnce());
      await expect(readCurrentCindySourceStatus(root)).resolves.toMatchObject({
        status: 'preparing',
        phase: 'installing',
        branch: 'cindy-personal',
      });
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({
        status: 'preparing',
        phase: 'installing',
      });
      expect(progress.mock.calls.some(([update]) => update.status === 'ready')).toBe(false);
      const lateProgress = vi.fn();
      const second = prepareCindySource(
        env,
        root,
        { channel: 'dev', version: '0.0.0' },
        new AbortController().signal,
        lateProgress,
      );
      expect(lateProgress).toHaveBeenCalledWith(expect.objectContaining({ phase: 'installing' }));
      finishInstall();
      const [firstResult, secondResult] = await Promise.all([first, second]);
      expect(firstResult).toBe(secondResult);
      expect(firstResult.status).toBe('ready');
      expect(runSourcePnpm).toHaveBeenCalledOnce();
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({ status: 'ready' });
    });

    it('reports install failure and retries the existing personal checkout without resetting it', async () => {
      vi.mocked(runSourcePnpm).mockRejectedValueOnce(
        Object.assign(new Error('installation failed'), { code: 'installFailed' }),
      );
      const progress = vi.fn();
      await expect(
        prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          new AbortController().signal,
          progress,
        ),
      ).resolves.toMatchObject({ status: 'failed', error: 'installFailed' });
      expect(progress.mock.calls.some(([update]) => update.status === 'ready')).toBe(false);
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({
        status: 'failed',
        error: 'installFailed',
      });
      await expect(
        prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'ready' });
      expect(runSourcePnpm).toHaveBeenCalledTimes(2);
      expect(
        vi
          .mocked(runSourceGit)
          .mock.calls.some(
            ([, args]) =>
              ['clone', 'reset'].includes(args[0]) ||
              (args[0] === 'branch' && args[1] !== '--list'),
          ),
      ).toBe(false);
    });

    it('does not mark a cancelled installation ready even if the child completes successfully', async () => {
      const controller = new AbortController();
      vi.mocked(runSourcePnpm).mockImplementationOnce(async (_env, _args, _cwd, signal) => {
        expect(cancelCindySourcePreparation()).toBe(true);
        expect(signal.aborted).toBe(true);
      });
      const progress = vi.fn();
      await expect(
        prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          controller.signal,
          progress,
        ),
      ).resolves.toMatchObject({ status: 'cancelled', error: 'cancelled' });
      expect(progress.mock.calls.some(([update]) => update.status === 'ready')).toBe(false);
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({ status: 'cancelled' });
      expect(cancelCindySourcePreparation()).toBe(false);
    });

    it.each(['node', 'pnpm', 'python3'] as const)(
      'fails without installing when %s is unavailable',
      async (tool) => {
        vi.mocked(env.probe).mockImplementation(async (command) =>
          command === tool ? { status: 'missing', stdout: '' } : probeReadyTool(command),
        );
        await expect(
          prepareCindySource(
            env,
            root,
            { channel: 'dev', version: '0.0.0' },
            new AbortController().signal,
          ),
        ).resolves.toMatchObject({ status: 'failed', error: 'environmentNotReady' });
        expect(runSourcePnpm).not.toHaveBeenCalled();
      },
    );

    it('prepares dependencies for a previously Git-only ready checkout', async () => {
      await writeFile(
        path.join(root, 'source-status.json'),
        JSON.stringify({
          status: 'ready',
          path: path.join(root, 'source'),
          ref: 'main',
        }),
      );
      await expect(
        prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          new AbortController().signal,
        ),
      ).resolves.toMatchObject({ status: 'ready' });
      expect(runSourcePnpm).toHaveBeenCalledOnce();
      expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'clone')).toBe(
        false,
      );
    });

    it('clears locally using Git alone and never starts an install', async () => {
      await expect(
        prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          new AbortController().signal,
          undefined,
          { clearOnly: true },
        ),
      ).resolves.toMatchObject({ status: 'ready', cleared: true });
      expect(env.probe).toHaveBeenCalledExactlyOnceWith(
        'git',
        ['--version'],
        expect.any(AbortSignal),
      );
      expect(runSourcePnpm).not.toHaveBeenCalled();
      await expect(readCindySourceStatus(root)).resolves.toMatchObject({ status: 'missing' });
    });
  });

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

  it('hydrates Git details from an existing checkout when an old status file lacks them', async () => {
    const sourcePath = path.join(root, 'source');
    await createExistingCheckout(sourcePath);
    await writeFile(
      path.join(root, 'source-status.json'),
      JSON.stringify({
        status: 'ready',
        path: sourcePath,
        branch: 'cindy-personal',
        ref: 'main',
        commit: 'a'.repeat(40),
        baseCommit: 'b'.repeat(40),
      }),
    );
    const env = { processEnvironment: () => ({}) } as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'merge-base') return 'b'.repeat(40);
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'c'.repeat(40);
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'cindy-personal';
      if (args[0] === 'rev-list') return '0\t2';
      throw new Error('not available');
    });
    await expect(readCurrentCindySourceStatus(root, env)).resolves.toMatchObject({
      status: 'ready',
      branch: 'cindy-personal',
      baseCommit: 'b'.repeat(40),
      mainCommit: 'c'.repeat(40),
      currentBranch: 'cindy-personal',
    });
    await expect(readCindySourceStatus(root)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(readCindySourceStatus(root)).resolves.not.toHaveProperty('mainCommit');
    expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'fetch')).toBe(false);
    expect(vi.mocked(runSourceGit).mock.calls.some(([, args]) => args[0] === 'checkout')).toBe(
      false,
    );
  });

  it('does not invent a personal source version when the legacy status has no baseline', async () => {
    const sourcePath = path.join(root, 'source');
    await createExistingCheckout(sourcePath);
    await writeFile(
      path.join(root, 'source-status.json'),
      JSON.stringify({ status: 'ready', path: sourcePath, branch: 'cindy-personal' }),
    );
    const env = { processEnvironment: () => ({}) } as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'rev-parse' && args[1] === 'HEAD') return 'a'.repeat(40);
      if (args[0] === 'rev-parse' && args[1] === '--verify') return 'b'.repeat(40);
      if (args[0] === 'rev-parse' && args[1] === '--abbrev-ref') return 'cindy-personal';
      throw new Error('not available');
    });
    await expect(readCurrentCindySourceStatus(root, env)).resolves.toMatchObject({
      status: 'ready',
      branch: 'cindy-personal',
      baseCommit: undefined,
      mainCommit: 'b'.repeat(40),
      currentBranch: 'cindy-personal',
    });
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
    await createExistingCheckout(sourcePath);
    const env = {
      platform: 'win32',
      probe: vi.fn(probeReadyTool),
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
        case 'merge-base':
          return 'abcdef0123456789';
        case 'rev-list':
          return '0\t3';
        case 'rev-parse':
          if (args.includes('refs/heads/main^{commit}')) return 'a'.repeat(40);
          if (args.includes('refs/remotes/origin/main^{commit}')) return 'b'.repeat(40);
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
      baseCommit: 'abcdef0123456789',
      branch: 'cindy-personal',
      mainCommit: 'a'.repeat(40),
      mainRemoteCommit: 'b'.repeat(40),
      mainBehind: 3,
      mainAhead: 0,
    });
    const commands = vi.mocked(runSourceGit).mock.calls.map(([, args]) => args);
    expect(commands.some((args) => args[0] === 'branch' && args[1] === 'cindy-personal')).toBe(
      false,
    );
    expect(commands.some((args) => args[0] === 'reset')).toBe(false);
    expect(commands).toContainEqual(['merge-base', 'fedcba9876543210', '0123456789abcdef']);
    await expect(readCindySourceStatus(root)).resolves.toMatchObject({
      status: 'ready',
    });
    await expect(readCindySourceStatus(root)).resolves.not.toHaveProperty('baseCommit');
    await expect(readCindySourceStatus(root)).resolves.not.toHaveProperty('mainCommit');
  });

  it.each(['main', 'origin/main', 'comparison'])(
    'finishes source preparation when %s metadata cannot be read',
    async (missing) => {
      await createExistingCheckout(path.join(root, 'source'));
      const env = {
        platform: 'darwin',
        probe: vi.fn(probeReadyTool),
        processEnvironment: () => ({}),
      } as unknown as MakeToolchainEnvironment;
      vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
        if (
          (missing === 'main' && args.includes('refs/heads/main^{commit}')) ||
          (missing === 'origin/main' && args.includes('refs/remotes/origin/main^{commit}')) ||
          (missing === 'comparison' && args[0] === 'rev-list')
        )
          throw new Error('metadata unavailable');
        if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
        if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
        if (args[0] === 'rev-parse' || args[0] === 'merge-base') return '0123456789abcdef';
        return '';
      });
      const progress = vi.fn();
      const broadcast = vi.fn();
      const unsubscribe = subscribeCindySourceStatus(broadcast);
      try {
        const result = await prepareCindySource(
          env,
          root,
          { channel: 'dev', version: '0.0.0' },
          new AbortController().signal,
          progress,
        );
        expect(result.status).toBe('ready');
        expect(result.baseCommit).toBe('0123456789abcdef');
        expect(result.mainBehind).toBeUndefined();
        expect(result.mainAhead).toBeUndefined();
        expect(progress).toHaveBeenLastCalledWith(result);
        expect(broadcast).toHaveBeenLastCalledWith(
          expect.objectContaining({
            status: 'ready',
            baseCommit: result.baseCommit,
            mainCommit: result.mainCommit,
            mainRemoteCommit: result.mainRemoteCommit,
            mainBehind: undefined,
          }),
        );
        const restored = await readCindySourceStatus(root);
        expect(restored.status).toBe('ready');
        expect(restored).not.toHaveProperty('mainCommit');
        expect(restored).not.toHaveProperty('mainRemoteCommit');
        expect(restored).not.toHaveProperty('mainBehind');
      } finally {
        unsubscribe();
      }
    },
  );

  it.each([
    { mainCommit: 'not-a-hash', mainRemoteCommit: {}, mainBehind: -1, mainAhead: 1.5 },
    {
      mainCommit: [],
      mainRemoteCommit: 'refs/heads/main',
      mainBehind: '0',
      mainAhead: Number.MAX_SAFE_INTEGER + 1,
    },
  ])(
    'discards invalid persisted revision fields without losing checkout status',
    async (fields) => {
      await writeFile(
        path.join(root, 'source-status.json'),
        JSON.stringify({
          status: 'ready',
          path: path.join(root, 'source'),
          branch: 'cindy-personal',
          ...fields,
        }),
      );
      const restored = await readCindySourceStatus(root);
      expect(restored.status).toBe('ready');
      for (const field of ['mainCommit', 'mainRemoteCommit', 'mainBehind', 'mainAhead']) {
        expect(restored).not.toHaveProperty(field);
      }
    },
  );

  it.each(['main', 'feature/personal', null])(
    'does not restore the current checkout branch %s from the status file',
    async (currentBranch) => {
      await writeFile(
        path.join(root, 'source-status.json'),
        JSON.stringify({
          status: 'ready',
          path: path.join(root, 'source'),
          branch: 'cindy-personal',
          currentBranch,
        }),
      );
      await expect(readCindySourceStatus(root)).resolves.not.toHaveProperty('currentBranch');
    },
  );

  it.each([{}, 3, 'invalid\nbranch', 'a'.repeat(256)])(
    'ignores an invalid persisted current branch %s',
    async (currentBranch) => {
      await writeFile(
        path.join(root, 'source-status.json'),
        JSON.stringify({
          status: 'ready',
          path: path.join(root, 'source'),
          branch: 'cindy-personal',
          currentBranch,
        }),
      );
      const restored = await readCindySourceStatus(root);
      expect(restored.currentBranch).toBeUndefined();
    },
  );

  it('refuses a dirty managed checkout instead of discarding its changes', async () => {
    const sourcePath = path.join(root, 'source');
    await createExistingCheckout(sourcePath);
    const env = {
      platform: 'win32',
      probe: vi.fn(probeReadyTool),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
      if (args[0] === 'for-each-ref') return 'refs/heads/main';
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
      probe: vi.fn(probeReadyTool),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'clone') {
        await expect(access(sourcePath)).rejects.toThrow();
        return '';
      }
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567';
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

  it('rebuilds an incomplete existing checkout instead of treating it as dirty', async () => {
    const sourcePath = path.join(root, 'source');
    await mkdir(path.join(sourcePath, '.git'), { recursive: true });
    const env = {
      platform: 'win32',
      probe: vi.fn(probeReadyTool),
      processEnvironment: () => ({}),
    } as unknown as MakeToolchainEnvironment;
    vi.mocked(runSourceGit).mockImplementation(async (_env, args) => {
      if (args[0] === 'ls-remote') return '0123456789abcdef\trefs/heads/main';
      if (args[0] === 'remote') return CINDY_SOURCE_REPOSITORY;
      if (args[0] === 'for-each-ref') return 'refs/heads/main';
      if (args[0] === 'clone') {
        await expect(access(sourcePath)).rejects.toThrow();
        return '';
      }
      if (args[0] === 'rev-parse') return '0123456789abcdef0123456789abcdef01234567';
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
    await createExistingCheckout(sourcePath);
    const env = {
      platform: 'win32',
      probe: vi.fn(probeReadyTool),
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
