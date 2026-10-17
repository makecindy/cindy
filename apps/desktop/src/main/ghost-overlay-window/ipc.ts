/**
 * registerGhostOverlayWindowIpc —— 桌面浮窗(ghost overlay window)的 IPC 注册。
 *
 * 沿用 ghost-panel-window/ipc.ts 模式:
 *  - GET_STATE / SET_USER_ENABLED:invoke,断言 Cindy 自有顶层 renderer
 *    (assertTrustedAppRendererEvent)。浮窗自身不是 app content 窗口,不在该
 *    信任集内;
 *  - GET_USER_ENABLED_SYNC:sendSync 首帧同步读用户开关(与 ghost-panel-window
 *    的 get-state-sync 同款,规则 7 首帧无跳变);sendSync 不 throw,不受信/非法
 *    一律回默认 true(仅影响 UI 展示,不影响 main 侧 mount 门)。
 *  - 就绪握手(RENDERER_READY / PRESENTATION_READY):invoke,但 sender 必须是
 *    Task 3 registry 里已登记的浮窗 webContents——用 webContents.id 反查
 *    ghostId 验身,再交给 controller.mark*Ready(sender)(controller 内部再按
 *    slotForSender 把 sender 映射到具体 ghostId);
 *  - VISIBILITY_CHANGED 推送由 controller 直接发浮窗 webContents(见
 *    controller.sendVisibility),这里不另注册。
 *
 * SET_USER_ENABLED 关闭开关时先 hide 再落盘(用户意图优先):即使 store 写失败
 * (损坏文件),已可见浮窗也已隐藏,不等待下次 mount/show/reconcile;重新开启不
 * 自动 show(由插件自己 mount)。
 */

import { ipcMain } from 'electron';

import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererEvent,
} from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { isValidPluginStoragePart } from '../../shared/pluginIdentity.js';
import {
  GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL,
  GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL,
} from '../../shared/ghostOverlayWindow.js';
import type { GhostOverlayWindowsController } from './controller.js';
import { ghostIdForOverlayWebContents } from './registry.js';

/** 首帧同步读通道(与 ghost-panel-window:get-state-sync 同模式)。 */
export const GHOST_OVERLAY_WINDOW_GET_USER_ENABLED_SYNC =
  'ghost-overlay-window:get-user-enabled-sync';

export interface GhostOverlayWindowIpcDeps {
  controller: GhostOverlayWindowsController;
  /** 用户 kill switch 写入(per-owner 持久化)。 */
  setUserEnabled: (ghostId: string, enabled: boolean) => void;
  /** 用户 kill switch 读取(per-owner 持久化;sendSync 首帧用)。 */
  getUserEnabled: (ghostId: string) => boolean;
}

export function registerGhostOverlayWindowIpc(deps: GhostOverlayWindowIpcDeps): void {
  const { controller, setUserEnabled, getUserEnabled } = deps;

  ipcMain.handle(MAKER_INVOKE.GHOST_OVERLAY_WINDOW_GET_STATE, (event) => {
    assertTrustedAppRendererEvent(event);
    return controller.getState();
  });

  ipcMain.on(GHOST_OVERLAY_WINDOW_GET_USER_ENABLED_SYNC, (event, ghostId: unknown) => {
    // sendSync 不能 throw;不受信/非法一律回默认 true(仅 UI 展示,mount 门在
    // main 侧另有 readOverlayUserEnabled 把关)。
    if (!isTrustedAppRendererEvent(event) || !isValidPluginStoragePart(ghostId)) {
      event.returnValue = true;
      return;
    }
    event.returnValue = getUserEnabled(ghostId);
  });

  ipcMain.handle(
    MAKER_INVOKE.GHOST_OVERLAY_WINDOW_SET_USER_ENABLED,
    (event, ghostId: unknown, enabled: unknown) => {
      assertTrustedAppRendererEvent(event);
      if (!isValidPluginStoragePart(ghostId)) {
        throwIpcError('INVALID_PARAMS', 'ghostId must be a valid ghost id');
      }
      if (typeof enabled !== 'boolean') {
        throwIpcError('INVALID_PARAMS', 'enabled must be a boolean');
      }
      // 即时反馈:关掉开关时先 hide 已可见浮窗(用户意图优先),再落盘;即使 store
      // 写失败(损坏文件),已可见浮窗也已隐藏,不等待下次 mount/show/reconcile。
      if (!enabled && controller.getState()[ghostId]?.visible) {
        controller.hide(ghostId);
      }
      setUserEnabled(ghostId, enabled);
    },
  );

  // ── 双阶段就绪握手 ────────────────────────────────────────────────
  // 浮窗页零桥、不在信任 app renderer 集合内;身份只能靠 Task 3 registry 反查,
  // 未登记的 webContents 一律拒绝(fail closed),不接受 renderer 自报 ghostId。
  // 现状:当前由宿主 webContents 事件(dom-ready/did-finish-load)驱动;本通道为
  // 未来有桥形态预留、fail-closed。

  ipcMain.handle(GHOST_OVERLAY_WINDOW_RENDERER_READY_CHANNEL, (event) => {
    const ghostId = ghostIdForOverlayWebContents(event.sender.id);
    if (!ghostId) {
      throwIpcError('PERMISSION_DENIED', 'overlay ready channel 只能由已登记的浮窗页面发起');
    }
    controller.markRendererReady(event.sender);
  });

  ipcMain.handle(GHOST_OVERLAY_WINDOW_PRESENTATION_READY_CHANNEL, (event) => {
    const ghostId = ghostIdForOverlayWebContents(event.sender.id);
    if (!ghostId) {
      throwIpcError('PERMISSION_DENIED', 'overlay ready channel 只能由已登记的浮窗页面发起');
    }
    controller.markPresentationReady(event.sender);
  });
}
