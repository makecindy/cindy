import { FILE_PEER_LOCAL, type FilePeerHostApi, type FilePeerCommand } from '../shared/filePeer';
import { contextBridge, ipcRenderer } from 'electron';
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
  viewHeartbeat: (lease) => ipcRenderer.invoke(DESKTOP_LOCAL.VIEW_HEARTBEAT, lease),
  nativeFrame: (lease) => ipcRenderer.invoke(DESKTOP_LOCAL.NATIVE_FRAME, lease),
};
if (location.search === '?mode=files') {
  const files: FilePeerHostApi = {
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
  };
  contextBridge.exposeInMainWorld('filePeerHost', files);
} else contextBridge.exposeInMainWorld('desktopCapture', api);
