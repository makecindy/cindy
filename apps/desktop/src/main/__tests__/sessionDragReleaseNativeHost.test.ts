import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import type { ChildProcessByStdio } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  spawn: vi.fn(),
  execFile: vi.fn(),
}));

vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getAppPath: vi.fn(),
    getPath: vi.fn(),
  },
}));

vi.mock('node:child_process', () => ({
  spawn: h.spawn,
  execFile: h.execFile,
}));

vi.mock('../logger.js', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

type FakeNativeProcess = Omit<
  ChildProcessByStdio<Writable, Readable, Readable>,
  'stdin' | 'stdout' | 'stderr'
> & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  emit(event: 'exit', code: number | null, signal: NodeJS.Signals | null): boolean;
  emit(event: 'error', error: Error): boolean;
};

const originalPlatform = process.platform;

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
  Object.defineProperty(process, 'resourcesPath', {
    value: '/Applications/Cindy.app/Contents/Resources',
    configurable: true,
  });
  h.spawn.mockReset();
  h.execFile.mockReset();
});

afterEach(() => {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe('SessionDragReleaseNativeHost', () => {
  it('arms one token and forwards only its matching native mouse-up', async () => {
    const child = createFakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(chunk.toString()));
    h.spawn.mockReturnValue(child);
    const onMouseUp = vi.fn();
    const { SessionDragReleaseNativeHost } = await import('../sessionDragReleaseNativeHost.js');
    const host = new SessionDragReleaseNativeHost({ onMouseUp });

    const prewarm = host.prewarm();
    child.stdout.write('{"type":"ready"}\n');
    await expect(prewarm).resolves.toBe(true);
    await expect(host.arm(41)).resolves.toBe(true);
    expect(writes).toContain('{"type":"arm","token":41}\n');

    child.stdout.write('{"type":"mouse-up","token":40}\n');
    expect(onMouseUp).not.toHaveBeenCalled();
    child.stdout.write('{"type":"mouse-up","token":41}\n');
    expect(onMouseUp).toHaveBeenCalledOnce();
    expect(onMouseUp).toHaveBeenCalledWith(41);

    host.dispose();
    expect(child.kill).toHaveBeenCalledOnce();
  });

  it('does not arm after the drag ends while helper startup is pending', async () => {
    const child = createFakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(chunk.toString()));
    h.spawn.mockReturnValue(child);
    const { SessionDragReleaseNativeHost } = await import('../sessionDragReleaseNativeHost.js');
    const host = new SessionDragReleaseNativeHost({ onMouseUp: vi.fn() });

    const arm = host.arm(7);
    host.disarm();
    child.stdout.write('{"type":"ready"}\n');

    await expect(arm).resolves.toBe(false);
    expect(writes).not.toContain('{"type":"arm","token":7}\n');
    host.dispose();
  });

  it('uses a listen-only, one-shot AppKit event monitor without reading cursor data', () => {
    const source = fs
      .readFileSync(
        new URL(
          '../../../native/session-drag-release/macos-session-drag-release-helper.swift',
          import.meta.url,
        ),
        'utf8',
      )
      .replace(/\r\n?/g, '\n');

    expect(source).toContain('NSEvent.addGlobalMonitorForEvents(matching: mask)');
    expect(source).toContain('NSEvent.addLocalMonitorForEvents(matching: mask)');
    expect(source).toContain('let mask: NSEvent.EventTypeMask = [.leftMouseUp]');
    expect(source).toContain('disarm()\n        emit(["type": "mouse-up", "token": token])');
    expect(source).not.toContain('mouseLocation');
    expect(source).not.toContain('locationInWindow');
  });

  it('is included in the macOS package helper build', () => {
    const forgeSource = fs.readFileSync(
      path.resolve(__dirname, '..', '..', '..', 'forge.config.ts'),
      'utf8',
    );
    expect(forgeSource).toContain('function buildMacSessionDragReleaseHelper(');
    expect(forgeSource).toContain('buildMacSessionDragReleaseHelper(platform, arch);');
    expect(forgeSource).toContain("'xdt-macos-session-drag-release-helper'");
  });
});

function createFakeChild(): FakeNativeProcess {
  const child = new EventEmitter() as FakeNativeProcess;
  child.stdin = new PassThrough();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  let killed = false;
  Object.defineProperty(child, 'killed', {
    configurable: true,
    get: () => killed,
  });
  child.kill = vi.fn(() => {
    killed = true;
    return true;
  });
  return child;
}
