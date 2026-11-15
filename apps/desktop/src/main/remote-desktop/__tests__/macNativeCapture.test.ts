import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { REMOTE_DESKTOP_OFFER_BUDGET } from '@cindy/device-link';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }));
vi.mock('electron', () => ({
  app: { isPackaged: true },
  nativeImage: {},
  screen: { getAllDisplays: () => [{ id: 1, scaleFactor: 2 }] },
}));
vi.mock('../windowsHost', () => ({ openWindowsDesktopConnection: vi.fn() }));
import { NativeDesktopCapture, photographMacWindow } from '../nativeCapture';

const owners: NativeDesktopCapture[] = [];
const children: EventEmitter[] = [];
beforeEach(() => {
  vi.stubGlobal('process', { ...process, platform: 'darwin', resourcesPath: '/res' });
  h.spawn.mockReset();
});
afterEach(() => {
  owners.splice(0).forEach((o) => o.stop());
  children.splice(0).forEach((child) => child.emit('exit', 0, null));
  vi.unstubAllGlobals();
  // A failed fake-timer case must not leave later cases waiting on frozen time.
  vi.useRealTimers();
});
function makeChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  children.push(child);
  return child;
}
function setup(encodeOnRequest = false) {
  const child = makeChild();
  h.spawn.mockReturnValue(child);
  const owner = new NativeDesktopCapture({ encodeOnRequest });
  owners.push(owner);
  return { child, owner };
}

it.each([
  ['auto', 60, ['60', '0.8', '2560', '1500000']],
  ['saver', 60, ['60', '0.65', '0', '1000000']],
  ['hd', 30, ['30', '0.9', '3840', '3000000']],
] as const)('passes the %s tier capture budget to the macOS helper', async (quality, fps, args) => {
  const { owner } = setup();
  void owner.frame('1', true, { fps, quality, audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn.mock.calls[0][1]).toEqual(['1', 'cursor-overlay', ...args]);
});

// Unit: the local recording mode must preserve frame parsing, cancellation and
// the private helper boundary. Existing tests only cover eager remote streams.
// Minimum input: opt-in + one frame, then stop while the second frame is pending.
it('opts local recording into demand encoding without changing replies or cancellation', async () => {
  const { child, owner } = setup(true);
  const settings = { fps: 30, quality: 'hd', audio: false } as const;
  const frame = { jpeg: 'anBlZw==', cursor: null };
  const first = owner.frame('1', true, settings);
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn.mock.calls[0][1]).toEqual([
    '1',
    'cursor-overlay-demand',
    '30',
    '0.9',
    '3840',
    '3000000',
  ]);
  child.stdout.write(JSON.stringify(frame) + '\n');
  await expect(first).resolves.toEqual(frame);
  const pending = owner.frame('1', true, settings);
  owner.stop();
  await expect(pending).resolves.toBeNull();
  child.stdout.write(JSON.stringify(frame) + '\n');
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
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
  await vi.waitFor(() => expect(auto.child.stdin.writableEnded).toBe(true));
  auto.owner.stop();
  await expect(rejected).resolves.toBeNull();
});

it('waits out a slow helper start but bounds later frames to the steady-state wait', async () => {
  vi.useFakeTimers();
  const { child, owner } = setup();
  const settings = { fps: 30, quality: 'auto', audio: false } as const;
  const frame = { jpeg: 'abcd', cursor: null };
  const first = owner.frame('1', true, settings);
  await vi.advanceTimersByTimeAsync(REMOTE_DESKTOP_OFFER_BUDGET.captureReadyMs - 1000);
  expect(child.kill).not.toHaveBeenCalled();
  child.stdout.write(JSON.stringify(frame) + '\n');
  await expect(first).resolves.toEqual(frame);

  const next = owner.frame('1', true, settings);
  await vi.advanceTimersByTimeAsync(3000);
  await expect(next).resolves.toBeNull();
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  expect(h.spawn).toHaveBeenCalledOnce();
});

// Regression: ending a pending macOS capture must leave the helper alive long
// enough to stop its asynchronous SCStream. Existing frame/timeout cases only
// checked kill(), which allowed recording to start after the client disappeared.
it.each([false, true])(
  'drains capture shutdown before forcing an unresponsive helper (%s)',
  async (unresponsive) => {
    vi.useFakeTimers();
    const { child, owner } = setup();
    const pending = owner.frame('1', true);
    await vi.advanceTimersByTimeAsync(0);

    owner.stop();
    await expect(pending).resolves.toBeNull();
    expect(child.stdin.writableEnded).toBe(true);
    expect(child.kill).not.toHaveBeenCalled();

    if (!unresponsive) child.emit('exit', 0, null);
    await vi.advanceTimersByTimeAsync(60_000);
    if (unresponsive) expect(child.kill).toHaveBeenCalledExactlyOnceWith('SIGKILL');
    else expect(child.kill).not.toHaveBeenCalled();
    child.emit('exit', 0, null);
  },
);

it('finishes a one-shot window photo before gracefully releasing its stream', async () => {
  vi.useFakeTimers();
  const { child } = setup();
  const photo = photographMacWindow('1', 4242);
  await vi.advanceTimersByTimeAsync(0);
  child.stdout.write(JSON.stringify({ jpeg: 'YWJj' }) + '\n');
  await expect(photo).resolves.toEqual(Buffer.from('abc'));
  expect(child.stdin.writableEnded).toBe(true);
  expect(child.kill).not.toHaveBeenCalled();
  child.emit('exit', 0, null);
  await vi.advanceTimersByTimeAsync(60_000);
  expect(child.kill).not.toHaveBeenCalled();
});

it('captures only the 代输入 window, never the display, and returns to the display after', async () => {
  const { owner } = setup();
  owner.setExcludedWindows([7, 8]);
  owner.setWindow(4242);
  // The window view exists only as the overlay stream.
  await expect(owner.frame('1', false)).resolves.toBeNull();
  expect(h.spawn).not.toHaveBeenCalled();
  void owner.frame('1', true, { fps: 30, quality: 'auto', audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledOnce());
  expect(h.spawn.mock.calls[0][1].at(-1)).toBe('window:4242');
  owner.setWindow(null);
  h.spawn.mockReturnValue(makeChild());
  void owner.frame('1', true, { fps: 30, quality: 'auto', audio: false });
  await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
  expect(h.spawn.mock.calls[1][1].at(-1)).toBe('7,8');
});
