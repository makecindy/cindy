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
  it('starts the app-server without a visible Windows console', () => {
    mocks.spawn.mockReturnValue(makeChild());

    createStdioTransport({ binaryPath: '/codex', cwd: '/workspace' });

    expect(mocks.spawn).toHaveBeenCalledWith(
      '/codex',
      ['app-server'],
      expect.objectContaining({
        cwd: '/workspace',
        shell: false,
        windowsHide: true,
      }),
    );
  });

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

describe('close() 强杀兜底 (#3699)', () => {
  it('SIGTERM 后进程未退出 → 宽限期到点补 SIGKILL(卡死 app-server 不再活体泄漏)', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      await transport.close();
      expect(child.kill).toHaveBeenCalledWith('SIGTERM');
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');

      // 进程无视 SIGTERM(exitCode/signalCode 保持 null)→ 宽限期后强杀。
      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('宽限期内正常退出 → 不发 SIGKILL', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      await transport.close();
      child.signalCode = 'SIGTERM';
      child.emit('exit', null, 'SIGTERM');
      vi.advanceTimersByTime(5_000);
      expect(child.kill).toHaveBeenCalledTimes(1); // 仅 SIGTERM
      expect(child.kill).not.toHaveBeenCalledWith('SIGKILL');
    } finally {
      vi.useRealTimers();
    }
  });

  it('close() 前已退出 → 全程不发信号', async () => {
    vi.useFakeTimers();
    try {
      const child = makeChild();
      mocks.spawn.mockReturnValue(child);
      const transport = createStdioTransport({ binaryPath: '/codex' });

      child.exitCode = 0;
      child.emit('exit', 0, null);
      await transport.close();
      vi.advanceTimersByTime(5_000);
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
