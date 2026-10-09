import { spawnSync } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { spawnPiSubagentRunner } from '../piSubagentRunnerHost.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const platformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform');

beforeEach(() => {
  // Never signal a real PID or run taskkill from this synthetic process fixture.
  vi.spyOn(process, 'kill').mockReturnValue(true);
  vi.mocked(spawnSync).mockReset().mockReturnValue({
    pid: 0, output: [], stdout: '', stderr: '', status: 1, signal: null,
  });
});

afterEach(() => {
  if (platformDescriptor) Object.defineProperty(process, 'platform', platformDescriptor);
  vi.restoreAllMocks();
});

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

  it.each(['darwin', 'linux', 'win32'])('signals SIGTERM on %s, falling back when taskkill fails', (platform) => {
    // Only signal routing is simulated; the synthetic launch layout uses host paths.
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: platform });
    const child = new FakeUtilityProcess();
    const fork = vi.fn(() => child);
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(path.sep, 'tmp', runId);
    const processHandle = spawnPiSubagentRunner({
      runId,
      runDir,
      runnerFile: path.join(runDir, 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp',
      env: {},
    }, fork as never);
    expect(processHandle.kill('SIGTERM')).toBe(true);
    expect(process.kill).toHaveBeenCalledWith(child.pid, 'SIGTERM');
    if (platform === 'win32') {
      expect(spawnSync).toHaveBeenCalledWith('taskkill', ['/PID', String(child.pid), '/T'], {
        windowsHide: true, stdio: 'ignore', timeout: 5_000,
      });
    } else {
      expect(spawnSync).not.toHaveBeenCalled();
    }
    expect(child.kill).not.toHaveBeenCalled();
  });

  it.each(['SIGTERM', 'SIGKILL'] as const)('uses successful Windows taskkill for %s with /F only for SIGKILL', (signal) => {
    Object.defineProperty(process, 'platform', { ...platformDescriptor, value: 'win32' });
    vi.mocked(spawnSync).mockReturnValue({
      pid: 0, output: [], stdout: '', stderr: '', status: 0, signal: null,
    });
    const child = new FakeUtilityProcess();
    const runId = '123e4567-e89b-42d3-a456-4266141740aa';
    const runDir = path.join(path.sep, 'tmp', runId);
    const processHandle = spawnPiSubagentRunner({
      runId, runDir,
      runnerFile: path.join(runDir, 'runner.cjs'),
      configFile: path.join(runDir, 'config.json'),
      cwd: '/tmp', env: {},
    }, vi.fn(() => child) as never);

    expect(processHandle.kill(signal)).toBe(true);
    expect(spawnSync).toHaveBeenCalledWith('taskkill',
      ['/PID', String(child.pid), '/T', ...(signal === 'SIGKILL' ? ['/F'] : [])],
      { windowsHide: true, stdio: 'ignore', timeout: 5_000 });
    expect(process.kill).not.toHaveBeenCalled();
    expect(child.kill).not.toHaveBeenCalled();
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
