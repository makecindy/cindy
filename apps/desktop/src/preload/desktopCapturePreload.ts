import { FILE_PEER_LOCAL, type FilePeerHostApi, type FilePeerCommand } from '../shared/filePeer';
import { contextBridge, ipcRenderer } from 'electron';
import { RECORDING_AUDIO, type RecordingAudioApi } from '../shared/recordingAudio';
import { DIRECT_LINK_LOCAL, type DirectLinkHostApi } from '../shared/directLink';
import type { DirectRuntimeCommand } from '@cindy/device-link';
import {
  DESKTOP_LOCAL,
  type DesktopCaptureApi,
  type DesktopHostCommand,
} from '../shared/remoteDesktop';

/** No settings, filesystem, chat, credentials or general IPC in the capture process. */
const api: DesktopCaptureApi = {
  registerHost: () => ipcRenderer.invoke(DESKTOP_LOCAL.REGISTER),
  stop: () => ipcRenderer.invoke(DESKTOP_LOCAL.CAPTURE_STOP),
  onCommand: (listener) => {
    const wrapped = (_event: Electron.IpcRendererEvent, command: DesktopHostCommand) =>
      listener(command);
    ipcRenderer.on(DESKTOP_LOCAL.COMMAND, wrapped);
    return () => {
      ipcRenderer.removeListener(DESKTOP_LOCAL.COMMAND, wrapped);
    };
  },
  reply: (id, result) => ipcRenderer.invoke(DESKTOP_LOCAL.REPLY, id, result),
  input: (lease, sequence, events) =>
    ipcRenderer.invoke(DESKTOP_LOCAL.INPUT, lease, sequence, events),
  request: (lease, request) => ipcRenderer.invoke(DESKTOP_LOCAL.CHANNEL_REQUEST, lease, request),
  viewHeartbeat: (lease) => ipcRenderer.invoke(DESKTOP_LOCAL.VIEW_HEARTBEAT, lease),
  nativeFrame: (lease) => ipcRenderer.invoke(DESKTOP_LOCAL.NATIVE_FRAME, lease),
  nativeAudio: (lease) => ipcRenderer.invoke(DESKTOP_LOCAL.NATIVE_AUDIO, lease),
  liveScreenFrames: (lease, keyframe) =>
    ipcRenderer.invoke(DESKTOP_LOCAL.LIVE_SCREEN_FRAMES, lease, keyframe),
};
// The one-shot reply port is held by this preload and carries only the final byte counts.
function onFinishTraffic(channel: string, finish: () => Promise<{ sent: number; received: number }>): void {
  ipcRenderer.once(channel, event => {
    const port = event.ports[0];
    if (port) void finish().then(({ sent, received }) => port.postMessage({ sent, received })).finally(() => port.close());
  });
}
if (location.search === '?mode=recording') {
  const recording: RecordingAudioApi = {
    register: () => ipcRenderer.invoke(RECORDING_AUDIO.REGISTER),
    data: (bytes) => ipcRenderer.send(RECORDING_AUDIO.DATA, bytes),
    state: (error) => ipcRenderer.send(RECORDING_AUDIO.STATE, error),
  };
  contextBridge.exposeInMainWorld('recordingAudio', recording);
} else if (location.search === '?mode=direct') {
  const direct: DirectLinkHostApi = {
    onFinishTraffic: finish => onFinishTraffic(DIRECT_LINK_LOCAL.FINISH_TRAFFIC, finish),
    traffic: (sent, received) => { void ipcRenderer.invoke(DIRECT_LINK_LOCAL.TRAFFIC, sent, received).catch(() => {}); },
    register: () => ipcRenderer.invoke(DIRECT_LINK_LOCAL.REGISTER),
    event: (event) => { void ipcRenderer.invoke(DIRECT_LINK_LOCAL.EVENT, event).catch(() => {}); },
    onCommand: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, command: DirectRuntimeCommand) => listener(command);
      ipcRenderer.on(DIRECT_LINK_LOCAL.COMMAND, wrapped);
      return () => { ipcRenderer.removeListener(DIRECT_LINK_LOCAL.COMMAND, wrapped); };
    },
  };
  contextBridge.exposeInMainWorld('directLinkHost', direct);
} else if (location.search === '?mode=files') {
  const files: FilePeerHostApi = {
    onFinishTraffic: finish => onFinishTraffic(FILE_PEER_LOCAL.FINISH_TRAFFIC, finish),
    traffic: (sent, received) => { void ipcRenderer.invoke(FILE_PEER_LOCAL.TRAFFIC, sent, received).catch(() => {}); },
    closed: (connection, reason) => ipcRenderer.invoke(FILE_PEER_LOCAL.CLOSED, connection, reason),
    register: () => ipcRenderer.invoke(FILE_PEER_LOCAL.REGISTER),
    onCommand: (listener) => {
      const wrapped = (_e: Electron.IpcRendererEvent, id: string, command: FilePeerCommand) =>
        listener(id, command);
      ipcRenderer.on(FILE_PEER_LOCAL.COMMAND, wrapped);
      return () => {
        ipcRenderer.removeListener(FILE_PEER_LOCAL.COMMAND, wrapped);
      };
    },
    reply: (id, ok, value) => ipcRenderer.invoke(FILE_PEER_LOCAL.REPLY, id, ok, value),
    read: (connection, ticket, offset, maxBytes) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.READ, connection, ticket, offset, maxBytes),
    write: (sink, offset, base64) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.WRITE, sink, offset, base64),
    invoke: (connection, payload, body) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.INVOKE, connection, payload, body),
  };
  contextBridge.exposeInMainWorld('filePeerHost', files);
} else contextBridge.exposeInMainWorld('desktopCapture', api);
