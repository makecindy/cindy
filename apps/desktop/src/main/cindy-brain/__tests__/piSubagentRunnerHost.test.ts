import { EventEmitter } from 'node:events';
import path from 'node:path';

import { describe, expect, it, vi } from 'vitest';

import { spawnPiSubagentRunner } from '../piSubagentRunnerHost.js';

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
      [request.runnerFile, request.configFile],
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

  it('signals SIGTERM to the utility-process pid so the runner can reap children', () => {
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
    const realKill = process.kill.bind(process);
    const killSpy = vi.spyOn(process, 'kill').mockImplementation(((pid: number, signal?: NodeJS.Signals | number) => {
      if (pid !== child.pid) return realKill(pid, signal);
      return true;
    }) as typeof process.kill);
    expect(processHandle.kill('SIGTERM')).toBe(true);
    expect(killSpy).toHaveBeenCalledWith(child.pid, 'SIGTERM');
    expect(child.kill).not.toHaveBeenCalled();
    killSpy.mockRestore();
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
