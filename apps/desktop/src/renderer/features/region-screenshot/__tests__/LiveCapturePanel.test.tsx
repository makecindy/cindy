// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { LiveCapturePanel } from '../LiveCapturePanel';
import { nativeAudioStream } from '../../remote-desktop/nativeAudioStream';
import { CaptureRecorder } from '../captureRecorder';
import type { RegionScreenshotOverlayBridge } from '../bridge';
import type { RegionCaptureBegin } from '../../../../shared/regionCapture';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../../remote-desktop/nativeAudioStream', () => ({ nativeAudioStream: vi.fn() }));
vi.mock('../captureRecorder', () => ({ CaptureRecorder: vi.fn() }));

// Unit regression: the actual Pause button must release the capture host, not
// merely pause muxing. PCM unit tests cannot cover UI/IPC ordering, retry or a
// late resume after Finish/unmount. Minimal input: one frame and deferred IPC.
// Standalone file: 1.93 s on Windows (2026-11-04); fake timers, no real waits.
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((yes) => { resolve = yes; });
  return { promise, resolve };
}
const button = (name: string) => screen.getByRole('button', { name: `regionScreenshot.live.${name}` });
const click = async (name: string) => act(async () => { fireEvent.click(button(name)); });

async function setup() {
  vi.useFakeTimers();
  vi.stubGlobal('ImageData', class {
    data: Uint8ClampedArray;
    constructor(readonly width: number, readonly height: number) { this.data = new Uint8ClampedArray(width * height * 4); }
  });
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({ putImageData: vi.fn() } as unknown as CanvasRenderingContext2D);
  const audio = { track: {} as MediaStreamTrack, pause: vi.fn(async () => {}), resume: vi.fn(async () => {}), stop: vi.fn() };
  vi.mocked(nativeAudioStream).mockResolvedValue(audio);
  const recorder = { add: vi.fn(async () => {}), pause: vi.fn(), resume: vi.fn(), dispose: vi.fn(), finish: vi.fn(async () => new Uint8Array([1])) };
  vi.mocked(CaptureRecorder).mockImplementation(function () { return recorder as unknown as CaptureRecorder; });
  const image = { width: 2, height: 2, data: new Uint8Array(16) };
  const bridge = {
    startAudio: vi.fn<RegionScreenshotOverlayBridge['startAudio']>(async () => null),
    stopAudio: vi.fn(async () => {}), readAudio: vi.fn(async () => new Uint8Array(0)),
    holdCapture: vi.fn(async () => {}), liveFrame: vi.fn(async () => ({ image, cursor: null })),
    previewRecording: vi.fn(async () => true),
  };
  const begin: RegionCaptureBegin = { mode: 'video', first: image, selection: { x: 0, y: 0, width: 2, height: 2 }, recordingLayout: { viewport: { width: 800, height: 600 }, controls: { x: 0, y: 10, width: 340, height: 80 } } };
  const view = render(<LiveCapturePanel begin={begin} token="recording" bridge={bridge as unknown as RegionScreenshotOverlayBridge} audioOptions={{ system: true, microphone: false }} />);
  await act(async () => {});
  await act(async () => { await vi.advanceTimersByTimeAsync(3600); });
  expect(recorder.add).toHaveBeenCalled();
  return { audio, recorder, bridge, ...view };
}

it('releases audio on pause and waits for reacquisition before resuming recording', async () => {
  const h = await setup();
  const stopped = deferred<void>();
  h.bridge.stopAudio.mockReturnValueOnce(stopped.promise);
  await click('pause');
  expect(h.audio.pause).toHaveBeenCalledOnce();
  expect(h.bridge.stopAudio).toHaveBeenCalledWith('recording');
  expect((button('resume') as HTMLButtonElement).disabled).toBe(true);
  expect(h.audio.stop).not.toHaveBeenCalled();
  await act(async () => { stopped.resolve(); });
  const started = deferred<null>();
  h.bridge.startAudio.mockReturnValueOnce(started.promise);
  const frames = h.bridge.liveFrame.mock.calls.length;
  await click('resume');
  await click('resume');
  await act(async () => { await vi.advanceTimersByTimeAsync(5000); });
  expect(h.bridge.startAudio).toHaveBeenCalledTimes(2);
  expect(h.bridge.liveFrame).toHaveBeenCalledTimes(frames);
  expect(h.recorder.resume).not.toHaveBeenCalled();
  await act(async () => { started.resolve(null); });
  expect(h.audio.resume).toHaveBeenCalledOnce();
  expect(h.recorder.resume).toHaveBeenCalledOnce();
  expect(button('pause')).toBeTruthy();
});

it('keeps the paused recording available when reacquiring audio fails and allows retry', async () => {
  const h = await setup();
  await click('pause');
  h.bridge.startAudio.mockResolvedValueOnce('systemAudioFailed');
  await click('resume');
  expect(screen.getByRole('alert').textContent).toBe('regionScreenshot.live.systemAudioFailed');
  expect(h.audio.resume).not.toHaveBeenCalled();
  expect(h.recorder.resume).not.toHaveBeenCalled();
  expect((button('resume') as HTMLButtonElement).disabled).toBe(false);
  await click('resume');
  expect(h.recorder.resume).toHaveBeenCalledOnce();
});

it.each(['finish', 'unmount'] as const)('releases a late audio start after %s without restarting the recording', async (end) => {
  const h = await setup();
  await click('pause');
  const started = deferred<null>();
  h.bridge.startAudio.mockReturnValueOnce(started.promise);
  await click('resume');
  if (end === 'finish') await click('finish');
  else h.unmount();
  const stops = h.bridge.stopAudio.mock.calls.length;
  await act(async () => { started.resolve(null); });
  expect(h.bridge.stopAudio).toHaveBeenCalledTimes(stops + 1);
  expect(h.audio.resume).not.toHaveBeenCalled();
  expect(h.recorder.resume).not.toHaveBeenCalled();
  if (end === 'finish') expect(h.bridge.previewRecording).toHaveBeenCalled();
});

it('also releases audio when a frame error pauses recording', async () => {
  const h = await setup();
  h.bridge.liveFrame.mockRejectedValueOnce(new Error('capture unavailable'));
  await act(async () => { await vi.advanceTimersByTimeAsync(100); });
  expect(screen.getByRole('alert').textContent).toBe('regionScreenshot.live.captureFailed');
  expect(h.audio.pause).toHaveBeenCalledOnce();
  expect(h.bridge.stopAudio).toHaveBeenCalledOnce();
  expect(h.bridge.holdCapture).toHaveBeenCalledOnce();
  expect(button('finish')).toBeTruthy();
});
