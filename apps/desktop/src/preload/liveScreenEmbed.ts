import { ipcRenderer } from 'electron';
import { LIVE_SCREEN_EMBED, type LiveScreenEmbedBridge } from '../shared/remoteDesktopViewer';

function onPayload<T>(channel: string, cb: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => cb(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/** Device screens embedded in an app window; Main binds and checks everything. */
export function createLiveScreenEmbedBridge(): LiveScreenEmbedBridge {
  return {
    open: (embedId, target) => ipcRenderer.invoke(LIVE_SCREEN_EMBED.OPEN, embedId, target),
    request: (embedId, generation, request, mediaAttempt) =>
      ipcRenderer.invoke(LIVE_SCREEN_EMBED.REQUEST, embedId, generation, request, mediaAttempt),
    ice: (embedId, generation, mediaAttempt) =>
      ipcRenderer.invoke(LIVE_SCREEN_EMBED.ICE, embedId, generation, mediaAttempt),
    close: (embedId) => ipcRenderer.invoke(LIVE_SCREEN_EMBED.CLOSE, embedId),
    channelReply: (embedId, generation, id, outcome) =>
      ipcRenderer.invoke(LIVE_SCREEN_EMBED.CHANNEL_REPLY, embedId, generation, id, outcome),
    onActive: (listener) => onPayload(LIVE_SCREEN_EMBED.ACTIVE, listener),
    onChannelRequest: (listener) => onPayload(LIVE_SCREEN_EMBED.CHANNEL_REQUEST, listener),
  };
}
