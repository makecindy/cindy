import { describe, expect, it, vi } from 'vitest';
import { prepareCindyMakeEnvironment } from '../prepare.js';
import type { MakeToolchainEnvironment } from '../toolchainEnvironment.js';
import type { MakeDoctorReport, MakeToolId } from '../../../shared/cindyMakeDoctor.js';
import { DownloadError } from '../../downloader/index.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
const versions: Record<MakeToolId, string> = {
  git: 'git version 2.55.0',
  gitLfs: 'git-lfs/3.8.0',
  node: 'v22.23.2',
  pnpm: '10.33.2',
  python: 'Python 3.13.15',
};
function harness(present: MakeToolId[] = []) {
  const available = new Set(present);
  const env: MakeToolchainEnvironment = {
    platform: 'win32',
    arch: 'x64',
    probe: vi.fn<MakeToolchainEnvironment['probe']>(async (command, args) => {
      const id = (
        command === 'git' && args[0] === 'lfs'
          ? 'gitLfs'
          : command.startsWith('py')
            ? 'python'
            : command
      ) as MakeToolId;
      return { status: available.has(id) ? 'ok' : 'missing', stdout: versions[id] };
    }),
    native: async () => ({ status: 'missing', stdout: '' }),
    storage: async () => ({ path: '/injected-data', writable: true, freeGiB: 40 }),
    useTool: (id) => {
      available.add(id);
    },
    validateTool: vi.fn(async () => true),
    processEnvironment: () => ({}),
  };
  const install = vi.fn<NonNullable<Parameters<typeof prepareCindyMakeEnvironment>[5]>>(
    async (input) => {
      input.onProgress({
        status: 'downloading',
        progress: { loaded: 50, total: 100, percent: 50 },
      });
      input.onProgress({ status: 'installing' });
      return '/injected-tools/' + input.artifact.id;
    },
  );
  const controller = new AbortController();
  const snapshots: MakeDoctorReport[] = [];
  const run = () =>
    prepareCindyMakeEnvironment(
      'run',
      env,
      '/injected-tools',
      controller.signal,
      (report) => snapshots.push(report),
      install,
    );
  return { env, available, install, controller, snapshots, run };
}

describe('native Make environment preparation', () => {
  it.each(['python', 'py'])(
    'reuses compatible %s when python3 is too old, without downloading Python',
    async (alternative) => {
      const h = harness(['git', 'gitLfs', 'node', 'pnpm', 'python']);
      const original = h.env.probe;
      h.env.probe = (command, args, signal) => {
        if (command.startsWith('py'))
          return Promise.resolve({
            status: 'ok',
            stdout: command === alternative ? 'Python 3.13.15' : 'Python 3.8.0',
          });
        return original(command, args, signal);
      };
      const result = await h.run();
      expect(result.checks.find((row) => row.id === 'python')).toMatchObject({
        status: 'passed',
        version: '3.13.15',
      });
      expect(h.install).not.toHaveBeenCalled();
    },
  );
  it('installs missing portable tools in dependency order and automatically rechecks, keeping system compilers visible', async () => {
    const h = harness();
    const result = await h.run();
    expect(h.install.mock.calls.map(([input]) => input.artifact.id)).toEqual([
      'git',
      'node',
      'pnpm',
      'python',
      'gitLfs',
    ]);
    expect(result).toMatchObject({ mode: 'prepare', status: 'completed' });
    expect(result.checks.filter((row) => row.status !== 'passed')).toEqual([
      { id: 'native', status: 'missing', path: undefined, reason: 'nativeWindows' },
    ]);
    expect(h.snapshots.at(-1)).toEqual(result);
    expect(h.snapshots.slice(0, -1).every((snapshot) => snapshot.status === 'running')).toBe(true);
    expect(
      h.snapshots.some((snapshot) => snapshot.checks.some((row) => row.progress?.percent === 50)),
    ).toBe(true);
  });
  it('does not download compatible existing tools or prompt for continuation', async () => {
    const h = harness(['git', 'gitLfs', 'node', 'pnpm', 'python']);
    const result = await h.run();
    expect(h.install).not.toHaveBeenCalled();
    expect(result.checks.find((row) => row.id === 'node')?.status).toBe('passed');
  });
  it('rechecks dependent pnpm after installing Node, avoiding an unnecessary pnpm download', async () => {
    const h = harness(['git', 'gitLfs', 'python']);
    const use = h.env.useTool;
    h.env.useTool = (id, executable) => {
      use(id, executable);
      if (id === 'node') h.available.add('pnpm');
    };
    await h.run();
    expect(h.install.mock.calls.map(([input]) => input.artifact.id)).toEqual(['node']);
  });
  it.each(['darwin', 'linux'])(
    'leaves system Git/compiler installation to %s, but prepares other portable tools',
    async (platform) => {
      const h = harness();
      h.env.platform = platform;
      await h.run();
      expect(h.install.mock.calls.map(([input]) => input.artifact.id)).toEqual([
        'node',
        'pnpm',
        'python',
      ]);
    },
  );
  it.each(['unsupported', 'readonly', 'full'])(
    'does not download when host/storage is %s',
    async (kind) => {
      const h = harness();
      if (kind === 'unsupported') h.env.arch = 'ia32';
      else
        h.env.storage = async () => ({
          path: '/injected',
          writable: kind !== 'readonly',
          freeGiB: kind === 'full' ? 0.5 : 20,
        });
      await h.run();
      expect(h.install).not.toHaveBeenCalled();
    },
  );
  it('retains a checksum error across later successful installs and never marks the failed tool as passed', async () => {
    const h = harness(['git', 'gitLfs']);
    const install = h.install.getMockImplementation()!;
    h.install.mockImplementation(async (input) => {
      if (input.artifact.id === 'node') throw new DownloadError('CHECKSUM', 'private response');
      return install(input);
    });
    const result = await h.run();
    expect(result.checks.find((row) => row.id === 'node')).toEqual({
      id: 'node',
      status: 'failed',
      reason: 'checksum',
    });
    expect(result.checks.find((row) => row.id === 'python')?.status).toBe('passed');
    expect(JSON.stringify(result)).not.toContain('private');
  });
  it.each([undefined, 'timeout'])(
    'settles all active rows and stops later downloads after cancellation (%s)',
    async (reason) => {
      const h = harness();
      h.install.mockImplementation(async (input) => {
        input.onProgress({ status: 'downloading' });
        h.controller.abort(reason);
        throw new Error('stopped');
      });
      const result = await h.run();
      expect(h.install).toHaveBeenCalledTimes(1);
      expect(result.status).toBe(reason === 'timeout' ? 'failed' : 'cancelled');
      expect(
        result.checks.some((row) =>
          ['checking', 'pending', 'downloading', 'installing'].includes(row.status),
        ),
      ).toBe(false);
    },
  );
});
