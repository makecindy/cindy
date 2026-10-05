import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  nativeImage: {},
  screen: { getAllDisplays: () => [{ id: 1, scaleFactor: 2 }] },
}));
vi.mock('../windowsHost', () => ({ openWindowsDesktopConnection: vi.fn() }));
import { NativeDesktopCapture } from '../nativeCapture';

const owners: NativeDesktopCapture[] = [];
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: '/res' });
  h.spawn.mockReset();
});
afterEach(() => {
  owners.splice(0).forEach((o) => o.stop());
  vi.unstubAllGlobals();
});
function setup() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  h.spawn.mockReturnValue(child);
  const owner = new NativeDesktopCapture();
  owners.push(owner);
  return { child, owner };
}

it.each([
  ['auto', 60, ['60', '0.8', '2560', '1500000']],
  ['saver', 60, ['30', '0.65', '0', '1000000']],
  ['hd', 30, ['30', '0.9', '3840', '3000000']],
] as const)('passes the %s tier capture budget to the macOS helper', async (quality, fps, args) => {
  const { owner } = setup();
  void owner.frame('1', true, { fps, quality, audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn.mock.calls[0][1]).toEqual(['1', 'cursor-overlay', ...args]);
});

it('accepts frames up to the tier budget and stops capture beyond it', async () => {
  const frame = { jpeg: 'a'.repeat(2_666_668), cursor: null };
  const hd = setup();
  const accepted = hd.owner.frame('1', true, { fps: 30, quality: 'hd', audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  hd.child.stdout.write(JSON.stringify(frame) + '\n');
  await expect(accepted).resolves.toEqual(frame);

  const auto = setup();
  const rejected = auto.owner.frame('1', true, { fps: 30, quality: 'auto', audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
  auto.child.stdout.write(JSON.stringify(frame) + '\n');
  await vi.waitFor(() => expect(auto.child.kill).toHaveBeenCalledOnce());
  auto.owner.stop();
  await expect(rejected).resolves.toBeNull();
});
