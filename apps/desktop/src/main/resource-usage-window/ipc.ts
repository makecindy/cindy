/**
 * registerResourceUsageWindowIpc —— 资源用量子窗口的 IPC 注册。
 *
 * open / close 由可信 Cindy 页面调用；ready 还会核验 sender 确实属于当前资源窗口。
 */

import { ipcMain } from 'electron';

import {
  RESOURCE_USAGE_WINDOW_OPEN_CHANNEL,
  RESOURCE_USAGE_WINDOW_CLOSE_CHANNEL,
  RESOURCE_USAGE_WINDOW_PRESENTATION_READY_CHANNEL,
  RESOURCE_USAGE_WINDOW_RENDERER_READY_CHANNEL,
} from '../../shared/resourceUsageWindow.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import type { ResourceUsageWindowController } from './controller.js';

export function registerResourceUsageWindowIpc(params: {
  controller: ResourceUsageWindowController;
}): void {
  const { controller } = params;

  ipcMain.handle(RESOURCE_USAGE_WINDOW_OPEN_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.open(event.sender);
  });

  ipcMain.handle(RESOURCE_USAGE_WINDOW_CLOSE_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.close(event.sender);
  });

  ipcMain.handle(RESOURCE_USAGE_WINDOW_RENDERER_READY_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.markRendererReady(event.sender);
  });

  ipcMain.handle(RESOURCE_USAGE_WINDOW_PRESENTATION_READY_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.markPresentationReady(event.sender);
  });
}
