/**
 * registerRsbWindowIpc —— 右侧栏子窗口的 IPC 注册(invoke + fire-and-forget)。
 *
 * 全部委托给 RsbWindowController(状态机单例),这里只做:
 *  - payload 运行时校验(throwIpcError INVALID_PARAMS)
 *  - sender 归属校验:SET_CONTEXT / SEND_COMMAND 只信主窗、READY 只信子窗口
 */

import { ipcMain } from 'electron';
import type { BrowserWindow } from 'electron';

import { MAKER_INVOKE, MAKER_SEND } from '../maker-ipc/channels.js';
import { createLogger } from '../logger.js';
import { requireObject, throwIpcError } from '../utils/ipcValidate.js';
import type {
  RsbWindowCommand,
  RsbWindowCommandRouteRequest,
  RsbWindowContext,
} from '../../shared/rightSidebarWindow.js';
import { parseConversationSearchJump } from '../../shared/conversationSearchJump.js';
import { isValidGhostId } from '../../shared/ghost.js';
import type { RsbWindowController } from './controller.js';

const log = createLogger('right-sidebar-window-ipc');

function parseContext(raw: unknown): RsbWindowContext {
  const r = requireObject(raw, 'context');
  const nullableString = (v: unknown, name: string): string | null => {
    if (v === null || v === undefined) return null;
    if (typeof v !== 'string') throwIpcError('INVALID_PARAMS', `${name} must be string | null`);
    return v;
  };
  if (typeof r.available !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'available must be boolean');
  }
  return {
    sessionId: nullableString(r.sessionId, 'sessionId'),
    workdir: nullableString(r.workdir, 'workdir'),
    remoteHostId: nullableString(r.remoteHostId, 'remoteHostId'),
    available: r.available,
  };
}

function parseCommand(raw: unknown): RsbWindowCommand {
  const r = requireObject(raw, 'command');
  if (typeof r.sessionId !== 'string' || r.sessionId.length === 0) {
    throwIpcError('INVALID_PARAMS', 'command.sessionId required');
  }
  if (r.type === 'open-terminal') {
    return { type: 'open-terminal', sessionId: r.sessionId };
  }
  if (r.type === 'open-web-browser') {
    if (typeof r.url !== 'string' || r.url.length === 0) {
      throwIpcError('INVALID_PARAMS', 'command.url required');
    }
    return { type: 'open-web-browser', sessionId: r.sessionId, url: r.url };
  }
  if (r.type === 'open-ghost-tab') {
    // ghostId 复用身份卡同一校验(小写/数字/连字符,1–32),野值不进命令通道。
    if (!isValidGhostId(r.ghostId)) {
      throwIpcError('INVALID_PARAMS', 'command.ghostId must be a valid ghost id');
    }
    return { type: 'open-ghost-tab', sessionId: r.sessionId, ghostId: r.ghostId };
  }
  if (r.type === 'ensure-orca-workers-tab') {
    const hasFocusWorkerSessionId =
      Object.prototype.hasOwnProperty.call(r, 'focusWorkerSessionId') &&
      r.focusWorkerSessionId !== undefined;
    if (
      hasFocusWorkerSessionId &&
      r.focusWorkerSessionId !== null &&
      typeof r.focusWorkerSessionId !== 'string'
    ) {
      throwIpcError('INVALID_PARAMS', 'command.focusWorkerSessionId must be string | null');
    }
    if (r.focusTab !== undefined && typeof r.focusTab !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'command.focusTab must be boolean');
    }
    const hasSearchJump =
      Object.prototype.hasOwnProperty.call(r, 'searchJump') && r.searchJump !== undefined;
    const searchJump = parseConversationSearchJump(r.searchJump);
    if (hasSearchJump && r.searchJump !== null && !searchJump) {
      throwIpcError('INVALID_PARAMS', 'command.searchJump must be a conversation-search payload');
    }
    const focusWorkerSessionId = r.focusWorkerSessionId as string | null;
    return {
      type: 'ensure-orca-workers-tab',
      sessionId: r.sessionId,
      ...(hasFocusWorkerSessionId ? { focusWorkerSessionId } : {}),
      ...(hasSearchJump ? { searchJump } : {}),
      focusTab: r.focusTab === true,
    };
  }
  if (r.type === 'close-orca-workers-tab') {
    return { type: 'close-orca-workers-tab', sessionId: r.sessionId };
  }
  if (r.type === 'open-background-tasks-tab') {
    const hasFocusTaskId =
      Object.prototype.hasOwnProperty.call(r, 'focusTaskId') && r.focusTaskId !== undefined;
    if (hasFocusTaskId && r.focusTaskId !== null && typeof r.focusTaskId !== 'string') {
      throwIpcError('INVALID_PARAMS', 'command.focusTaskId must be string | null');
    }
    return {
      type: 'open-background-tasks-tab',
      sessionId: r.sessionId,
      ...(hasFocusTaskId ? { focusTaskId: r.focusTaskId as string | null } : {}),
    };
  }
  if (r.type === 'open-file-browser') {
    if (r.targetKind === 'external-file') {
      if (typeof r.absPath !== 'string' || r.absPath.length === 0) {
        throwIpcError('INVALID_PARAMS', 'command.absPath required');
      }
      return {
        type: 'open-file-browser',
        sessionId: r.sessionId,
        absPath: r.absPath,
        targetKind: 'external-file',
      };
    }
    if (typeof r.relPath !== 'string' || r.relPath.length === 0) {
      throwIpcError('INVALID_PARAMS', 'command.relPath required');
    }
    if (r.targetKind !== 'file' && r.targetKind !== 'directory') {
      throwIpcError(
        'INVALID_PARAMS',
        'command.targetKind must be file | directory | external-file',
      );
    }
    return {
      type: 'open-file-browser',
      sessionId: r.sessionId,
      relPath: r.relPath,
      targetKind: r.targetKind,
    };
  }
  throwIpcError('INVALID_PARAMS', `unknown rsb-window command type: ${String(r.type)}`);
}

