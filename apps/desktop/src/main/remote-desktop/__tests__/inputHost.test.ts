import { EventEmitter } from 'node:events';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DesktopInputHost } from '../inputHost';
import { HUMAN_INPUT_QUIET_MS, withAgentDesktopInput } from '../inputOwnership';
import { openWindowsDesktopConnection, readWindowsDesktopSupport } from '../windowsHost';

const platform = process.platform;
beforeEach(() => {
  vi.mocked(openWindowsDesktopConnection).mockReset();
  vi.mocked(readWindowsDesktopSupport).mockResolvedValue('ready');
});
afterEach(() => {
  vi.useRealTimers();
  Object.defineProperty(process, 'platform', { value: platform });
});
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

vi.mock('electron', () => ({
  app: {},
  screen: {
    getAllDisplays: () => [{ id: 1, bounds: { x: 0, y: 0, width: 100, height: 100 } }],
    dipToScreenPoint: (point: unknown) => point,
  },
}));
vi.mock('../windowsHost', () => ({
  openWindowsDesktopConnection: vi.fn(),
  readWindowsDesktopSupport: vi.fn(async () => 'ready'),
}));
function childProcess() {
  const child = Object.assign(new EventEmitter(), {
    pid: 1,
    stdout: new EventEmitter(),
    stderr: { resume() {} },
    stdin: Object.assign(new EventEmitter(), {
      destroyed: false,
      writableLength: 0,
      write: vi.fn(),
      end: vi.fn(),
    }),
    exitCode: null as number | null,
    signalCode: null,
    kill: vi.fn(),
  });
  return {
    child,
    typed: child as unknown as ChildProcessWithoutNullStreams,
    exit: () => {
      child.exitCode = 0;
      child.emit('exit', 0);
      child.emit('close', 0);
    },
  };
}
describe('native input lifecycle', () => {
  it('keeps an authorized service usable for manual keyboard input while an update is offered', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(readWindowsDesktopSupport).mockResolvedValueOnce('updateRequired');
    const connection = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    vi.mocked(openWindowsDesktopConnection).mockResolvedValueOnce(connection);
    const failure = vi.fn();
    const host = new DesktopInputHost(failure);
    await host.start('1');
    host.input([{ kind: 'text', text: 'fake-manual-input' }]);
    await flush();
    expect(connection.request).toHaveBeenCalledWith('[{"kind":"text","text":"fake-manual-input"}]');
    expect(failure).not.toHaveBeenCalled();
    host.stop();
    await flush();
  });

  it('releases held ordinary Windows input on lock without starting the SYSTEM service', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    vi.mocked(readWindowsDesktopSupport).mockResolvedValueOnce('missing');
    const c = childProcess();
    const spawn = vi.fn(() => {
      queueMicrotask(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
      return c.typed;
    });
    const host = new DesktopInputHost(vi.fn(), {
      resolveBinary: async () => '/test/helper',
      spawn,
    });
    await host.start('1');
    host.input([{ kind: 'key', code: 'ControlLeft', down: true }]);
    await flush();
    c.child.stdout.emit('data', Buffer.from('ok\n'));
    await flush();
    host.rebindForDesktopChange();
    await flush();
    expect(c.child.stdin.write).toHaveBeenLastCalledWith(
      '[{"kind":"release"}]\n',
      expect.any(Function),
    );
    expect(openWindowsDesktopConnection).not.toHaveBeenCalled();
    expect(c.child.stdin.end).not.toHaveBeenCalled();
    host.stop();
    c.exit();
    await flush();
  });

  it('rebinds on a native desktop transition without replaying old input or dropping control', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    let finish!: (line: string) => void;
    const previous = {
      request: vi.fn(() => new Promise<string>((resolve) => (finish = resolve))),
      close: vi.fn(),
    };
    const next = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    vi.mocked(openWindowsDesktopConnection)
      .mockResolvedValueOnce(previous)
      .mockResolvedValueOnce(next);
    const failure = vi.fn();
    const host = new DesktopInputHost(failure);
    await host.start('1');
    host.input([{ kind: 'text', text: 'old-screen-text' }]);
    await flush();
    host.input([{ kind: 'text', text: 'queued-old-screen-text' }]);
    finish('desktop_changed\n');
    await flush();
    await flush();
    expect(openWindowsDesktopConnection).toHaveBeenCalledTimes(2);
    expect(previous.close).toHaveBeenCalled();
    expect(previous.request).toHaveBeenCalledTimes(1);
    expect(next.request).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    host.input([{ kind: 'text', text: 'fresh-manual-input' }]);
    await flush();
    expect(next.request).toHaveBeenCalledWith('[{"kind":"text","text":"fresh-manual-input"}]');
    host.stop();
    await flush();
  });

  it('coalesces OS transition signals and discards input while rebinding', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const previous = { request: vi.fn().mockResolvedValue('desktop_changed\n'), close: vi.fn() };
    const next = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    let open!: (value: typeof next) => void;
    vi.mocked(openWindowsDesktopConnection)
      .mockResolvedValueOnce(previous)
      .mockImplementationOnce(() => new Promise((resolve) => (open = resolve)));
    const failure = vi.fn();
    const host = new DesktopInputHost(failure);
    await host.start('1');
    host.rebindForDesktopChange();
    host.rebindForDesktopChange();
    await flush();
    host.input([{ kind: 'text', text: 'during-transition' }]);
    open(next);
    await flush();
    expect(openWindowsDesktopConnection).toHaveBeenCalledTimes(2);
    expect(next.request).not.toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    host.stop();
    await flush();
  });

  it('does not restore native input after the viewer stops during a desktop transition', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const previous = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    const next = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    let open!: (value: typeof next) => void;
    vi.mocked(openWindowsDesktopConnection)
      .mockResolvedValueOnce(previous)
      .mockImplementationOnce(() => new Promise((resolve) => (open = resolve)));
    const failure = vi.fn();
    const host = new DesktopInputHost(failure);
    await host.start('1');
    host.rebindForDesktopChange();
    await flush();
    host.stop();
    open(next);
    await flush();
    expect(next.close).toHaveBeenCalled();
    expect(failure).not.toHaveBeenCalled();
    expect(() => host.input([{ kind: 'text', text: 'after-stop' }])).toThrow(
      'DESKTOP_INPUT_UNAVAILABLE',
    );
  });

  it('bounds transition retries and leaves genuine native failures in view-only handling', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const previous = { request: vi.fn().mockResolvedValue('ok\n'), close: vi.fn() };
    vi.mocked(openWindowsDesktopConnection)
      .mockResolvedValueOnce(previous)
      .mockRejectedValue(new Error('service unavailable'));
    const failure = vi.fn();
    const host = new DesktopInputHost(failure);
    await host.start('1');
    host.rebindForDesktopChange();
    await vi.advanceTimersByTimeAsync(500);
    expect(openWindowsDesktopConnection).toHaveBeenCalledTimes(4);
    expect(failure).toHaveBeenCalledOnce();
    host.stop();
    await flush();
  });

  it('retains Windows ownership until queued text and native release are acknowledged', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const replies: ((value: string) => void)[] = [];
    const connection = {
      request: vi.fn(() => new Promise<string>((resolve) => replies.push(resolve))),
      close: vi.fn(),
    };
    vi.mocked(openWindowsDesktopConnection).mockResolvedValueOnce(connection);
    const host = new DesktopInputHost(vi.fn());
    await host.start('1');
    host.input([{ kind: 'text', text: 'hello' }]);
    await flush();
    host.stop();
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
    replies.shift()!('ok\n');
    await flush();
    expect(connection.request).toHaveBeenLastCalledWith('[{"kind":"release"}]');
    vi.advanceTimersByTime(2000);
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
    replies.shift()!('ok\n');
    await flush();
    expect(connection.close).toHaveBeenCalled();
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });

  it('retains Windows ownership through the service shutdown deadline when release fails', async () => {
    vi.useFakeTimers();
    Object.defineProperty(process, 'platform', { value: 'win32' });
    const connection = { request: vi.fn().mockRejectedValue(new Error('closed')), close: vi.fn() };
    vi.mocked(openWindowsDesktopConnection).mockResolvedValueOnce(connection);
    const host = new DesktopInputHost(vi.fn());
    await host.start('1');
    host.stop();
    await flush();
    expect(connection.close).toHaveBeenCalled();
    vi.advanceTimersByTime(6499);
    await flush();
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
    vi.advanceTimersByTime(1);
    await flush();
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });
  it('waits for native completion of text and key-up instead of unlocking on stdin write', async () => {
    vi.useFakeTimers();
    const c = childProcess();
    let host: DesktopInputHost;
    const failure = vi.fn(() => host.stop());
    host = new DesktopInputHost(failure, {
      platform: 'darwin',
      resolveBinary: async () => '/test/helper',
      spawn: () => {
        void Promise.resolve().then(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      },
    });
    try {
      await host.start('1');
      host.input([{ kind: 'key', code: 'ShiftLeft', down: true }]);
      await flush();
      c.child.stdout.emit('data', Buffer.from('ok\n'));
      await flush();
      vi.advanceTimersByTime(301);
      await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
      host.input([
        { kind: 'key', code: 'ShiftLeft', down: false },
        { kind: 'text', text: 'hello' },
      ]);
      await flush();
      vi.advanceTimersByTime(301);
      await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
      c.child.stdout.emit('data', Buffer.from('o'));
      c.child.stdout.emit('data', Buffer.from('k\n'));
      await flush();
      vi.advanceTimersByTime(HUMAN_INPUT_QUIET_MS);
      await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
      expect(failure).not.toHaveBeenCalled();
    } finally {
      host.stop();
      c.exit();
      await flush();
    }
  });

  it('keeps heartbeats alive while an Agent primitive finishes, and never replays queued input after stop', async () => {
    vi.useFakeTimers();
    const c = childProcess();
    const host = new DesktopInputHost(vi.fn(), {
      platform: 'darwin',
      resolveBinary: async () => '/test/helper',
      spawn: () => {
        void Promise.resolve().then(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      },
    });
    let finish!: () => void;
    try {
      await host.start('1');
      const action = withAgentDesktopInput(
        () =>
          new Promise<void>((resolve) => {
            finish = resolve;
          }),
      );
      host.input([{ kind: 'text', text: 'must not replay' }]);
      vi.advanceTimersByTime(2000);
      await flush();
      expect(c.child.stdin.write).toHaveBeenCalledOnce();
      expect(c.child.stdin.write.mock.calls[0][0]).toBe('[]\n');
      c.child.stdout.emit('data', Buffer.from('ok\n'));
      await flush();
      host.stop();
      c.exit();
      finish();
      await action;
      await flush();
      expect(c.child.stdin.write).toHaveBeenCalledOnce();
    } finally {
      finish?.();
      host.stop();
      c.exit();
      await flush();
    }
  });

  it('stops a stalled native batch without unlocking until native exit', async () => {
    vi.useFakeTimers();
    const c = childProcess();
    let host: DesktopInputHost;
    const failure = vi.fn(() => host.stop());
    host = new DesktopInputHost(failure, {
      platform: 'darwin',
      resolveBinary: async () => '/test/helper',
      spawn: () => {
        void Promise.resolve().then(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      },
    });
    try {
      await host.start('1');
      host.input([{ kind: 'button', button: 0, down: true, x: 0, y: 0 }]);
      await flush();
      vi.advanceTimersByTime(10_000);
      await flush();
      expect(failure).toHaveBeenCalled();
      await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
      c.exit();
      await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
    } finally {
      host.stop();
      c.exit();
      await flush();
    }
  });
  it.each(['ready', 'failure', 'stop'] as const)(
    'keeps resumed input paused through preparation and handshake: %s',
    async (outcome) => {
      const first = childProcess();
      const replacement = childProcess();
      const failure = vi.fn();
      let prepared!: (binary: string) => void;
      const resolveBinary = vi
        .fn()
        .mockResolvedValueOnce('/test/helper')
        .mockImplementationOnce(
          () =>
            new Promise<string>((resolve) => {
              prepared = resolve;
            }),
        );
      const spawn = vi
        .fn()
        .mockImplementationOnce(() => {
          queueMicrotask(() => first.child.stdout.emit('data', Buffer.from('ready\n')));
          return first.typed;
        })
        .mockReturnValueOnce(replacement.typed);
      const host = new DesktopInputHost(failure, { platform: 'darwin', resolveBinary, spawn });
      const events = [{ kind: 'key' as const, code: 'Enter', down: true }];
      await host.start('1');
      const pausing = host.pauseForPrivacy();
      first.exit();
      const resume = await pausing;
      const resuming = resume();
      expect(() => host.input(events)).not.toThrow();
      await Promise.resolve();
      expect(() => host.input(events)).not.toThrow();
      prepared('/test/helper');
      await Promise.resolve();
      expect(spawn).toHaveBeenCalledTimes(2);
      expect(() => host.input(events)).not.toThrow();
      expect(replacement.child.stdin.write).not.toHaveBeenCalled();
      if (outcome === 'stop') host.stop();
      replacement.child.stdout.emit(
        'data',
        Buffer.from(outcome === 'failure' ? 'permission\n' : 'ready\n'),
      );
      await resuming;
      if (outcome === 'ready') {
        host.input(events);
        await flush();
        expect(replacement.child.stdin.write).toHaveBeenCalledOnce();
      } else {
        expect(() => host.input(events)).toThrow('DESKTOP_INPUT_UNAVAILABLE');
        expect(replacement.child.stdin.write).not.toHaveBeenCalled();
      }
      expect(failure).toHaveBeenCalledTimes(outcome === 'failure' ? 1 : 0);
      host.stop();
      replacement.exit();
      await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
    },
  );
  it.each([false, true])(
    'pauses remote input while retaining ownership; disconnected=%s',
    async (disconnected) => {
      const children = [childProcess(), childProcess()];
      let index = 0;
      const spawn = vi.fn(() => {
        const c = children[index++];
        queueMicrotask(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      });
      const host = new DesktopInputHost(vi.fn(), {
        platform: 'darwin',
        resolveBinary: async () => '/test/helper',
        spawn,
      });
      await host.start('1');
      const pausing = host.pauseForPrivacy();
      host.input([{ kind: 'key', code: 'Enter', down: true }]);
      expect(children[0].child.stdin.write).not.toHaveBeenCalled();
      children[0].exit();
      const resume = await pausing;
      await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
      if (disconnected) host.stop();
      await resume();
      expect(spawn).toHaveBeenCalledTimes(disconnected ? 1 : 2);
      if (!disconnected) {
        host.input([{ kind: 'key', code: 'Enter', down: true }]);
        await flush();
        expect(children[1].child.stdin.write).toHaveBeenCalled();
      }
      host.stop();
      children[1].exit();
      await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
    },
  );
  it('keeps Agent input excluded until the old helper has actually exited', async () => {
    const c = childProcess();
    const host = new DesktopInputHost(vi.fn(), {
      platform: 'darwin',
      resolveBinary: async () => '/test/helper',
      spawn: () => {
        queueMicrotask(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      },
    });
    await host.start('1');
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
    host.input([{ kind: 'button', button: 0, down: true, x: 0.2, y: 0.2 }]);
    host.stop();
    await expect(withAgentDesktopInput(async () => {})).rejects.toThrow('input is active');
    expect(c.child.stdin.end).toHaveBeenCalledWith('[{"kind":"release"}]\n');
    c.exit();
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });
  it('does not spawn a helper if the lease was stopped during compilation', async () => {
    let resolve!: (value: string) => void;
    const spawn = vi.fn();
    const host = new DesktopInputHost(vi.fn(), {
      platform: 'darwin',
      resolveBinary: () =>
        new Promise((done) => {
          resolve = done;
        }),
      spawn,
    });
    const start = host.start('1');
    await Promise.resolve();
    host.stop();
    resolve('/test/helper');
    await expect(start).rejects.toThrow('EXPIRED');
    expect(spawn).not.toHaveBeenCalled();
    await expect(withAgentDesktopInput(async () => {})).resolves.toBeUndefined();
  });
  it('fails closed rather than writing an oversized native command', async () => {
    const c = childProcess();
    let host: DesktopInputHost;
    const failure = vi.fn(() => host.stop());
    host = new DesktopInputHost(failure, {
      platform: 'darwin',
      resolveBinary: async () => '/test/helper',
      spawn: () => {
        queueMicrotask(() => c.child.stdout.emit('data', Buffer.from('ready\n')));
        return c.typed;
      },
    });
    await host.start('1');
    host.input(Array(3).fill({ kind: 'text', text: '中'.repeat(4096) }));
    expect(failure).toHaveBeenCalledOnce();
    expect(c.child.stdin.write).not.toHaveBeenCalled();
    c.exit();
  });
});
