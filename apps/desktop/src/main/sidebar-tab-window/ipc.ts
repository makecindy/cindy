/**
 * registerSidebarTabWindowIpc —— 右侧栏页签独立窗口的 IPC 注册。
 *
 * 全部委托给 SidebarTabWindowsController,这里只做:
 *  - sender 归属校验:弹出 / 搬入 / 聚焦 / 关闭由主窗发起(弹出窗口自己也可以
 *    对自己承载的页签发 close-for-tab:页签在它里面被关掉 / guest 自关时);
 *    就绪握手、取指派、合并回侧边栏、收编新建页签只认弹出窗口自身;
 *  - payload 运行时校验(throwIpcError INVALID_PARAMS)。
 */

import { ipcMain, type BrowserWindow } from 'electron';

import { MAKER_INVOKE } from '../maker-ipc/channels.js';
import { createLogger } from '../logger.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { requireObject, requireString, throwIpcError } from '../utils/ipcValidate.js';
import { MAX_STATE_JSON_BYTES } from '../../shared/rightSidebarTabState.js';
import type { RsbWindowTabSnapshot } from '../../shared/rightSidebarWindow.js';
import type {
  SidebarTabReturnSnapshot,
  SidebarTabWindowContext,
  SidebarTabWindowOpenRequest,
} from '../../shared/sidebarTabWindow.js';
import {
  SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL,
  SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL,
  SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL,
  SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL,
  SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL,
} from '../../shared/sidebarTabWindow.js';
import type { SidebarTabWindowsController } from './controller.js';

const log = createLogger('sidebar-tab-window-ipc');

const MAX_ID_LENGTH = 512;
const MAX_HANDOFF_TABS = 20;

function requireId(value: unknown, name: string): string {
  const id = requireString(value, name);
  if (id.length > MAX_ID_LENGTH) throwIpcError('INVALID_PARAMS', `${name} is too long`);
  return id;
}

function optionalNullableString(value: unknown, name: string): string | null | undefined {
  if (value === undefined || value === null) return value;
  return requireId(value, name);
}

function parseContext(raw: unknown): SidebarTabWindowContext {
  const obj = requireObject(raw, 'context');
  const workdir = optionalNullableString(obj.workdir, 'context.workdir') ?? null;
  const remoteHostId = optionalNullableString(obj.remoteHostId, 'context.remoteHostId') ?? null;
  const deviceLinkDeviceId = optionalNullableString(
    obj.deviceLinkDeviceId,
    'context.deviceLinkDeviceId',
  );
  if (obj.subagentsAvailable !== undefined && typeof obj.subagentsAvailable !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'context.subagentsAvailable must be boolean');
  }
  return {
    workdir,
    remoteHostId,
    ...(deviceLinkDeviceId !== undefined ? { deviceLinkDeviceId } : {}),
    ...(typeof obj.subagentsAvailable === 'boolean'
      ? { subagentsAvailable: obj.subagentsAvailable }
      : {}),
  };
}

function parseTabRow(raw: unknown, name: string): { id: string; kind: string; state: unknown } {
  const tab = requireObject(raw, name);
  const id = requireId(tab.id, `${name}.id`);
  const kind = requireId(tab.kind, `${name}.kind`);
  let stateJson: string | undefined;
  try {
    stateJson = JSON.stringify(tab.state);
  } catch {
    throwIpcError('INVALID_PARAMS', `${name}.state is not JSON-serializable`);
  }
  if (
    typeof stateJson !== 'string' ||
    Buffer.byteLength(stateJson, 'utf8') > MAX_STATE_JSON_BYTES
  ) {
    throwIpcError('RIGHT_SIDEBAR_STATE_TOO_LARGE', `${name}.state is too large`);
  }
  return { id, kind, state: tab.state };
}

/** 弹出时主窗交付的不可持久化会话整桶快照(与 RSB 窗口 handoff 同一形状)。 */
function parseHandoff(raw: unknown): RsbWindowTabSnapshot | null {
  if (raw === undefined || raw === null) return null;
  const snapshot = requireObject(raw, 'handoff');
  const sessionId = requireId(snapshot.sessionId, 'handoff.sessionId');
  if (snapshot.persistable !== false) {
    throwIpcError('INVALID_PARAMS', 'handoff must be non-persistable');
  }
  if (!Array.isArray(snapshot.tabs) || snapshot.tabs.length > MAX_HANDOFF_TABS) {
    throwIpcError('INVALID_PARAMS', 'handoff.tabs must be an array');
  }
  const activeTabId = snapshot.activeTabId;
  if (
    activeTabId !== null &&
    (typeof activeTabId !== 'string' || activeTabId.length > MAX_ID_LENGTH)
  ) {
    throwIpcError('INVALID_PARAMS', 'handoff.activeTabId is invalid');
  }
  const tabs = snapshot.tabs.map((rawTab, index) => parseTabRow(rawTab, `handoff.tabs[${index}]`));
  return { sessionId, tabs, activeTabId, persistable: false };
}

/** 合并回侧边栏时弹出窗口交回的单页签快照。 */
function parseReturnSnapshot(raw: unknown): SidebarTabReturnSnapshot | null {
  if (raw === undefined || raw === null) return null;
  const snapshot = requireObject(raw, 'snapshot');
  const sessionId = requireId(snapshot.sessionId, 'snapshot.sessionId');
  const tab = parseTabRow(snapshot.tab, 'snapshot.tab');
  return { sessionId, tab };
}

