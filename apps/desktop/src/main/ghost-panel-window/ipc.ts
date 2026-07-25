/**
 * registerGhostPanelWindowIpc —— 插件面板独立窗口的 IPC 注册。
 *
 * 全部委托给 GhostPanelWindowsController,这里只做:
 *  - sender 归属校验:invoke 一律 assertTrustedAppRendererEvent(主窗/副窗/
 *    面板子窗都是 markAppContentWindow 过的同源受信 renderer;插件 webview
 *    没有 preload 根本到不了这些通道,这层闸防的是越权 frame);
 *  - payload 运行时校验(throwIpcError INVALID_PARAMS);
 *  - 首帧 sendSync 通道:不受信 sender 回空对象,绝不 throw 进 sendSync。
 */

import { ipcMain } from 'electron';

import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent, isTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isValidGhostId } from '../../shared/ghost.js';
import type { GhostPanelWindowsController } from './controller.js';

const log = createLogger('ghost-panel-window-ipc');

/** 首帧同步读通道(与 layout:get / ghosts:list 同模式,见 channels.ts 注释)。 */
export const GHOST_PANEL_WINDOW_GET_STATE_SYNC = 'ghost-panel-window:get-state-sync';

export function registerGhostPanelWindowIpc(controller: GhostPanelWindowsController): void {
  ipcMain.handle(MAKER_INVOKE.GHOST_PANEL_WINDOW_GET_STATE, (event) => {
    assertTrustedAppRendererEvent(event);
    return controller.getState();
  });

  ipcMain.handle(MAKER_INVOKE.GHOST_PANEL_WINDOW_OPEN, (event, ghostId: unknown) => {
    assertTrustedAppRendererEvent(event);
    if (!isValidGhostId(ghostId)) {
      throwIpcError('INVALID_PARAMS', 'ghostId must be a valid ghost id');
    }
    controller.open(ghostId);
  });

  ipcMain.handle(
    MAKER_INVOKE.GHOST_PANEL_WINDOW_SET_DETACHED,
    (event, ghostId: unknown, detached: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (!isValidGhostId(ghostId)) {
        throwIpcError('INVALID_PARAMS', 'ghostId must be a valid ghost id');
      }
      if (typeof detached !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'detached required (boolean)');
      }
      return controller.setDetached(ghostId, detached);
    },
  );

  ipcMain.on(GHOST_PANEL_WINDOW_GET_STATE_SYNC, (event) => {
    // sendSync 不能 throw(会把异常序列化回 sendSync 调用点);不受信回空 map。
    if (!isTrustedAppRendererEvent(event)) {
      log.warn('get-state-sync from untrusted sender, returning empty state');
      event.returnValue = {};
      return;
    }
    event.returnValue = controller.getState();
  });
}
