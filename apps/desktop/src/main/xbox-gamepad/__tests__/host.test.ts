import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: () => '/app',
    getPath: () => '/tmp',
  },
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

import { createXboxGamepadHost } from '../host.js';

function fakeChild(): ChildProcessWithoutNullStreams {
  const child = new EventEmitter() as EventEmitter & {
    stdin: PassThrough;
    stdout: PassThrough;
    stderr: PassThrough;
    kill: ReturnType<typeof vi.fn>;
  };
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.kill = vi.fn();
  return child as unknown as ChildProcessWithoutNullStreams;
}

async function flush(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('XboxGamepadHost', () => {
  it('turns a spawn error into host-error instead of crashing the process', async () => {
    const onMessage = vi.fn();
    const child = fakeChild();
    const spawnHelper = vi.fn(() => child);
    const host = createXboxGamepadHost(onMessage, {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    child.emit('error', new Error('EACCES'));

    expect(onMessage).toHaveBeenCalledWith({ kind: 'host-error', message: 'EACCES' });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    host.stop();
  });

  it('does not respawn immediately after an unexpected exit', async () => {
    vi.useFakeTimers();
    const onMessage = vi.fn();
    const child = fakeChild();
    const spawnHelper = vi.fn(() => child);
    const host = createXboxGamepadHost(onMessage, {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    child.emit('exit', 1, null);
    await flush();

    expect(onMessage).toHaveBeenCalledWith({
      kind: 'host-error',
      message: 'Xbox gamepad helper exited unexpectedly (1)',
    });
    expect(spawnHelper).toHaveBeenCalledTimes(1);
    host.stop();
    vi.useRealTimers();
  });

  it('restarts a still-wanted helper after a bounded delay', async () => {
    vi.useFakeTimers();
    const first = fakeChild();
    const second = fakeChild();
    const spawnHelper = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    first.emit('exit', 1, null);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(1_000);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(2);
    host.stop();
    vi.useRealTimers();
  });

  it('stops automatic restarts after three crashes', async () => {
    vi.useFakeTimers();
    const spawnHelper = vi.fn(() => fakeChild());
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    for (const delay of [1_000, 2_000, 4_000]) {
      const current = spawnHelper.mock.results.at(-1)?.value as ReturnType<typeof fakeChild>;
      current.emit('exit', 1, null);
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
    }
    expect(spawnHelper).toHaveBeenCalledTimes(4);
    const last = spawnHelper.mock.results.at(-1)?.value as ReturnType<typeof fakeChild>;
    last.emit('exit', 1, null);
    await flush();
    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(4);
    host.stop();
    vi.useRealTimers();
  });

  it('does not reset the restart budget when a helper emits presence then dies', async () => {
    vi.useFakeTimers();
    const spawnHelper = vi.fn(() => fakeChild());
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    for (const delay of [1_000, 2_000, 4_000]) {
      const current = spawnHelper.mock.results.at(-1)?.value as ReturnType<typeof fakeChild>;
      (current.stdout as PassThrough).write(`${JSON.stringify({ kind: 'presence', present: false })}\n`);
      current.emit('exit', 1, null);
      await flush();
      await vi.advanceTimersByTimeAsync(delay);
      await flush();
    }
    expect(spawnHelper).toHaveBeenCalledTimes(4);
    const last = spawnHelper.mock.results.at(-1)?.value as ReturnType<typeof fakeChild>;
    (last.stdout as PassThrough).write(`${JSON.stringify({ kind: 'presence', present: false })}\n`);
    last.emit('exit', 1, null);
    await flush();
    host.probe();
    await vi.advanceTimersByTimeAsync(8_000);
    await flush();
    expect(spawnHelper).toHaveBeenCalledTimes(4);
    host.stop();
    vi.useRealTimers();
  });

  it('lets an explicit probe retry after a crash', async () => {
    vi.useFakeTimers();
    const first = fakeChild();
    const second = fakeChild();
    const spawnHelper = vi.fn().mockReturnValueOnce(first).mockReturnValueOnce(second);
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper,
    });

    host.start();
    await flush();
    first.emit('exit', 1, null);
    await flush();
    host.probe();
    await flush();

    expect(spawnHelper).toHaveBeenCalledTimes(2);
    host.stop();
    vi.useRealTimers();
  });

  it('swallows helper stdin write errors instead of crashing', async () => {
    const child = fakeChild();
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper: () => child,
    });

    host.start();
    await flush();
    child.stdin.destroy();
    expect(() => host.probe()).not.toThrow();
    host.stop();
  });

  it('does not spawn after stop wins the resolve race', async () => {
    let finishResolve: ((path: string) => void) | undefined;
    const spawnHelper = vi.fn(() => fakeChild());
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: () =>
        new Promise((resolve) => {
          finishResolve = resolve;
        }),
      spawnHelper,
    });

    host.start();
    await flush();
    host.stop();
    finishResolve?.('/helper');
    await flush();

    expect(spawnHelper).not.toHaveBeenCalled();
  });

  it('does not report host-error when the helper is stopped on purpose', async () => {
    const onMessage = vi.fn();
    const child = fakeChild();
    const host = createXboxGamepadHost(onMessage, {
      resolveHelperPath: async () => '/helper',
      spawnHelper: () => child,
    });

    host.start();
    await flush();
    host.stop();
    child.emit('exit', 0, null);
    await flush();

    expect(onMessage).not.toHaveBeenCalled();
  });
});

describe('Xbox gamepad helper packaging contract', () => {
  it('matches HID transport to the current controller instead of any Microsoft USB device', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/macos-xbox-gamepad-helper.swift', import.meta.url),
      'utf8',
    );
    expect(source).toContain('func controllerTransport(for controller: GCController)');
    expect(source).not.toContain('func microsoftControllerTransport()');
    expect(source).not.toContain('if sawUsb { return "usb" }');
  });

  it('compiles the helper for macOS 11 so GameController Xbox APIs are available', () => {
    const source = readFileSync(new URL('../../../../forge.config.ts', import.meta.url), 'utf8');
    expect(source).toContain("MACOS_XBOX_GAMEPAD_HELPER_DEPLOYMENT_TARGET = 'macos11.0'");
    expect(source).toContain('MACOS_XBOX_GAMEPAD_HELPER_DEPLOYMENT_TARGET');
  });
});
