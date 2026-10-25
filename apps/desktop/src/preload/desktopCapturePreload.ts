import { FILE_PEER_LOCAL, type FilePeerHostApi, type FilePeerCommand } from '../shared/filePeer';
import { contextBridge, ipcRenderer } from 'electron';
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
};
if (location.search === '?mode=direct') {
  const direct: DirectLinkHostApi = {
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
    closed: (connection) => ipcRenderer.invoke(FILE_PEER_LOCAL.CLOSED, connection),
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
    read: (connection, ticket, offset) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.READ, connection, ticket, offset),
    write: (sink, offset, base64) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.WRITE, sink, offset, base64),
    invoke: (connection, payload, body) =>
      ipcRenderer.invoke(FILE_PEER_LOCAL.INVOKE, connection, payload, body),
  };
  contextBridge.exposeInMainWorld('filePeerHost', files);
} else contextBridge.exposeInMainWorld('desktopCapture', api);
