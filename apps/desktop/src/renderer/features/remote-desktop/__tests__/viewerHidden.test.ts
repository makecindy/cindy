import { afterEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopRequest } from '@cindy/device-link';
import type { RemoteDesktopViewerApi } from '../../../../shared/remoteDesktopViewer';
import { DesktopViewerController } from '../viewerController';

const runtime = vi.hoisted(() => ({
  post: null as ((message: Record<string, unknown>) => void) | null,
  receive: null as ReturnType<typeof vi.fn> | null,
}));
vi.mock('@cindy/maker-shared/remote-desktop-viewer', () => ({
  mountRemoteDesktopViewer: (_root: HTMLElement, post: typeof runtime.post) => {
    runtime.post = post;
    runtime.receive = vi.fn();
    return { receive: runtime.receive, dispose: vi.fn() };
  },
}));

let controller: DesktopViewerController | null = null;
afterEach(() => {
  controller?.dispose();
  controller = null;
  vi.useRealTimers();
});

async function setup({ viewerHidden = true, failResume = false, failPause = false } = {}) {
  vi.useFakeTimers();
  const requests: RemoteDesktopRequest[] = [];
  const api = {
    state: async () => ({
      generation: 1,
      active: true,
      target: { deviceId: 'host', name: 'Computer' },
    }),
    onActive: () => () => {},
    onLocale: () => () => {},
    onCloseRequested: () => () => {},
    ice: async () => [],
    clipboard: async () => {},
    close: async () => {},
    fullscreen: async () => {},
    resize: async () => {},
    rendererReady: async () => {},
    presentationReady: async () => {},
    inputFocus: async () => {},
    request: async (_generation, request) => {
      requests.push(request);
      if (request.op === 'capabilities')
        return {
          version: 1,
          enabled: true,
          canControl: true,
          viewerHidden,
          displays: [{ id: 'one', width: 1280, height: 720 }],
        };
      if (request.op === 'start')
        return {
          lease: 'lease',
          controlling: false,
          display: { id: 'one', width: 1280, height: 720 },
        };
      if (request.op === 'control' || request.op === 'heartbeat') return { controlling: true };
      if (request.op === 'frame') return { jpeg: 'AAAA' };
      if (request.op === 'viewerHidden' && failResume && !request.hidden)
        throw new Error('DESKTOP_REQUEST_FAILED');
      if (request.op === 'viewerHidden' && failPause && request.hidden)
        throw new Error('INVOKE_TIMEOUT');
      return {};
    },
  } satisfies RemoteDesktopViewerApi;
  controller = new DesktopViewerController(api, {} as HTMLElement, () => {});
  await vi.advanceTimersByTimeAsync(0);
  const receive = (message: Record<string, unknown>) =>
    runtime.post?.({ epoch: 'lease', ...message });
  const hidden = () =>
    requests.flatMap((request) => (request.op === 'viewerHidden' ? [request.hidden] : []));
  return { controller, requests, receive, hidden };
}

it('pauses host video only after the viewer stays hidden, and resumes at once', async () => {
  const h = await setup();
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(1499);
  expect(h.hidden()).toEqual([]);
  await vi.advanceTimersByTimeAsync(1);
  expect(h.hidden()).toEqual([true]);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true, false]);
});

it('ignores the brief hide/show of a macOS fullscreen transition', async () => {
  const h = await setup();
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(600);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.hidden()).toEqual([]);
});

it('never sends viewerHidden to a host without the capability', async () => {
  const h = await setup({ viewerHidden: false });
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(3000);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([]);
});

it('pauses a stream that starts while the viewer is already hidden', async () => {
  const h = await setup();
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(3000);
  expect(h.hidden()).toEqual([]);
  h.receive({ type: 'streaming' });
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true]);
});

it('rebuilds the video when a resume fails instead of leaving the picture frozen', async () => {
  const h = await setup({ failResume: true });
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(1500);
  runtime.receive!.mockClear();
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true, false]);
  expect(runtime.receive).toHaveBeenCalledWith(expect.objectContaining({ type: 'videoSettings' }));
});

it('stops screenshot polling while hidden and resumes it when shown', async () => {
  const h = await setup();
  const frames = () => h.requests.filter((request) => request.op === 'frame').length;
  await vi.advanceTimersByTimeAsync(350);
  h.receive({ type: 'framePresented' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(1500);
  const paused = frames();
  await vi.advanceTimersByTimeAsync(3500);
  expect(frames()).toBe(paused);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(700);
  expect(frames()).toBeGreaterThan(paused);
});

it('always resumes on show after a pause whose outcome is unknown', async () => {
  const h = await setup({ failPause: true });
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  await vi.advanceTimersByTimeAsync(1500);
  expect(h.hidden()).toEqual([true]);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true, false]);
});

it('resumes when shown while an unacknowledged pause was still in flight', async () => {
  let fail!: (error: Error) => void;
  const h = await setup();
  h.receive({ type: 'streaming' });
  h.controller.setHidden(true);
  // Hold the pause in flight, then show before it settles.
  const original = (h.controller as any).request;
  (h.controller as any).request = (value: any) =>
    value.op === 'viewerHidden' && value.hidden
      ? (h.requests.push(value),
        new Promise((_, reject) => {
          fail = reject;
        }))
      : original(value);
  await vi.advanceTimersByTimeAsync(1500);
  h.controller.setHidden(false);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true]);
  fail(new Error('INVOKE_TIMEOUT'));
  await vi.advanceTimersByTimeAsync(0);
  expect(h.hidden()).toEqual([true, false]);
});
