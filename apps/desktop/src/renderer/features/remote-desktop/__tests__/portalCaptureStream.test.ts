// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
import { PortalCaptureStream } from '../portalCaptureStream';

const owners: PortalCaptureStream[] = [];
afterEach(() => {
  owners.splice(0).forEach((owner) => owner.stop());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});
function setup() {
  vi.useFakeTimers();
  const ended = vi.fn();
  const owner = new PortalCaptureStream(ended);
  owners.push(owner);
  let resolve!: (value: MediaStream) => void;
  let reject!: (reason: Error) => void;
  const capture = vi.fn(
    () =>
      new Promise<MediaStream>((yes, no) => {
        resolve = yes;
        reject = no;
      }),
  );
  vi.stubGlobal('navigator', { mediaDevices: { getDisplayMedia: capture } });
  const track = Object.assign(new EventTarget(), {
    stop: vi.fn(),
    muted: false,
    readyState: 'live',
  });
  const cloned = { getTracks: () => [{ stop: vi.fn() }] } as unknown as MediaStream;
  const stream = {
    active: true,
    getTracks: () => [track],
    getVideoTracks: () => [track],
    clone: vi.fn(() => cloned),
  } as unknown as MediaStream;
  const video = {
    muted: false,
    srcObject: null,
    play: vi.fn(async () => {}),
    pause: vi.fn(),
    readyState: 2,
    videoWidth: 1920,
    videoHeight: 1200,
  };
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({ drawImage: vi.fn() }),
    toDataURL: vi.fn(() => 'data:image/jpeg;base64,anBlZw=='),
  };
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string) =>
    tag === 'video' ? video : canvas) as typeof document.createElement);
  return {
    owner,
    ended,
    capture,
    resolve: () => resolve(stream),
    reject: (error: Error) => reject(error),
    stream,
    track,
    video,
    canvas,
  };
}
it('waits for local consent beyond five seconds without opening more pickers, then serves bounded frames and clones', async () => {
  const h = setup();
  h.owner.prepare('lease');
  expect(h.owner.frame('lease')).toBeNull();
  const capture = h.owner.capture('lease');
  await vi.advanceTimersByTimeAsync(20_000);
  h.owner.prepare('lease');
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.ended).not.toHaveBeenCalled();
  h.resolve();
  expect(await capture).toBe(h.stream.clone());
  expect(h.owner.frame('lease')).toBe('anBlZw==');
  expect(h.canvas.width).toBe(1280);
  expect(h.canvas.height).toBe(800);
  await h.owner.capture('lease');
  expect(h.capture).toHaveBeenCalledOnce();
  expect(h.track.stop).not.toHaveBeenCalled();
  h.track.muted = true;
  expect(h.owner.frame('lease')).toBeNull();
  h.owner.stop();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.video.srcObject).toBeNull();
});
it('keeps denial sticky for the lease instead of prompting on every frame or video retry', async () => {
  const h = setup();
  h.owner.prepare('lease');
  const rejected = expect(h.owner.capture('lease')).rejects.toThrow('denied');
  h.reject(new Error('denied'));
  await rejected;
  h.owner.prepare('lease');
  expect(() => h.owner.frame('lease')).toThrow('DESKTOP_VIDEO_UNAVAILABLE');
  expect(h.capture).toHaveBeenCalledOnce();
});
it.each(['stop', 'timeout'] as const)('discards a late user selection after %s', async (kind) => {
  const h = setup();
  h.owner.prepare('lease');
  const rejected = expect(h.owner.capture('lease')).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  if (kind === 'stop') h.owner.stop();
  else await vi.advanceTimersByTimeAsync(120_000);
  h.resolve();
  await rejected;
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.ended).toHaveBeenCalledTimes(kind === 'timeout' ? 1 : 0);
  expect(() => h.owner.frame('lease')).toThrow('DESKTOP_VIDEO_STOPPED');
});
it('stops the lease when the user ends sharing, and rejects wrong-lease reads', async () => {
  const h = setup();
  h.owner.prepare('lease');
  h.resolve();
  await h.owner.capture('lease');
  await expect(h.owner.capture('other')).rejects.toThrow('DESKTOP_VIDEO_STOPPED');
  expect(() => h.owner.frame('other')).toThrow('DESKTOP_VIDEO_STOPPED');
  h.track.dispatchEvent(new Event('ended'));
  expect(h.ended).toHaveBeenCalledOnce();
  expect(h.track.stop).toHaveBeenCalledOnce();
  expect(h.video.srcObject).toBeNull();
});
it('drops oversized JPEGs rather than sending unbounded relay payloads', async () => {
  const h = setup();
  h.owner.prepare('lease');
  h.resolve();
  await h.owner.capture('lease');
  h.canvas.toDataURL.mockReturnValue('data:image/jpeg;base64,' + 'a'.repeat(4_000_000));
  expect(h.owner.frame('lease')).toBeNull();
  expect(h.canvas.toDataURL).toHaveBeenCalledTimes(4);
});
