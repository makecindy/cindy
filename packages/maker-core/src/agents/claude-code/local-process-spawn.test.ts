import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { spawnObservedClaudeProcess } from './local-process-spawn.js';

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdin: EventEmitter;
    stdout: EventEmitter;
    stderr: EventEmitter;
    killed: boolean;
    exitCode: number | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdin = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.exitCode = null;
  child.kill = vi.fn();
  return child;
}

function spawnProcess(overrides: {
  registerProcess?: (pid: number) => void | (() => void);
  trackDebugFile?: () => () => void;
  onStderr?: (chunk: string) => void;
  onExit?: (details: {
    pid: number | undefined;
    exitCode: number | null;
    signal: NodeJS.Signals | null;
    abortRequested: boolean;
  }) => void;
  signal?: AbortSignal;
} = {}) {
  return spawnObservedClaudeProcess({
    spawnOptions: {
      command: '/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work',
      env: {},
      signal: overrides.signal ?? new AbortController().signal,
    },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('spawnObservedClaudeProcess', () => {
  it('releases debug tracking once even when the process observer fails', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const release = vi.fn();
    const trackDebugFile = vi.fn(() => release);
    spawnProcess({ registerProcess: () => { throw new Error('observer'); }, trackDebugFile });
    expect(trackDebugFile).toHaveBeenCalledOnce();
    child.emit('error', new Error('spawn'));
    child.emit('exit', 1, null);
    expect(release).toHaveBeenCalledOnce();
  });
  it('registers the concrete PID and disposes that generation once', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const registerProcess = vi.fn(() => dispose);

    spawnProcess({ registerProcess });
    expect(registerProcess).toHaveBeenCalledWith(4321);

    child.emit('exit', 0, null);
    child.emit('error', new Error('late error'));
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('drains and forwards stderr without making observer failures fatal', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const onStderr = vi.fn();

    expect(() =>
      spawnProcess({
        registerProcess: () => {
          throw new Error('observer failed');
        },
        onStderr,
      }),
    ).not.toThrow();
    child.stderr.emit('data', Buffer.from('diagnostic'));
    expect(onStderr).toHaveBeenCalledWith('diagnostic');
  });

  it('reports process exit details and whether a signal was requested by the host', () => {
    const child = makeChild(9876);
    mocks.spawn.mockReturnValue(child);
    const onExit = vi.fn();
    const controller = new AbortController();

    spawnProcess({ onExit, signal: controller.signal });
    child.emit('exit', null, 'SIGTERM');

    expect(onExit).toHaveBeenCalledWith({
      pid: 9876,
      exitCode: null,
      signal: 'SIGTERM',
      abortRequested: false,
    });

    const requestedChild = makeChild(9877);
    mocks.spawn.mockReturnValue(requestedChild);
    const requestedExit = vi.fn();
    const requestedController = new AbortController();
    requestedController.abort();

    spawnProcess({ onExit: requestedExit, signal: requestedController.signal });
    requestedChild.emit('exit', null, 'SIGTERM');

    expect(requestedExit).toHaveBeenCalledWith({
      pid: 9877,
      exitCode: null,
      signal: 'SIGTERM',
      abortRequested: true,
    });
  });
});
