import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest';

import { spawnPiSubagentRunner } from '../piSubagentRunnerHost.js';

// Never let a fake PID reach the host's taskkill command.
vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

class FakeUtilityProcess extends EventEmitter {
  readonly pid = 2468;
  readonly kill = vi.fn(() => true);
}

describe('piSubagentRunnerHost', () => {
  it('uses the fixed utility-process entry and forwards only the staged runner paths', () => {
    const child = new FakeUtilityProcess();
    const fork = vi.fn(() => child);
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(path.sep, 'tmp', runId);
    const request = {
      runId,
      runDir,
      runnerFile: path.join(runDir, 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp',
      env: { TEST_VALUE: '1' },
    };
    const processHandle = spawnPiSubagentRunner(request, fork as never);

    expect(fork).toHaveBeenCalledWith(
      expect.stringMatching(/piSubagentRunnerProcess\.js$/),
      [path.resolve(request.runnerFile), path.resolve(request.configFile)],
      expect.objectContaining({
        cwd: '/tmp',
        env: { TEST_VALUE: '1' },
        stdio: 'ignore',
        serviceName: `cindy-pi-subagent:${runId}`,
      }),
    );

    const spawned = vi.fn();
    const exited = vi.fn();
    const closed = vi.fn();
    processHandle.once('spawn', spawned);
    processHandle.once('exit', exited);
    processHandle.once('close', closed);
    child.emit('message', { type: 'ready' });
    expect(spawned).toHaveBeenCalledTimes(1);

    child.emit('exit', 0);
    expect(exited).toHaveBeenCalledWith(0, null);
    expect(closed).toHaveBeenCalledWith(0, null);
  });

  it('keeps original absolute paths when a parent directory is a symlink', () => {
    const alias = `${path.sep}alias${path.sep}home`;
    const real = `${path.sep}real${path.sep}home`;
    const realpathSync = vi.spyOn(fs, 'realpathSync').mockImplementation((file) => {
      return String(file).split(alias).join(real);
    });
    const fork = vi.fn(() => new FakeUtilityProcess());
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(alias, runId);
    const request = {
      runId,
      runDir,
      runnerFile: path.join(runDir, 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp',
      env: {},
    };
    spawnPiSubagentRunner(request, fork as never);
    expect(fork).toHaveBeenCalledWith(
      expect.stringMatching(/piSubagentRunnerProcess\.js$/),
      [path.resolve(request.runnerFile), path.resolve(request.configFile)],
      expect.objectContaining({ cwd: '/tmp' }),
    );
    realpathSync.mockRestore();
  });

  it('accepts normalized paths inside the run directory', () => {
    const fork = vi.fn(() => new FakeUtilityProcess());
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(path.sep, 'tmp', runId);
    spawnPiSubagentRunner({
      runId,
      runDir,
      runnerFile: path.join(runDir, '.', 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp',
      env: {},
    }, fork as never);
    expect(fork).toHaveBeenCalledTimes(1);
  });

  describe('process-tree termination', () => {
    const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
    const spawnSyncMock = vi.mocked(spawnSync);
    let killSpy: MockInstance<typeof process.kill>;

    beforeEach(() => {
      spawnSyncMock.mockReset();
      spawnSyncMock.mockReturnValue({ status: 0 } as ReturnType<typeof spawnSync>);
      // Do not delegate any PID to the real process.kill, including on assertion failure.
      killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
    });
    afterEach(() => {
      Object.defineProperty(process, 'platform', platformDescriptor);
      vi.restoreAllMocks();
    });

    function handle(platform: NodeJS.Platform) {
      Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
      const child = new FakeUtilityProcess();
      const runId = '123e4567-e89b-42d3-a456-4266141740aa';
      const runDir = path.join(path.sep, 'tmp', runId);
      const runner = spawnPiSubagentRunner({
        runId, runDir, runnerFile: path.join(runDir, 'runner.cjs'),
        configFile: path.join(runDir, 'config.json'), cwd: '/tmp', env: {},
      }, vi.fn(() => child) as never);
      return { child, runner };
    }

    it.each(['SIGTERM', 'SIGKILL'] as const)('uses Windows taskkill for %s without signaling a fake PID', (signal) => {
      const { child, runner } = handle('win32');
      expect(runner.kill(signal)).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledExactlyOnceWith(
        'taskkill', ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
        { windowsHide: true, stdio: 'ignore', timeout: 5_000 },
      );
      expect(killSpy).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it.each([
      ['nonzero exit', { status: 1 }],
      ['spawn error', { status: 0, error: new Error('taskkill unavailable') }],
    ] as const)('falls back to a signal after taskkill %s', (_reason, result) => {
      const { child, runner } = handle('win32');
      spawnSyncMock.mockReturnValue(result as ReturnType<typeof spawnSync>);
      expect(runner.kill('SIGTERM')).toBe(true);
      expect(spawnSyncMock).toHaveBeenCalledTimes(1);
      expect(killSpy).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGTERM');
      expect(spawnSyncMock.mock.invocationCallOrder[0]).toBeLessThan(killSpy.mock.invocationCallOrder[0]);
      expect(child.kill).not.toHaveBeenCalled();
    });

    it.each(['darwin', 'linux'] as const)('signals directly on %s without taskkill', (platform) => {
      const { child, runner } = handle(platform);
      expect(runner.kill('SIGTERM')).toBe(true);
      expect(killSpy).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGTERM');
      expect(spawnSyncMock).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    });

    it.each([true, false])('returns the utility-process fallback result %s after both attempts fail', (result) => {
      const { child, runner } = handle('win32');
      spawnSyncMock.mockReturnValue({ status: 1 } as ReturnType<typeof spawnSync>);
      killSpy.mockImplementation(() => { throw new Error('process gone'); });
      child.kill.mockReturnValue(result);
      expect(runner.kill('SIGTERM')).toBe(result);
      expect(killSpy).toHaveBeenCalledExactlyOnceWith(child.pid, 'SIGTERM');
      expect(child.kill).toHaveBeenCalledExactlyOnceWith();
      expect(killSpy.mock.invocationCallOrder[0]).toBeLessThan(child.kill.mock.invocationCallOrder[0]);
    });
  });

  it('rejects runner or config paths outside the declared run directory', () => {
    const fork = vi.fn();
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(path.sep, 'tmp', runId);
    expect(() => spawnPiSubagentRunner({
      runId,
      runDir,
      runnerFile: path.join(path.sep, 'tmp', 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp',
      env: {},
    }, fork as never)).toThrow(/paths are invalid/);
    expect(fork).not.toHaveBeenCalled();
  });
});
