import { contextBridge, ipcRenderer } from 'electron';

import {
  SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_READY_CHANNEL,
  SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL,
  type ScreenCaptureOverlayInitPayload,
  type ScreenCaptureOverlayResult,
} from '../shared/screenCapture';

/**
 * 区域截图选区覆盖层(win/linux, overlayCapture 创建的一次性窗口)专用最小
 * preload —— 只暴露 ready/init/contentReady/result 四个固定方法。不复用主窗口
 * preload.js: 选区覆盖层不需要文件/数据库/进程等任何主桥能力, 按最小权限
 * 隔离(review P1); 页面内容为 main 自生成 HTML, 无远端输入。
 */
contextBridge.exposeInMainWorld('regionCaptureOverlayAPI', {
  announceReady: (): void => ipcRenderer.send(SCREEN_CAPTURE_OVERLAY_READY_CHANNEL),
  announceContentReady: (): void =>
    ipcRenderer.send(SCREEN_CAPTURE_OVERLAY_CONTENT_READY_CHANNEL),
  onInit: (cb: (payload: ScreenCaptureOverlayInitPayload) => void): void => {
    ipcRenderer.on(
      SCREEN_CAPTURE_OVERLAY_INIT_CHANNEL,
      (_event: Electron.IpcRendererEvent, payload: ScreenCaptureOverlayInitPayload) => cb(payload),
    );
  },
  reportResult: (result: ScreenCaptureOverlayResult): void =>
    ipcRenderer.send(SCREEN_CAPTURE_OVERLAY_RESULT_CHANNEL, result),
});
