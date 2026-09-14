import { EventEmitter } from 'node:events';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { spawn } from 'node:child_process';
import { createMakeDoctorEnvironment, runDoctorProbe } from '../doctorEnvironment.js';
import { selectMakeToolchainEnvironment } from '../toolchainEnvironment.js';

vi.mock('../../logger.js', () => ({ createLogger: () => ({ warn: vi.fn() }) }));

vi.mock('node:child_process', () => ({ spawn: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(async () => {}),
  stat: vi.fn(async () => ({ isFile: () => true })),
  readFile: vi.fn(),
  readdir: vi.fn(),
  statfs: vi.fn(),
}));

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 424242,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
    kill: vi.fn(),
  });
}
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.mocked(spawn).mockReset();
});

describe('bounded diagnostic probes', () => {
  it('the install test ignores portable system tools, including Git-dispatched LFS and Python aliases', async () => {
    const env = createMakeDoctorEnvironment(os.tmpdir(), {}, { ignoreSystemTools: true });
    for (const command of ['node', 'pnpm', 'python3', 'python', 'py']) {
      await expect(
        env.probe(command, ['--version'], new AbortController().signal),
      ).resolves.toMatchObject({ status: 'missing' });
    }
    await expect(
      env.probe('git', ['lfs', 'version'], new AbortController().signal),
    ).resolves.toMatchObject({ status: 'missing' });
    if (process.platform === 'win32')
      await expect(
        env.probe('git', ['--version'], new AbortController().signal),
      ).resolves.toMatchObject({ status: 'missing' });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('the install test still probes compiler prerequisites through the normal search path', async () => {
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    const checking = createMakeDoctorEnvironment(
      os.tmpdir(),
      {},
      { ignoreSystemTools: true },
    ).probe('g++', ['--version'], new AbortController().signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    spawned.emit('close', 0);
    await expect(checking).resolves.toMatchObject({ status: 'ok' });
  });

  it('the Windows install test exposes missing native prerequisites even when VS is installed', async () => {
    if (process.platform !== 'win32') return;
    const env = createMakeDoctorEnvironment(os.tmpdir(), {}, { ignoreSystemTools: true });
    await expect(env.native(new AbortController().signal)).resolves.toMatchObject({
      status: 'missing',
    });
    expect(spawn).not.toHaveBeenCalled();
  });

  it('the install test verifies and reuses managed Node instead of reporting it missing forever', async () => {
    const executable = path.join(os.tmpdir(), 'managed', 'node');
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    const env = selectMakeToolchainEnvironment(
      (paths) => createMakeDoctorEnvironment(os.tmpdir(), paths, { ignoreSystemTools: true }),
      { node: executable },
    );
    const checking = env.probe('node', ['--version'], new AbortController().signal);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledTimes(1));
    expect(vi.mocked(spawn).mock.calls[0][0]).toBe(executable);
    spawned.stdout.emit('data', Buffer.from('v22.23.2'));
    spawned.emit('close', 0);
    await expect(checking).resolves.toMatchObject({
      status: 'ok',
      source: 'managed',
      path: executable,
    });
  });
  it('executes a fixed version probe hidden, closes stdin, and disables automatic package downloads without changing the parent environment', async () => {
    const processEnv = { ...process.env };
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    const checking = createMakeDoctorEnvironment(os.tmpdir()).probe(
      'pnpm',
      ['--version'],
      new AbortController().signal,
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    const options = vi.mocked(spawn).mock.calls[0][2];
    expect(options).toMatchObject({
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        COREPACK_ENABLE_NETWORK: '0',
        COREPACK_ENABLE_AUTO_PIN: '0',
        npm_config_manage_package_manager_versions: 'false',
      },
    });
    expect(options).not.toHaveProperty('shell', true);
    spawned.stdout.emit('data', Buffer.from('10.33.2\n'));
    spawned.emit('close', 0);
    await expect(checking).resolves.toMatchObject({ status: 'ok', stdout: '10.33.2' });
    expect(process.env).toEqual(processEnv);
  });

  it('bounds output and does not return stderr on failures', async () => {
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const checking = runDoctorProbe(
      'node',
      ['--version'],
      os.tmpdir(),
      new AbortController().signal,
      {},
    );
    spawned.stderr.emit('data', Buffer.alloc(20_000, 'x'));
    await expect(checking).resolves.toMatchObject({ status: 'failed', stdout: '' });
    spawned.emit('close', 0);
  });

  it('times out and ignores a late successful exit', async () => {
    vi.useFakeTimers();
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    vi.spyOn(process, 'kill').mockReturnValue(true);
    const checking = runDoctorProbe(
      'node',
      ['--version'],
      os.tmpdir(),
      new AbortController().signal,
      {},
    );
    await vi.advanceTimersByTimeAsync(4_000);
    spawned.emit('close', 0);
    await expect(checking).resolves.toMatchObject({ status: 'timeout', stdout: '' });
  });

  it('cancelled probes stop without waiting for process close', async () => {
    const spawned = child();
    vi.mocked(spawn).mockReturnValue(spawned as never);
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true);
    const controller = new AbortController();
    const checking = runDoctorProbe('node', ['--version'], os.tmpdir(), controller.signal, {});
    controller.abort();
    await expect(checking).resolves.toMatchObject({ status: 'failed' });
    if (process.platform === 'win32')
      expect(spawn).toHaveBeenLastCalledWith(
        expect.stringMatching(/taskkill\.exe$/),
        ['/pid', '424242', '/t', '/f'],
        expect.objectContaining({ windowsHide: true }),
      );
    else expect(kill).toHaveBeenCalledWith(-424242, 'SIGKILL');
  });

  it('a synchronous spawn failure settles without retaining a timeout', async () => {
    vi.mocked(spawn).mockImplementation(() => {
      throw new Error('private path');
    });
    await expect(
      runDoctorProbe('node', ['--version'], os.tmpdir(), new AbortController().signal, {}),
    ).resolves.toMatchObject({ status: 'failed', stdout: '' });
  });
});