function parseCommandRouteRequest(raw: unknown): RsbWindowCommandRouteRequest {
  const request = requireObject(raw, 'request');
  if (typeof request.allowOpen !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'request.allowOpen required (boolean)');
  }
  if (request.userInitiated !== undefined && typeof request.userInitiated !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'request.userInitiated must be boolean');
  }
  return {
    command: parseCommand(request.command),
    allowOpen: request.allowOpen,
    ...(request.userInitiated === undefined ? {} : { userInitiated: request.userInitiated }),
  };
}

/** open 的可选 payload:缺省(旧签名 / 无参调用)= 用户手势,保持既有聚焦行为。 */
function parseOpenUserInitiated(raw: unknown): boolean {
  if (raw === undefined || raw === null) return true;
  const r = requireObject(raw, 'options');
  if (r.userInitiated !== undefined && typeof r.userInitiated !== 'boolean') {
    throwIpcError('INVALID_PARAMS', 'options.userInitiated must be boolean');
  }
  return r.userInitiated !== false;
}

export function registerRsbWindowIpc(opts: {
  controller: RsbWindowController;
  getMainWindow: () => BrowserWindow | null;
}): void {
  const { controller, getMainWindow } = opts;

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_GET_STATE, () => controller.getState());

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_OPEN, (_e, payload: unknown) => {
    controller.open({ userInitiated: parseOpenUserInitiated(payload) });
  });

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_CLOSE, () => {
    controller.close();
  });

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_SET_DETACHED, (_e, detached: unknown) => {
    if (typeof detached !== 'boolean') {
      throwIpcError('INVALID_PARAMS', 'detached required (boolean)');
    }
    return controller.setDetached(detached);
  });

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_GET_CONTEXT, () => controller.getContext());

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_READY, (event) => {
    // 只有子窗口 renderer 的握手才算数,主窗误调不置 ready(避免 ensureOpen 提前放行)
    const sidebarWc = controller.getSidebarWebContents();
    if (!sidebarWc || event.sender !== sidebarWc) {
      log.warn('RSB_WINDOW_READY from non-sidebar sender, ignored');
      return;
    }
    controller.markReady();
  });

  ipcMain.handle(MAKER_INVOKE.RSB_WINDOW_SEND_COMMAND, async (event, payload: unknown) => {
    // 参数错误无论 sender 身份都按 IPC 契约抛 INVALID_PARAMS。
    const request = parseCommandRouteRequest(payload);
    const main = getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents) {
      log.warn('RSB_WINDOW_SEND_COMMAND from non-main-window sender, dropped');
      return 'stale-context';
    }
    return controller.routeCommand(request);
  });

  ipcMain.on(MAKER_SEND.RSB_WINDOW_SET_CONTEXT, (event, payload: unknown) => {
    const main = getMainWindow();
    if (!main || main.isDestroyed() || event.sender !== main.webContents) {
      log.warn('RSB_WINDOW_SET_CONTEXT from non-main-window sender, dropped');
      return;
    }
    try {
      controller.setContext(parseContext(payload));
    } catch (err) {
      // fire-and-forget 通道没有 invoke 错误回传,坏 payload 记日志丢弃
      log.warn('invalid RSB_WINDOW_SET_CONTEXT payload dropped', {
        error: err instanceof Error ? err.message : String(err),
      });
    }
  });
}
