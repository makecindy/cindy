import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  createInterface: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mocks.spawn }));
vi.mock('node:readline', () => ({ createInterface: mocks.createInterface }));

import { createStdioTransport } from './stdioTransport.js';

function makeEmitterStream() {
  const stream = new EventEmitter() as EventEmitter & { setEncoding: ReturnType<typeof vi.fn> };
  stream.setEncoding = vi.fn();
  return stream;
}

function makeChild(pid = 4321) {
  const child = new EventEmitter() as EventEmitter & {
    pid: number;
    stdout: ReturnType<typeof makeEmitterStream>;
    stderr: ReturnType<typeof makeEmitterStream>;
    stdin: {
      writable: boolean;
      write: ReturnType<typeof vi.fn>;
      end: ReturnType<typeof vi.fn>;
    };
    exitCode: number | null;
    signalCode: string | null;
    kill: ReturnType<typeof vi.fn>;
  };
  child.pid = pid;
  child.stdout = makeEmitterStream();
  child.stderr = makeEmitterStream();
  child.stdin = {
    writable: true,
    write: vi.fn((_line, _encoding, callback: (error?: Error) => void) => {
      callback();
      return true;
    }),
    end: vi.fn(),
  };
  child.exitCode = null;
  child.signalCode = null;
  child.kill = vi.fn();
  return child;
}

beforeEach(() => {
  const readline = new EventEmitter() as EventEmitter & { close: ReturnType<typeof vi.fn> };
  readline.close = vi.fn();
  mocks.createInterface.mockReset().mockReturnValue(readline);
  mocks.spawn.mockReset();
});

describe('createStdioTransport process observer', () => {
  it('spawn 时登记一次，主动 close 时只清理一次', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const onProcessSpawned = vi.fn(() => dispose);
    const transport = createStdioTransport({ binaryPath: '/codex', onProcessSpawned });

    expect(onProcessSpawned).toHaveBeenCalledWith(4321);
    await transport.close();
    await transport.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('自然退出时清理；随后 close 不重复清理', async () => {
    const child = makeChild();
    mocks.spawn.mockReturnValue(child);
    const dispose = vi.fn();
    const transport = createStdioTransport({
      binaryPath: '/codex',
      onProcessSpawned: () => dispose,
    });

    child.emit('exit', 0, null);
    await transport.close();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('观察器抛错不影响 transport 启动', () => {
    mocks.spawn.mockReturnValue(makeChild());
    expect(() => createStdioTransport({
      binaryPath: '/codex',
      onProcessSpawned: () => {
        throw new Error('observer failed');
      },
    })).not.toThrow();
  });
});
