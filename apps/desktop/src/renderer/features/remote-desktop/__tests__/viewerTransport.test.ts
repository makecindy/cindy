import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RemoteDesktopViewerApi } from '../../../../shared/remoteDesktopViewer';
import { DesktopViewerController, type ViewerSnapshot } from '../viewerController';

const runtime = vi.hoisted(() => ({
  post: null as ((message: Record<string, unknown>) => void) | null,
}));
vi.mock('@cindy/maker-shared/remote-desktop-viewer', () => ({
  mountRemoteDesktopViewer: (_root: HTMLElement, post: typeof runtime.post) => {
    runtime.post = post;
    return { receive: vi.fn(), dispose: vi.fn() };
  },
}));

let controller: DesktopViewerController;
let snapshot: ViewerSnapshot;
beforeEach(async () => {
  vi.useFakeTimers();
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
    rendererReady: async () => {},
    presentationReady: async () => {},
    inputFocus: async () => {},
    request: async (_generation, request) => {
      if (request.op === 'capabilities')
        return {
          version: 1,
          enabled: true,
          canControl: false,
          displays: [{ id: 'one', width: 1280, height: 720 }],
        };
      if (request.op === 'start')
        return {
          lease: 'lease',
          controlling: false,
          display: { id: 'one', width: 1280, height: 720 },
        };
      return {};
    },
  } satisfies RemoteDesktopViewerApi;
  controller = new DesktopViewerController(
    api,
    {} as HTMLElement,
    (state) => {
      snapshot = state;
    },
  );
  await vi.advanceTimersByTimeAsync(0);
});
afterEach(() => {
  controller.dispose();
  vi.useRealTimers();
});
const receive = (message: Record<string, unknown>) =>
  runtime.post?.({ epoch: 'lease', ...message });

it('identifies the first screenshot before video negotiation settles', () => {
  receive({ type: 'framePresented' });
  expect(snapshot).toMatchObject({ ready: true, transport: 'screenshots', latency: null });
});

it('clears old route and RTT during fallback and waits for the recovered video route', () => {
  receive({ type: 'streaming' });
  receive({ type: 'network', transport: 'direct', latencyMs: 23 });
  expect(snapshot).toMatchObject({ transport: 'direct', latency: 23 });
  receive({ type: 'framePresented' }); // A late JPEG must not replace presented video.
  expect(snapshot.transport).toBe('direct');
  receive({ type: 'fallback' });
  expect(snapshot).toMatchObject({ transport: 'screenshots', latency: null });
  receive({ type: 'network', transport: 'direct', latencyMs: 24 });
  expect(snapshot).toMatchObject({ transport: 'screenshots', latency: null });
  receive({ type: 'streaming' });
  expect(snapshot).toMatchObject({ transport: 'video', latency: null });
  receive({ type: 'network', transport: 'relay', latencyMs: 96 });
  expect(snapshot).toMatchObject({ transport: 'relay', latency: 96 });
});

it('does not present unrecognized routes or invalid latency as confirmed measurements', () => {
  receive({ type: 'streaming' });
  receive({ type: 'network', transport: 'unknown', latencyMs: 10 });
  expect(snapshot).toMatchObject({ transport: 'video', latency: null });
  receive({ type: 'network', transport: 'direct', latencyMs: Number.NaN });
  expect(snapshot).toMatchObject({ transport: 'direct', latency: null });
});