function parsePosition(raw: unknown): { x: number; y: number } | undefined {
  if (raw === undefined || raw === null) return undefined;
  const obj = requireObject(raw, 'position');
  if (
    typeof obj.x !== 'number' ||
    typeof obj.y !== 'number' ||
    !Number.isFinite(obj.x) ||
    !Number.isFinite(obj.y)
  ) {
    throwIpcError('INVALID_PARAMS', 'position must have finite x / y');
  }
  return { x: obj.x as number, y: obj.y as number };
}

function parseOpenRequest(raw: unknown): SidebarTabWindowOpenRequest {
  const obj = requireObject(raw, 'open request');
  const targetWindowId = optionalNullableString(obj.targetWindowId, 'targetWindowId');
  const position = parsePosition(obj.position);
  return {
    tabId: requireId(obj.tabId, 'tabId'),
    // 全局页签(插件视图)不属于任何任务:sessionId 为 null。
    sessionId: optionalNullableString(obj.sessionId, 'sessionId') ?? null,
    context: parseContext(obj.context),
    handoff: parseHandoff(obj.handoff),
    ...(targetWindowId ? { targetWindowId } : {}),
    ...(position ? { position } : {}),
  };
}

export function registerSidebarTabWindowIpc(opts: {
  controller: SidebarTabWindowsController;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const { controller, getMainWindow } = opts;

  const isMainWindowSender = (sender: Electron.WebContents): boolean => {
    const main = getMainWindow();
    return Boolean(main && !main.isDestroyed() && sender === main.webContents);
  };

  ipcMain.handle(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_GET_STATE, (event) => {
    assertTrustedAppRendererEvent(event);
    return controller.getState();
  });

  ipcMain.handle(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_OPEN, (event, payload: unknown) => {
    assertTrustedAppRendererEvent(event);
    const request = parseOpenRequest(payload);
    if (!isMainWindowSender(event.sender)) {
      log.warn('SIDEBAR_TAB_WINDOW_OPEN from non-main-window sender, dropped');
      throwIpcError('PERMISSION_DENIED', 'only the main window can pop out a tab');
    }
    if (!controller.open(request)) {
      throwIpcError('INTERNAL', 'failed to open the sidebar tab window');
    }
  });

  ipcMain.handle(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_FOCUS, (event, tabId: unknown, options?: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireId(tabId, 'tabId');
    const opts = options === undefined ? {} : requireObject(options, 'options');
    if (opts.userInitiated !== undefined && typeof opts.userInitiated !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'userInitiated must be a boolean');
    }
    controller.focus(id, { userInitiated: opts.userInitiated !== false });
  });

  ipcMain.handle(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_RETURN_TAB, (event, tabId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireId(tabId, 'tabId');
    if (!isMainWindowSender(event.sender)) {
      log.warn('SIDEBAR_TAB_WINDOW_RETURN_TAB from non-main-window sender, dropped');
      throwIpcError('PERMISSION_DENIED', 'only the main window can return a global tab');
    }
    return controller.returnGlobalTab(id);
  });

  ipcMain.handle(MAKER_INVOKE.SIDEBAR_TAB_WINDOW_CLOSE_FOR_TAB, (event, tabId: unknown) => {
    assertTrustedAppRendererEvent(event);
    const id = requireId(tabId, 'tabId');
    const ownSlot = controller.slotForSender(event.sender);
    const ownsTab = ownSlot ? controller.slotOwnsTab(ownSlot, id) : false;
    if (!isMainWindowSender(event.sender) && !ownsTab) {
      log.warn('SIDEBAR_TAB_WINDOW_CLOSE_FOR_TAB from unrelated sender, dropped', { tabId: id });
      throwIpcError('PERMISSION_DENIED', 'sender does not own this tab');
    }
    controller.closeForTab(id);
  });

  // ── 弹出窗口自身 ─────────────────────────────────────────────────────

  ipcMain.handle(SIDEBAR_TAB_WINDOW_GET_ASSIGNMENT_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    return controller.getAssignment(event.sender);
  });

  ipcMain.handle(SIDEBAR_TAB_WINDOW_RENDERER_READY_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.markRendererReady(event.sender);
  });

  ipcMain.handle(SIDEBAR_TAB_WINDOW_PRESENTATION_READY_CHANNEL, (event) => {
    assertTrustedAppRendererEvent(event);
    controller.markPresentationReady(event.sender);
  });

  ipcMain.handle(SIDEBAR_TAB_WINDOW_MERGE_BACK_CHANNEL, (event, rawRequest: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(rawRequest, 'merge-back request');
    const tabId = requireId(obj.tabId, 'tabId');
    const snapshot = parseReturnSnapshot(obj.snapshot);
    const slot = controller.slotForSender(event.sender);
    if (!slot || !controller.slotOwnsTab(slot, tabId)) {
      log.warn('SIDEBAR_TAB_WINDOW_MERGE_BACK from non-owner sender, ignored', { tabId });
      return;
    }
    controller.mergeBack(event.sender, tabId, snapshot);
  });

  ipcMain.handle(SIDEBAR_TAB_WINDOW_ADOPT_TAB_CHANNEL, (event, rawRequest: unknown) => {
    assertTrustedAppRendererEvent(event);
    const obj = requireObject(rawRequest, 'adopt request');
    const tabId = requireId(obj.tabId, 'tabId');
    const sessionId = optionalNullableString(obj.sessionId, 'sessionId') ?? null;
    if (!controller.slotForSender(event.sender)) {
      log.warn('SIDEBAR_TAB_WINDOW_ADOPT_TAB from non-tab-window sender, ignored', { tabId });
      return;
    }
    controller.adoptTab(event.sender, tabId, sessionId, parseReturnSnapshot(obj.snapshot));
  });
}
