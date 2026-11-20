import { contextBridge, ipcRenderer } from 'electron';
import { TRAY_EVENT, TRAY_VIEW, type QuotaTrayBridge } from '../shared/quotaTray.js';
import type { MenubarView } from '../shared/menubarQuota.js';

let windowHidden = true;
ipcRenderer.on('window-hidden-change', (_event, hidden: boolean) => { windowHidden = hidden; });

const bridge: QuotaTrayBridge = {
  ready: () => ipcRenderer.send(TRAY_EVENT, 'ready'),
  painted: () => ipcRenderer.send(TRAY_EVENT, 'painted'),
  refresh: () => ipcRenderer.send(TRAY_EVENT, 'refresh'),
  openApp: () => ipcRenderer.send(TRAY_EVENT, 'open-app'),
  openSession: id => ipcRenderer.send(TRAY_EVENT, 'open-session', id),
  detailAction: id => ipcRenderer.send(TRAY_EVENT, 'detail-action', id),
  updateSettings: patch => ipcRenderer.send(TRAY_EVENT, 'settings', patch),
  openProviderSettings: () => ipcRenderer.send(TRAY_EVENT, 'open-provider-settings'),
  openRemoteControlSettings: () => ipcRenderer.send(TRAY_EVENT, 'open-remote-control-settings'),
  resize: height => ipcRenderer.send(TRAY_EVENT, 'resize', height),
  onWindowHiddenChange(listener) {
    const receive = (_: unknown, hidden: boolean) => listener(hidden);
    ipcRenderer.on('window-hidden-change', receive);
    listener(windowHidden);
    return () => ipcRenderer.removeListener('window-hidden-change', receive);
  },
  subscribe(listener) {
    const receive = (_: unknown, view: MenubarView | null) => listener(view);
    ipcRenderer.on(TRAY_VIEW, receive);
    return () => ipcRenderer.removeListener(TRAY_VIEW, receive);
  },
};
contextBridge.exposeInMainWorld('quotaTray', bridge);
