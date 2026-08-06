import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ spawn: vi.fn() }));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));

import { PiRpcProcess } from './rpc-client.js';

function makeStream() {
  return new EventEmitter();
}

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: EventEmitter;
    stderr: EventEmitter;
    stdin: { write: ReturnType<typeof vi.fn> };
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = makeStream();
  child.stderr = makeStream();
  child.stdin = { write: vi.fn() };
  child.kill = vi.fn();
  return child;
}

function createProcess(onProcessSpawned?: (pid: number) => void | (() => void)) {
  const logger = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    child: vi.fn(),
  };
  logger.child.mockReturnValue(logger);
  return new PiRpcProcess({
    binaryPath: '/pi',
    args: ['--mode', 'rpc'],
    cwd: '/work',
    env: {},
    logger,
    onEvent: vi.fn(),
    onExit: vi.fn(),
    onProcessSpawned,
  });
}

beforeEach(() => {
  mocks.spawn.mockReset();
});

describe('PiRpcProcess process observer', () => {
  it('registers the concrete PID and disposes that generation once on close', () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const onProcessSpawned = vi.fn(() => dispose);

    createProcess(onProcessSpawned);
    expect(onProcessSpawned).toHaveBeenCalledWith(4321);

    child.emit('close', 0, null);
    child.emit('close', 0, null);
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('observer failure does not block process startup', () => {
    mocks.spawn.mockReturnValue(makeChild());
    expect(() =>
      createProcess(() => {
        throw new Error('observer failed');
      }),
    ).not.toThrow();
  });
});
