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
  onStderr?: (chunk: string) => void;
} = {}) {
  return spawnObservedClaudeProcess({
    spawnOptions: {
      command: '/claude',
      args: ['--output-format', 'stream-json'],
      cwd: '/work',
      env: {},
      signal: new AbortController().signal,
    },
    ...overrides,
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('spawnObservedClaudeProcess', () => {
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
});
