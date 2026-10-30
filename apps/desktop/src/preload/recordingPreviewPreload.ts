import { contextBridge, ipcRenderer } from 'electron';
import { RECORDING_PREVIEW_CHANNEL as C, type RecordingPreviewDocument } from '../shared/regionCapture';
import { exposeScreenshotPageElectronApi, onPayload } from './screenshotPageBridge';

exposeScreenshotPageElectronApi();
contextBridge.exposeInMainWorld('recordingPreview', {
  ready: () => ipcRenderer.send(C.READY), failed: () => ipcRenderer.send(C.FAILED),
  onBegin: (callback: (document: RecordingPreviewDocument) => void) => onPayload(C.BEGIN, callback),
  onEnd: (callback: () => void) => onPayload(C.END, callback),
  painted: (token: string) => ipcRenderer.send(C.PAINTED, token),
  close: (token: string) => ipcRenderer.send(C.CLOSE, token),
  minimize: (token: string) => ipcRenderer.send(C.MINIMIZE, token),
  save: (token: string): Promise<boolean> => ipcRenderer.invoke(C.SAVE, token),
  copy: (token: string): Promise<boolean> => ipcRenderer.invoke(C.COPY, token),
});
