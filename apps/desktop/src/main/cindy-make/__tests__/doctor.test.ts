import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import {
  checkCindyMakeEnvironment,
  isSupportedMakeHost,
  type MakeDoctorEnvironment,
  type DoctorProbeResult,
} from '../doctor.js';
import { doctorSearchDirectories } from '../doctorEnvironment.js';
import type { MakeDoctorReport } from '../../../shared/cindyMakeDoctor.js';

function environment(overrides: Partial<MakeDoctorEnvironment> = {}): MakeDoctorEnvironment {
  const versions: Record<string, string> = {
    'git --version': 'git version 2.55.0.windows.1',
    'git lfs version': 'git-lfs/3.7.1 (GitHub)',
    'node --version': 'v22.12.0',
    'pnpm --version': '10.33.2',
    'python3 --version': 'Python 3.13.0',
  };
  return {
    platform: 'win32',
    arch: 'x64',
    probe: vi.fn<MakeDoctorEnvironment['probe']>(async (command, args) => ({
      status: 'ok',
      stdout: versions[[command, ...args].join(' ')] ?? '',
      path: `/tools/${command}`,
    })),
    native: vi.fn<MakeDoctorEnvironment['native']>(async () => ({ status: 'ok', stdout: '' })),
    storage: vi.fn(async () => ({ path: '/cindy-data', writable: true, freeGiB: 24 })),
    ...overrides,
  };
}

