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
contextBridge.exposeInMainWorld('desktopCapture', api);
