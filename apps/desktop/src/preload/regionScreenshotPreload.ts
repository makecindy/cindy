import { contextBridge, ipcRenderer } from 'electron';

import {
  REGION_SCREENSHOT_CHANNEL as C,
  type RegionRect,
  type RegionScreenshotHit,
  type RegionScreenshotBegin,
  type RegionScreenshotExport,
  type RegionScreenshotBitmap,
} from '../shared/regionScreenshot';
import { exposeScreenshotPageElectronApi, onPayload } from './screenshotPageBridge';
import { REGION_CAPTURE_CHANNEL as LIVE, type RegionCaptureMode } from '../shared/regionCapture';

/**
 * 框选浮层专用 preload: 只暴露 shared/regionScreenshot 的固定通道。每个调用都带
 * 会话 token, main 按 sender 与 token 双重核对, 迟到的调用对新会话无效。
 */
exposeScreenshotPageElectronApi();

contextBridge.exposeInMainWorld('regionScreenshot', {
  recordingControls: (token: string, expanded: boolean, point?: { x: number; y: number }, dragging = false) => ipcRenderer.invoke(LIVE.CONTROLS, token, expanded, point, dragging),
  previewRecording: (token: string, bytes: Uint8Array, format: 'webm' | 'gif') => ipcRenderer.invoke(LIVE.PREVIEW, token, bytes, format),
  autoScroll: (token: string, enabled: boolean) => ipcRenderer.invoke(LIVE.AUTO_SCROLL, token, enabled),
  startLive: (token: string, mode: RegionCaptureMode, selection: RegionRect) => ipcRenderer.invoke(LIVE.START, token, mode, selection),
  restoreEditor: (token: string, image: RegionScreenshotBitmap) => ipcRenderer.invoke(LIVE.EDIT, token, image),
  holdCapture: (token: string) => ipcRenderer.invoke(LIVE.HOLD, token),
  liveFrame: (token: string, keys: boolean, previewHeight?: number) => ipcRenderer.invoke(LIVE.FRAME, token, keys, previewHeight),
  saveRecording: (token: string, bytes: Uint8Array, format: 'webm' | 'gif') => ipcRenderer.invoke(LIVE.SAVE, token, bytes, format),
  shellReady: (): void => ipcRenderer.send(C.SHELL_READY),
  onBegin: (callback: (payload: RegionScreenshotBegin) => void): (() => void) =>
    onPayload(C.BEGIN, callback),
  onEnd: (callback: () => void): (() => void) => onPayload(C.END, callback),
  onClear: (callback: () => void): (() => void) => onPayload(C.CLEAR, callback),
  painted: (token: string): void => ipcRenderer.send(C.PAINTED, token),
  focused: (token: string): void => ipcRenderer.send(C.FOCUSED, token),
  selectionStarted: (token: string): void => ipcRenderer.send(C.SELECTION_START, token),
  copyText: (token: string, text: string): void => ipcRenderer.send(C.COPY_TEXT, token, text),
  cancel: (token: string): void => ipcRenderer.send(C.CANCEL, token),
  abandon: (): void => ipcRenderer.send(C.ABANDON),
  elementsAt: (token: string, windowId: number, x: number, y: number): Promise<RegionScreenshotHit | null> =>
    ipcRenderer.invoke(C.ELEMENTS_AT, token, windowId, x, y),
  exportImage: (token: string, payload: RegionScreenshotExport): Promise<boolean> =>
    ipcRenderer.invoke(C.EXPORT, token, payload),
});