describe('read-only personal-build diagnostics', () => {
  it.each([
    ['darwin', 'Python 3.9.0', 'incompatible'],
    ['darwin', 'Python 3.10.0', 'passed'],
    ['win32', 'Python 3.8.0', 'incompatible'],
    ['win32', 'Python 3.9.0', 'passed'],
    ['linux', 'Python 3.8.0', 'incompatible'],
    ['linux', 'Python 3.9.0', 'passed'],
  ])('applies the Python requirement for %s: %s', async (platform, stdout, status) => {
    const env = environment({ platform });
    const original = env.probe;
    env.probe = (command, args, signal) =>
      command === 'python3'
        ? Promise.resolve({ status: 'ok', stdout })
        : original(command, args, signal);
    const report = await checkCindyMakeEnvironment('python', env, new AbortController().signal);
    expect(report.checks.find((check) => check.id === 'python')?.status).toBe(status);
  });
  it('can cancel a stuck discovery read and marks a deadline as failed instead of user-stopped', async () => {
    const controller = new AbortController();
    const env = environment({ probe: () => new Promise(() => {}) });
    const pending = checkCindyMakeEnvironment('timeout', env, controller.signal);
    controller.abort('timeout');
    const report = await pending;
    expect(report.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'git')).toMatchObject({
      status: 'failed',
      reason: 'timeout',
    });
    expect(env.native).not.toHaveBeenCalled();
  });
  it.each([
    ['win32', 'x64'],
    ['darwin', 'x64'],
    ['darwin', 'arm64'],
    ['linux', 'x64'],
    ['linux', 'arm64'],
  ])('covers the Desktop release host %s/%s', async (platform, arch) => {
    const snapshots: MakeDoctorReport[] = [];
    const report = await checkCindyMakeEnvironment(
      'run',
      environment({ platform, arch }),
      new AbortController().signal,
      (snapshot) => snapshots.push(snapshot),
    );
    expect(report.status).toBe('completed');
    expect(report.checks.every((check) => check.status === 'passed')).toBe(true);
    expect(snapshots[0].checks.every((check) => check.status === 'pending')).toBe(true);
    expect(snapshots.at(-1)).toEqual(report);
    expect(
      snapshots.filter((snapshot) => snapshot.checks.some((check) => check.status === 'checking'))
        .length,
    ).toBeGreaterThan(0);
  });

  it.each([
    ['win32', 'arm64'],
    ['linux', 'ia32'],
    ['freebsd', 'x64'],
  ])('does not claim unsupported %s/%s can build', (platform, arch) => {
    expect(isSupportedMakeHost(platform, arch)).toBe(false);
  });

  it.each([
    ['node', 'v22.11.0', 'incompatible'],
    ['node', 'v22.12.0', 'passed'],
    ['node', 'v24.1.0', 'passed'],
    ['node', 'v22.12.0-rc.1', 'failed'],
    ['pnpm', '10.6.9', 'incompatible'],
    ['pnpm', '10.7.0', 'passed'],
    ['pnpm', '11.0.0', 'incompatible'],
    ['pnpm', 'download failed; secret=hidden', 'failed'],
  ])('checks the executable version: %s %s → %s', async (command, stdout, status) => {
    const env = environment();
    const original = env.probe;
    env.probe = (name, args, signal) =>
      name === command ? Promise.resolve({ status: 'ok', stdout }) : original(name, args, signal);
    const report = await checkCindyMakeEnvironment('version', env, new AbortController().signal);
    expect(report.checks.find((check) => check.id === command)?.status).toBe(status);
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('keeps requirement checks aligned with the repository manifest', () => {
    const manifest = JSON.parse(
      readFileSync(new URL('../../../../../../package.json', import.meta.url), 'utf8'),
    );
    expect(manifest.engines).toMatchObject({ node: '>=22.12', pnpm: '>=10.7 <11' });
    expect(manifest.packageManager.split('+')[0]).toBe('pnpm@10.33.2');
  });

  it('reports missing Git, skips dependent LFS, and continues other checks', async () => {
    const env = environment();
    const original = env.probe;
    env.probe = vi.fn<MakeDoctorEnvironment['probe']>((name, args, signal) =>
      name === 'git'
        ? Promise.resolve({ status: 'missing', stdout: '' })
        : original(name, args, signal),
    );
    const report = await checkCindyMakeEnvironment('missing', env, new AbortController().signal);
    expect(report.checks.find((check) => check.id === 'gitLfs')).toMatchObject({
      status: 'missing',
      reason: 'dependency',
    });
    expect(env.probe).not.toHaveBeenCalledWith('git', ['lfs', 'version'], expect.anything());
    expect(report.checks.find((check) => check.id === 'node')?.status).toBe('passed');
  });

  it.each(['missing', 'timeout', 'failed'] as const)(
    'does not turn a %s probe into a passing result',
    async (status) => {
      const report = await checkCindyMakeEnvironment(
        'error',
        environment({ probe: async () => ({ status, stdout: 'v24.0.0' }) }),
        new AbortController().signal,
      );
      expect(report.checks.find((check) => check.id === 'node')).toMatchObject({
        status: status === 'missing' ? 'missing' : 'failed',
        reason:
          status === 'timeout' ? 'timeout' : status === 'missing' ? 'notFound' : 'probeFailed',
      });
    },
  );

  it('cancellation stops later probes and emits a terminal snapshot', async () => {
    const controller = new AbortController();
    const env = environment({
      probe: vi.fn(async (): Promise<DoctorProbeResult> => {
        controller.abort();
        return { status: 'ok', stdout: 'git version 2.55.0' };
      }),
    });
    const snapshots: MakeDoctorReport[] = [];
    const report = await checkCindyMakeEnvironment('stop', env, controller.signal, (snapshot) =>
      snapshots.push(snapshot),
    );
    expect(report.status).toBe('cancelled');
    expect(env.probe).toHaveBeenCalledTimes(1);
    expect(env.native).not.toHaveBeenCalled();
    expect(env.storage).not.toHaveBeenCalled();
    expect(report.checks.some((check) => ['checking', 'pending'].includes(check.status))).toBe(
      false,
    );
    expect(snapshots.at(-1)).toEqual(report);
  });

  it('a failed native or storage check cannot stop remaining diagnostics or leak exception text', async () => {
    const report = await checkCindyMakeEnvironment(
      'failed',
      environment({
        native: async () => {
          throw new Error('secret');
        },
        storage: async () => ({ path: '/data', writable: true, freeGiB: 3 }),
      }),
      new AbortController().signal,
    );
    expect(report.checks.find((check) => check.id === 'native')?.status).toBe('failed');
    expect(report.checks.find((check) => check.id === 'storage')).toMatchObject({
      status: 'warning',
      freeGiB: 3,
    });
    expect(JSON.stringify(report)).not.toContain('secret');
  });

  it('write permission failure is an error even with ample free space', async () => {
    const report = await checkCindyMakeEnvironment(
      'storage',
      environment({ storage: async () => ({ path: '/data', writable: false, freeGiB: 100 }) }),
      new AbortController().signal,
    );
    expect(report.checks.find((check) => check.id === 'storage')?.status).toBe('failed');
  });

  it('finds common global tool locations without searching the user project', () => {
    expect(
      doctorSearchDirectories(
        {
          PATH: '.;tools;C:\\Tools',
          APPDATA: 'C:\\User\\AppData\\Roaming',
          ProgramFiles: 'C:\\Program Files',
        },
        'win32',
        'C:\\User',
      ),
    ).toEqual(
      expect.arrayContaining([
        'C:\\Tools',
        'C:\\Program Files\\Git\\cmd',
        'C:\\User\\AppData\\Roaming\\npm',
      ]),
    );
    expect(doctorSearchDirectories({ PATH: '.:tools:/usr/bin' }, 'darwin', '/Users/user')).toEqual(
      expect.arrayContaining(['/opt/homebrew/bin', '/Users/user/.local/bin']),
    );
    expect(
      doctorSearchDirectories({ PATH: '.:tools:/usr/bin' }, 'linux', '/home/user'),
    ).not.toContain('.');
  });
});
