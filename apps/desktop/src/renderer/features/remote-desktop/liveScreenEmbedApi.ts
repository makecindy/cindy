import type {
  LiveScreenEmbedBridge,
  RemoteDesktopViewerApi,
  RemoteViewerState,
  RemoteViewerTarget,
} from '../../../shared/remoteDesktopViewer';

/**
 * The viewer controller's window bridge, served by an embedded device screen
 * instead: one mounted panel is one `embedId`, and Main binds its target.
 * Window-only operations (resize, fullscreen, shortcut capture, this
 * computer's clipboard) do nothing here; a panel has no window of its own.
 * `onEnded` reports that Main ended or refused the connection.
 */
export function createLiveScreenEmbedApi(
  bridge: LiveScreenEmbedBridge,
  target: RemoteViewerTarget,
  onEnded: () => void,
): RemoteDesktopViewerApi & { dispose(): void } {
  const embedId = `ls-${crypto.randomUUID()}`;
  let disposed = false;
  let opened: Promise<RemoteViewerState> | null = null;
  const listeners = new Set<(state: RemoteViewerState) => void>();
  const offActive = bridge.onActive((payload) => {
    if (disposed || payload?.embedId !== embedId) return;
    for (const listener of listeners) listener(payload.state);
    if (!payload.state.active) onEnded();
  });
  const none = () => () => {};
  const done = async () => {};
  return {
    state: () =>
      (opened ??= bridge.open(embedId, target).catch((error: unknown) => {
        if (!disposed) onEnded();
        throw error;
      })),
    request: (generation, request, mediaAttempt) =>
      bridge.request(embedId, generation, request, mediaAttempt),
    ice: (generation, mediaAttempt) => bridge.ice(embedId, generation, mediaAttempt),
    clipboard: async () => {
      throw new Error('CLIPBOARD_UNSUPPORTED');
    },
    close: () => bridge.close(embedId),
    fullscreen: done,
    resize: done,
    rendererReady: done,
    presentationReady: done,
    inputFocus: done,
    onActive: (listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    onLocale: none,
    onCloseRequested: none,
    onChannelRequest: (listener) =>
      bridge.onChannelRequest((payload) => {
        if (!disposed && payload?.embedId === embedId) listener(payload);
      }),
    channelReply: (generation, id, outcome) =>
      bridge.channelReply(embedId, generation, id, outcome),
    dispose() {
      if (disposed) return;
      disposed = true;
      offActive();
      listeners.clear();
      void bridge.close(embedId).catch(() => {});
    },
  };
}
