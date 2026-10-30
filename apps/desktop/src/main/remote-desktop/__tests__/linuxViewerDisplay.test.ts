import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
type TestChild = EventEmitter & {
  stdin: PassThrough;
  stdout: PassThrough;
  stderr: PassThrough;
  kill: ReturnType<typeof vi.fn>;
};
const h = vi.hoisted(() => ({
  child: null as unknown as TestChild,
  monitor: vi.fn(),
  monitors: vi.fn(),
}));
vi.mock('electron', () => ({ app: { isPackaged: false, getAppPath: () => '/test/app' } }));
vi.mock('node:fs', () => ({ accessSync: vi.fn(), constants: { X_OK: 1, R_OK: 4 } }));
vi.mock('node:child_process', () => ({ spawn: () => h.child }));
vi.mock('../hyprlandCapture', () => ({ supportsHyprlandCapture: () => true }));
vi.mock('../linuxDesktop', () => ({
  supportsLinuxDisplay: () => true,
  linuxMonitor: h.monitor,
  linuxMonitors: h.monitors,
  linuxDisplay: (m: { name: string; width: number; height: number }) => ({
    id: `hyprland:${m.name}`,
    name: m.name,
    width: m.width,
    height: m.height,
  }),
}));
import { createLinuxViewerDisplay } from '../linuxViewerDisplay';
const original = { name: 'eDP-2', width: 1600, height: 1000 };
beforeEach(() => {
  vi.useFakeTimers();
  h.child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  h.monitor.mockReset().mockResolvedValue(original);
  h.monitors.mockReset().mockResolvedValue([original]);
});
afterEach(() => vi.useRealTimers());
it('restores on EOF, checks actual output geometry and leaves no heartbeat after exit', async () => {
  const owner = await createLinuxViewerDisplay('hyprland:eDP-2', () => true, vi.fn());
  const name = 'CindyRemote-1234567812345678';
  h.monitor.mockResolvedValue({ name, width: 800, height: 600 });
  const resized = owner.resize(800, 600, () => true);
  h.child.stdout.write(
    JSON.stringify({ id: `hyprland:${name}`, name, width: 800, height: 600 }) + '\n',
  );
  expect((await resized).id).toBe(`hyprland:${name}`);
  const restored = owner.restore!(() => true);
  expect(h.child.stdin.writableEnded).toBe(true);
  h.child.emit('exit', 0);
  expect(await restored).toMatchObject({ id: 'hyprland:eDP-2', width: 1600 });
  expect(vi.getTimerCount()).toBe(0);
});
it('disposes instead of accepting a reply from an expired lease', async () => {
  const failed = vi.fn();
  const owner = await createLinuxViewerDisplay('hyprland:eDP-2', () => true, failed);
  let current = true;
  const resized = owner.resize(800, 600, () => current);
  const rejected = expect(resized).rejects.toThrow('DESKTOP_LEASE_EXPIRED');
  current = false;
  h.child.stdout.write(
    '{"id":"hyprland:CindyRemote-1234567812345678","name":"test","width":800,"height":600}\n',
  );
  await rejected;
  expect(h.child.stdin.writableEnded).toBe(true);
  h.child.emit('exit', 0);
  await Promise.resolve();
  expect(failed).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it('finishes restoration if the original output was unplugged', async () => {
  const owner = await createLinuxViewerDisplay('hyprland:eDP-2', () => true, vi.fn());
  h.monitors.mockResolvedValue([]);
  const restored = owner.restore!(() => true);
  h.child.emit('exit', 0);
  expect(await restored).toMatchObject({ id: 'hyprland:eDP-2' });
});
