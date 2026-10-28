import { contextBridge, ipcRenderer } from 'electron';
import { REGION_SCREENSHOT_EDITOR_CHANNEL as C, type RegionScreenshotBegin, type RegionScreenshotExport } from '../shared/regionScreenshot';
import { exposeScreenshotPageElectronApi, onPayload } from './screenshotPageBridge';

exposeScreenshotPageElectronApi();
// An image editor has no screen-capture, automation or window-discovery privileges.
contextBridge.exposeInMainWorld('regionScreenshotEditor', {
  failed: () => ipcRenderer.send(C.FAILED),
  shellReady: () => ipcRenderer.send(C.READY),
  onBegin: (callback: (payload: RegionScreenshotBegin) => void) => onPayload(C.BEGIN, callback),
  onEnd: (callback: () => void) => onPayload(C.END, callback),
  painted: (token: string) => ipcRenderer.send(C.PAINTED, token),
  cancel: (token: string) => ipcRenderer.send(C.CANCEL, token),
  minimize: (token: string) => ipcRenderer.send(C.MINIMIZE, token),
  exportImage: (token: string, payload: RegionScreenshotExport): Promise<boolean> => ipcRenderer.invoke(C.EXPORT, token, payload),
});
