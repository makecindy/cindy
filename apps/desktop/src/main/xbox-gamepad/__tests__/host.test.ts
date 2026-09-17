import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import path from 'node:path';
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

import { createXboxGamepadHost, resolveXboxGamepadHelperPath } from '../host.js';

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
  it('resolves a packaged Windows helper rather than rejecting the platform', async () => {
    vi.stubGlobal('process', { ...process, resourcesPath: path.resolve('resources') });
    try {
      const helper = await resolveXboxGamepadHelperPath('win32');
      expect(helper).toBe(
        path.join(
          process.resourcesPath,
          'tools',
          'xbox-gamepad',
          'cindy-windows-gamepad-helper.exe',
        ),
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });
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
      (current.stdout as PassThrough).write(
        `${JSON.stringify({ kind: 'presence', present: false })}\n`,
      );
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

  it('tells the helper when Switch 2 USB should claim the pad', async () => {
    const child = fakeChild();
    const chunks: string[] = [];
    child.stdin.on('data', (chunk: string | Buffer) => {
      chunks.push(String(chunk));
    });
    const host = createXboxGamepadHost(vi.fn(), {
      resolveHelperPath: async () => '/helper',
      spawnHelper: () => child,
    });

    host.start();
    await flush();
    host.setSwitch2UsbWanted(true);
    host.setSwitch2UsbWanted(false);

    expect(chunks.join('')).toContain('switch2-usb on');
    expect(chunks.join('')).toContain('switch2-usb off');
    host.stop();
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
  it('starts Windows input and ships a native helper for the requested architecture', () => {
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    const forge = readFileSync(new URL('../../../../forge.config.ts', import.meta.url), 'utf8');
    expect(index).toContain("process.platform === 'darwin' || process.platform === 'win32'");
    expect(forge).toContain('buildWindowsGamepadHelper(platform, arch)');
    expect(forge).toContain('aarch64-pc-windows-msvc');
    expect(forge).toContain('x86_64-pc-windows-msvc');
    expect(forge).toContain("buildWindowsInputHelper('gamepad', platform, arch)");
    expect(forge).toContain("buildWindowsInputHelper('micro', platform, arch)");
    expect(forge).toContain('cindy-windows-${kind}-helper.exe');
  });
  it('matches HID transport to the current controller instead of any Microsoft USB device', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/macos-xbox-gamepad-helper.swift', import.meta.url),
      'utf8',
    );
    expect(source).toContain('func controllerTransport(for controller: GCController)');
    expect(source).toContain('IOHIDManagerSetDeviceMatchingMultiple');
    expect(source).toContain('0x054C');
    expect(source).toContain('0x057E');
    expect(source).not.toContain('func microsoftControllerTransport()');
    expect(source).not.toContain('if sawUsb { return "usb" }');
  });

  it('attaches any extended gamepad instead of filtering to Xbox', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/macos-xbox-gamepad-helper.swift', import.meta.url),
      'utf8',
    );
    expect(source).toContain('func isSupportedGamepad');
    expect(source).toContain('func resolveGamepadFamily');
    expect(source).toContain('for controller in all where isSupportedGamepad(controller)');
    expect(source).toContain('return "generic"');
    expect(source).not.toContain('func isXboxController');
    expect(source).not.toContain('all.first(where: isXboxController)');
    expect(source).toContain('switch2_usb_ensure');
    expect(source).toContain('switch2-usb on');
    expect(source).toContain('switch2-usb off');
    expect(source).toContain('switch2_usb_shutdown');
    expect(source).toContain('func setSwitch2UsbWanted');
    const startFn = source.match(/func start\(\) \{[\s\S]*?\n {2}\}/)?.[0] ?? '';
    expect(startFn).not.toContain('switch2_usb_ensure');
    expect(startFn).not.toContain('scheduledTimer');
    expect(source).toContain('switch2PollTimer');
    expect(source).toMatch(
      /if family == "nintendo" \{[\s\S]*?if switch2UsbWanted \{[\s\S]*?continue/,
    );
    expect(source).not.toMatch(
      /if family == "nintendo" \{\s*observed\[family\] = nil\s*continue\s*\}/,
    );
  });

  it('compiles switch2_usb.c with clang before linking the object into swiftc', () => {
    const forge = readFileSync(new URL('../../../../forge.config.ts', import.meta.url), 'utf8');
    const host = readFileSync(new URL('../host.ts', import.meta.url), 'utf8');
    expect(forge).toContain("MACOS_XBOX_GAMEPAD_HELPER_DEPLOYMENT_TARGET = 'macos11.0'");
    expect(forge).toContain('compileCObjectForTarget');
    expect(forge).toContain("'clang'");
    expect(forge).toContain('switch2_usb.c');
    expect(forge).toContain('switch2_usb.h');
    expect(host).toContain("'clang'");
    expect(host).toContain("'-c'");
    expect(host).toContain('switch2_usb.o');
    expect(host).not.toMatch(/swiftc',[\s\S]*switch2UsbC/);
    expect(host).toContain('setSwitch2UsbWanted');
    const index = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');
    expect(index).toContain('setSwitch2UsbWanted');
    expect(index).toContain('computeSwitch2UsbWanted');
    expect(index).toContain('taskSlotsSuspended');
    expect(index).toContain('layoutPreviewLease.setActive(false, owner)');
    expect(index).not.toMatch(/previewFamily = family;\s*layoutPreviewLease\.setActive\(active/);
    expect(index).not.toMatch(
      /setSwitch2UsbWanted\(\s*controller\.getAccessories\(\)\.nintendo\.settings\.deviceEnabled \|\| previewFamily === 'nintendo'/,
    );
  });

  it('copies the matching HID set into a buffer sized for every device', () => {
    const source = readFileSync(
      new URL('../../../../native/xbox-gamepad/switch2_usb.c', import.meta.url),
      'utf8',
    );
    expect(source).toContain('CFSetApplyFunction');
    expect(source).not.toContain('CFSetGetValues(devices, (const void **)&device)');
  });
});
