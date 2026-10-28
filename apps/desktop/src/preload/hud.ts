import { ipcRenderer } from 'electron';
import type { HudApi, HudState } from '../shared/hud';
export const hudApi: HudApi = {
  get: () => ipcRenderer.invoke('hud:get'),
  setActive: (active) => ipcRenderer.invoke('hud:active', active),
  shiftLayer: (step) => ipcRenderer.invoke('hud:layer', step),
  setPassThrough: (enabled) => ipcRenderer.invoke('hud:pass-through', enabled),
  setPointerRegion: (region) => ipcRenderer.invoke('hud:pointer-region', region),
  setSettings: (patch) => ipcRenderer.invoke('hud:settings', patch),
  resetSettings: () => ipcRenderer.invoke('hud:reset'),
  capture: (input) => ipcRenderer.invoke('hud:capture', input),
  openScreenPermission: () => ipcRenderer.invoke('hud:screen-permission'),
  onChanged(callback) {
    const listener = (_event: Electron.IpcRendererEvent, value: HudState) => callback(value);
    ipcRenderer.on('hud:changed', listener);
    return () => ipcRenderer.removeListener('hud:changed', listener);
  },
};
