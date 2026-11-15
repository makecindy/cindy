import { contextBridge, ipcRenderer } from 'electron';

import {
  REGION_SCREENSHOT_PIN_CHANNEL as C,
  type RegionScreenshotPinCommand,
  type RegionScreenshotPinInit,
  type RegionScreenshotPinState,
} from '../shared/regionScreenshot';
import { exposeScreenshotPageElectronApi, onPayload } from './screenshotPageBridge';

/** 贴图窗口专用 preload: 只能操作自己这张贴图 (main 按 sender 反查)。 */
exposeScreenshotPageElectronApi();

contextBridge.exposeInMainWorld('regionScreenshotPin', {
  shellReady: (): void => ipcRenderer.send(C.SHELL_READY),
  onInit: (callback: (payload: RegionScreenshotPinInit) => void): (() => void) =>
    onPayload(C.INIT, callback),
  onState: (callback: (state: RegionScreenshotPinState) => void): (() => void) =>
    onPayload(C.STATE, callback),
  painted: (): void => ipcRenderer.send(C.PAINTED),
  dragStart: (): void => ipcRenderer.send(C.DRAG_START),
  dragMove: (): void => ipcRenderer.send(C.DRAG_MOVE),
  zoom: (steps: number, x: number, y: number): void => ipcRenderer.send(C.ZOOM, steps, x, y),
  opacity: (steps: number): void => ipcRenderer.send(C.OPACITY, steps),
  menu: (): void => ipcRenderer.send(C.MENU),
  command: (command: RegionScreenshotPinCommand): void => ipcRenderer.send(C.COMMAND, command),
  unlockHover: (hovering: boolean): void => ipcRenderer.send(C.UNLOCK_HOVER, hovering),
});
