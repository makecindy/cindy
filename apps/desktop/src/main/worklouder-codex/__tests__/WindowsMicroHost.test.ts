import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { describe, expect, it, vi } from 'vitest';
import { WindowsMicroHost } from '../WindowsMicroHost.js';
import { createWorkLouderCodexOffFrame } from '../protocol.js';

vi.mock('electron', () => ({ app: { isPackaged: true } }));

function fakeChild() {
  return Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
}

describe('Windows Micro native host adapter', () => {
  it('accepts coalesced complete messages larger than the per-line limit', async () => {
    const child = fakeChild();
    const host = new WindowsMicroHost({
      resolveBinary: async () => 'helper.exe',
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const message = vi.fn();
    const error = vi.fn();
    host.on('message', message);
    host.on('error', error);
    await host.whenReady;
    const payload = { kind: 'joystick', event: { angle: 0.25, distance: 0.8 } };
    const line = `${JSON.stringify(payload)}\n`;
    try {
      child.stdout.write(line.slice(0, 12));
      child.stdout.write(line.slice(12) + line.repeat(2000));
      expect(message).toHaveBeenCalledTimes(2001);
      expect(error).not.toHaveBeenCalled();
      expect(child.kill).not.toHaveBeenCalled();
    } finally {
      host.kill();
    }
  });
  it.each(['', '\n'])('rejects an oversized individual line with terminator %j', async (end) => {
    const child = fakeChild();
    const host = new WindowsMicroHost({
      resolveBinary: async () => 'helper.exe',
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    const error = vi.fn();
    host.on('error', error);
    await host.whenReady;
    child.stdout.write('x'.repeat(65_537) + end);
    expect(error).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledOnce();
  });
  it('coalesces polling and latest state during a slow native build', async () => {
    let ready!: (binary: string) => void;
    const child = fakeChild();
    const writes: unknown[] = [];
    child.stdin.on('data', (chunk) => writes.push(JSON.parse(String(chunk))));
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const host = new WindowsMicroHost({
      resolveBinary: () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
      spawn,
    });
    const latestFrame = createWorkLouderCodexOffFrame();
    try {
      await Promise.resolve();
      host.postMessage({ kind: 'init', sdkEntry: 'cindy:windows-micro' });
      expect(() => {
        for (let tick = 0; tick < 200; tick++) {
          host.postMessage({ kind: 'discover' });
          host.postMessage({ kind: 'probe' });
          host.postMessage({ kind: 'listen' });
          latestFrame.keys.brightness = tick / 200;
          host.postMessage({ kind: 'apply', frame: latestFrame });
        }
      }).not.toThrow();
      expect(spawn).not.toHaveBeenCalled();
      ready('helper.exe');
      await host.whenReady;
      expect(spawn).toHaveBeenCalledOnce();
      expect(writes).toEqual([
        { kind: 'init', sdkEntry: 'cindy:windows-micro' },
        { kind: 'discover' },
        { kind: 'probe' },
        { kind: 'listen' },
        { kind: 'apply', frame: latestFrame },
      ]);
    } finally {
      host.kill();
    }
  });
  it('lets stop supersede queued state while preparation is pending', async () => {
    let ready!: (binary: string) => void;
    const child = fakeChild();
    const writes: unknown[] = [];
    child.stdin.on('data', (chunk) => writes.push(JSON.parse(String(chunk))));
    const host = new WindowsMicroHost({
      resolveBinary: () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
      spawn: () => child as unknown as ChildProcessWithoutNullStreams,
    });
    try {
      await Promise.resolve();
      host.postMessage({ kind: 'init', sdkEntry: 'cindy:windows-micro' });
      host.postMessage({ kind: 'apply', frame: createWorkLouderCodexOffFrame() });
      host.postMessage({ kind: 'stop' });
      host.postMessage({ kind: 'discover' });
      ready('helper.exe');
      await host.whenReady;
      expect(writes).toEqual([{ kind: 'stop' }]);
    } finally {
      host.kill();
    }
  });
  it('forwards normalized joystick movement and center but rejects out-of-range input', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const host = new WindowsMicroHost({ resolveBinary: async () => 'helper.exe', spawn });
    const message = vi.fn();
    host.on('message', message);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    const movement = { kind: 'joystick', event: { angle: 0.25, distance: 0.8 } };
    const center = { kind: 'joystick', event: { angle: 0.25, distance: 0 } };
    for (const payload of [
      movement,
      center,
      { kind: 'joystick', event: { angle: 2, distance: 1 } },
    ]) {
      child.stdout.write(`${JSON.stringify(payload)}\n`);
    }
    expect(message.mock.calls.map(([payload]) => payload)).toEqual([movement, center]);
    host.kill();
  });
  it('bounds malformed output and reports an error/exit only once', async () => {
    const child = fakeChild();
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const host = new WindowsMicroHost({ resolveBinary: async () => 'helper.exe', spawn });
    const error = vi.fn();
    const exit = vi.fn();
    host.on('error', error);
    host.on('exit', exit);
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    child.stdout.write('x'.repeat(65_537));
    child.emit('error', new Error('pipe closed'));
    child.emit('exit', 1);
    expect(child.kill).toHaveBeenCalledOnce();
    expect(error).toHaveBeenCalledOnce();
    expect(exit).toHaveBeenCalledExactlyOnceWith(1);
    expect(() => host.postMessage({ kind: 'discover' })).toThrow('stopped');
  });
  it('queues init/discover until ready and forwards validated fragmented messages', async () => {
    const child = fakeChild();
    const writes: string[] = [];
    child.stdin.on('data', (chunk) => writes.push(String(chunk)));
    const spawn = vi.fn(() => child as unknown as ChildProcessWithoutNullStreams);
    const host = new WindowsMicroHost({ resolveBinary: async () => 'helper.exe', spawn });
    const message = vi.fn();
    host.on('message', message);
    host.postMessage({ kind: 'init', sdkEntry: 'cindy:windows-micro' });
    host.postMessage({ kind: 'discover' });
    await vi.waitFor(() => expect(spawn).toHaveBeenCalledOnce());
    expect(writes.map((line) => JSON.parse(line).kind)).toEqual(['init', 'discover']);
    child.stdout.write('{"kind":"presence","present":');
    child.stdout.write('true,"deviceType":"codex-micro","isUsbConnection":true}\n');
    child.stdout.write('{"kind":"hid","event":{"key":"BAD","act":1}}\n');
    expect(message).toHaveBeenCalledExactlyOnceWith({
      kind: 'presence',
      present: true,
      deviceType: 'codex-micro',
      isUsbConnection: true,
    });
    host.kill();
  });

  it('does not spawn when disposal wins asynchronous binary resolution', async () => {
    let ready!: (path: string) => void;
    const spawn = vi.fn();
    const host = new WindowsMicroHost({
      resolveBinary: () =>
        new Promise((resolve) => {
          ready = resolve;
        }),
      spawn,
    });
    await Promise.resolve();
    host.kill();
    ready('helper.exe');
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(spawn).not.toHaveBeenCalled();
  });

  it('reports binary failure once so the existing host client owns retry limits', async () => {
    const host = new WindowsMicroHost({
      resolveBinary: async () => {
        throw new Error('missing binary');
      },
      spawn: vi.fn(),
    });
    const error = vi.fn();
    const exit = vi.fn();
    host.on('error', error);
    host.on('exit', exit);
    await vi.waitFor(() => expect(exit).toHaveBeenCalledExactlyOnceWith(1));
    expect(error).toHaveBeenCalledOnce();
    host.kill();
    expect(exit).toHaveBeenCalledOnce();
  });
});
