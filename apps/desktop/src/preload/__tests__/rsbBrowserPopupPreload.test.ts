import { afterEach, describe, expect, it, vi } from 'vitest';

type IpcHandler = (event: unknown, data: unknown, ownerStamp?: unknown) => void;

const ipcMocks = vi.hoisted(() => ({
  listeners: new Map<string, IpcHandler>(),
  invoke: vi.fn(() => Promise.resolve({ ok: true })),
  exposeInMainWorld: vi.fn(),
  on: vi.fn((channel: string, handler: IpcHandler) => {
    ipcMocks.listeners.set(channel, handler);
  }),
  removeListener: vi.fn((channel: string, handler: IpcHandler) => {
    if (ipcMocks.listeners.get(channel) === handler) ipcMocks.listeners.delete(channel);
  }),
  send: vi.fn(),
  sendSync: vi.fn((channel: string) => {
    if (channel === 'app-locale:get-preferred-system-locale-sync') return 'en-US';
    if (channel === 'get-app-display-version-info') return { version: 'test' };
    if (channel === 'client-endpoints:get-sync') return {};
    if (channel === 'appearance-settings:get-sync') return {};
    if (channel === 'get-os-release') return 'test-os';
    if (channel === 'get-app-version') return '1.0.0';
    return undefined;
  }),
  sendToHost: vi.fn(),
}));

vi.mock('electron', () => ({
  contextBridge: { exposeInMainWorld: ipcMocks.exposeInMainWorld },
  ipcRenderer: {
    on: ipcMocks.on,
    removeListener: ipcMocks.removeListener,
    invoke: ipcMocks.invoke,
    send: ipcMocks.send,
    sendSync: ipcMocks.sendSync,
    sendToHost: ipcMocks.sendToHost,
  },
  webUtils: { getPathForFile: vi.fn() },
}));

const popupChannel = 'rsb:browser-popup';
const nativePopupCloseChannel = 'rsb-native-popup:close';

async function loadElectronApi(): Promise<{
  onRsbBrowserPopup: (callback: (payload: unknown) => void) => () => void;
}> {
  vi.resetModules();
  await import('../preload');
  const call = ipcMocks.exposeInMainWorld.mock.calls.find(([name]) => name === 'electronAPI');
  if (!call) throw new Error('electronAPI was not exposed');
  return call[1] as {
    onRsbBrowserPopup: (callback: (payload: unknown) => void) => () => void;
  };
}

function emitPopup(data: unknown): void {
  const handler = ipcMocks.listeners.get(popupChannel);
  if (!handler) throw new Error('popup IPC handler is not bound');
  handler({}, data);
}

describe('RSB popup preload backlog disposal', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.resetModules();
    ipcMocks.listeners.clear();
    ipcMocks.invoke.mockReset();
    ipcMocks.invoke.mockImplementation(() => Promise.resolve({ ok: true }));
    ipcMocks.exposeInMainWorld.mockReset();
    ipcMocks.on.mockClear();
    ipcMocks.removeListener.mockClear();
  });

  it('closes only the oldest valid native surface on overflow and replays the rest', async () => {
    ipcMocks.invoke.mockRejectedValue(new Error('surface already gone'));
    const electronApi = await loadElectronApi();

    emitPopup({ url: 'about:blank', nativePopupSurfaceId: 42 });
    emitPopup(null);
    const malformedListener = vi.fn();
    const offMalformed = electronApi.onRsbBrowserPopup(malformedListener);
    offMalformed();
    expect(malformedListener).not.toHaveBeenCalled();
    expect(ipcMocks.invoke).not.toHaveBeenCalledWith(
      nativePopupCloseChannel,
      expect.anything(),
    );

    for (let index = 0; index < 9; index += 1) {
      emitPopup({
        url: `about:blank#${index}`,
        disposition: 'foreground-tab',
        nativePopupSurfaceId: `surface-${index}`,
      });
    }
    expect(ipcMocks.invoke).toHaveBeenCalledTimes(1);
    expect(ipcMocks.invoke).toHaveBeenCalledWith(nativePopupCloseChannel, {
      surfaceId: 'surface-0',
    });

    const replayed = vi.fn();
    electronApi.onRsbBrowserPopup(replayed);
    expect(replayed).toHaveBeenCalledTimes(8);
    expect(replayed.mock.calls.map(([payload]) => (payload as { url: string }).url)).toEqual(
      Array.from({ length: 8 }, (_, index) => `about:blank#${index + 1}`),
    );
  });

  it('closes expired valid native surfaces on the next bridge event and keeps fresh data', async () => {
    vi.useFakeTimers();
    const electronApi = await loadElectronApi();

    emitPopup({
      url: 'about:blank#expired',
      disposition: 'foreground-tab',
      nativePopupSurfaceId: 'surface-expired',
    });
    await vi.advanceTimersByTimeAsync(30_001);
    emitPopup({
      url: 'about:blank#fresh',
      disposition: 'foreground-tab',
      nativePopupSurfaceId: 'surface-fresh',
    });

    expect(ipcMocks.invoke).toHaveBeenCalledTimes(1);
    expect(ipcMocks.invoke).toHaveBeenCalledWith(nativePopupCloseChannel, {
      surfaceId: 'surface-expired',
    });
    const replayed = vi.fn();
    electronApi.onRsbBrowserPopup(replayed);
    expect(replayed).toHaveBeenCalledTimes(1);
    expect(replayed).toHaveBeenCalledWith(
      expect.objectContaining({ nativePopupSurfaceId: 'surface-fresh' }),
    );
  });
});
