import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CINDY_SOURCE_REPOSITORY,
  readCindySourceStatus,
  prepareCindySource,
  sourceTarget,
} from '../sourcePreparation.js';
import {
  selectMakeToolchainEnvironment,
  type MakeToolchainEnvironment,
} from '../toolchainEnvironment.js';
import { runSourceGit } from '../sourceGit.js';
import type { DoctorProbeResult } from '../doctor.js';

vi.mock('../sourceGit.js', () => ({ runSourceGit: vi.fn() }));

describe('Git-only source preparation', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'cindy-make-source-'));
    vi.mocked(runSourceGit).mockReset();
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
      expect(result).toMatchObject({ status: 'ready', commit: '0123456789abcdef' });
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
