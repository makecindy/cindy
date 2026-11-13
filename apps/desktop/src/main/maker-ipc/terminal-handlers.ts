/**
 * RSB 终端 tab 的 IPC handler 集合。
 *
 * 设计：
 *   - 单一 `registerTerminalHandlers()` 入口，由 `register.ts` 在 maker IPC 注册末尾调一次。
 *   - 内部构造 PtyManager 单例（per main 进程），sink 走 `webContents.send`，把 PTY
 *     data / exit 推回创建它的 owner 窗口。
 *   - 所有失败统一走 `throwIpcError(code, message)`（rule 13），renderer 侧用
 *     `extractIpcError` 反解 code。
 *
 * channels：TERMINAL_INVOKE / TERMINAL_PUSH（见 channels.ts）。
 */

import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';

import { throwIpcError } from '../utils/ipcValidate.js';
import { TERMINAL_INVOKE, TERMINAL_PUSH } from './channels.js';
import {
  probeAvailableShells,
  type AvailableShell,
  type ShellId,
} from '../terminal/shellResolver.js';
import {
  type PtyManager,
  type PtyOwner,
  type CreateOptions,
  type CreateResult,
  type DataPayload,
  type ExitPayload,
} from '../terminal/ptyManager.js';
import { getDesktopHostTerminalService } from '../terminal/terminalService.desktop.js';
import {
  getDefaultShellPref,
  setDefaultShellPref,
} from '../terminal/terminalPrefsStore.js';

const VALID_SHELL_PREFS: ReadonlySet<ShellId> = new Set<ShellId>([
  'auto',
  'zsh',
  'bash',
  'fish',
  'sh',
  'pwsh',
  'powershell',
  'cmd',
  'gitbash',
  'wsl',
]);

export interface TerminalHandlersOptions {
  /**
   * owner webContents destroyed 时的 PTY 接管者(典型:主窗 webContents)。
   * RSB 独立子窗口销毁时把它名下的 PTY 转移回主窗保活,而不是杀掉;
   * 解析不到活 webContents(app 退出)时 PtyManager 回落 dispose。
   */
  getFallbackOwner?: () => WebContents | null;
}

/**
 * 在 main 进程注册所有终端 IPC handler。
 * 必须只调一次（重复注册会被 ipcMain 抛错）。返回 PtyManager 实例供调用方在
 * shutdown 流程里手动 dispose（如果需要）。
 */
export function registerTerminalHandlers(options?: TerminalHandlersOptions): PtyManager<PtyOwner> {
  const service = getDesktopHostTerminalService();
  service.bindUi({
    emitData: (target: WebContents, payload: DataPayload) => {
      if (!target.isDestroyed()) target.send(TERMINAL_PUSH.DATA, payload);
    },
    emitExit: (target: WebContents, payload: ExitPayload) => {
      if (!target.isDestroyed()) target.send(TERMINAL_PUSH.EXIT, payload);
    },
  }, options?.getFallbackOwner
    ? () => options.getFallbackOwner?.() ?? null
    : undefined);
  const manager = service.manager;

  ipcMain.handle(TERMINAL_INVOKE.CREATE, (event: IpcMainInvokeEvent, params: unknown) => {
    const opts = parseCreateParams(params, event.sender);
    // Renderer callers normally omit shellPref. Resolve the persisted default
    // once at the main-process create boundary so the session snapshots the
    // choice and restart keeps using the same preference even if Settings
    // changes later. Explicit `auto`, a concrete shell, and `null` keep their
    // existing caller-provided semantics.
    const resolvedOpts: CreateOptions = {
      ...opts,
      shellPref: opts.shellPref === undefined ? getDefaultShellPref() : opts.shellPref,
    };
    try {
      const result = manager.create(resolvedOpts);
      return result satisfies CreateResult;
    } catch (err) {
      // 区分 shell not found vs 通用 spawn 失败。shellResolver 永远返回 ResolvedShell，
      // 兜底到 /bin/sh / cmd.exe；这里失败一般是 spawn 系统调用层面的（权限 / 路径不可达）。
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found|no such file/i.test(msg)) {
        throwIpcError('TERMINAL_SHELL_NOT_FOUND', `shell binary unavailable: ${msg}`);
      }
      throwIpcError('TERMINAL_SPAWN_FAILED', `failed to spawn pty: ${msg}`);
    }
  });

  ipcMain.handle(TERMINAL_INVOKE.WRITE, (_event, idArg: unknown, dataArg: unknown) => {
    const id = requireString(idArg, 'id');
    const data = requireString(dataArg, 'data');
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    manager.write(id, data);
  });

  ipcMain.handle(TERMINAL_INVOKE.RESIZE, (_event, idArg: unknown, colsArg: unknown, rowsArg: unknown) => {
    const id = requireString(idArg, 'id');
    const cols = requirePositiveInt(colsArg, 'cols');
    const rows = requirePositiveInt(rowsArg, 'rows');
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    manager.resize(id, cols, rows);
  });

  ipcMain.handle(TERMINAL_INVOKE.DISPOSE, (_event, idArg: unknown) => {
    const id = requireString(idArg, 'id');
    manager.dispose(id);
  });

  ipcMain.handle(TERMINAL_INVOKE.RESTART, (event, idArg: unknown) => {
    const id = requireString(idArg, 'id');
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    try {
      const result = manager.restart(id, event.sender);
      return result satisfies CreateResult;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/still running/i.test(msg)) {
        throwIpcError('PRECONDITION_FAILED', 'cannot restart a session that has not exited');
      }
      if (/not found/i.test(msg)) {
        throwIpcError('TERMINAL_ALREADY_DISPOSED', `session already disposed: ${id}`);
      }
      throwIpcError('TERMINAL_SPAWN_FAILED', `restart failed: ${msg}`);
    }
  });

  ipcMain.handle(TERMINAL_INVOKE.LIST_AVAILABLE_SHELLS, (): AvailableShell[] => {
    return probeAvailableShells();
  });

  ipcMain.handle(TERMINAL_INVOKE.GET_DEFAULT_SHELL_PREF, (): ShellId => {
    return getDefaultShellPref();
  });

  ipcMain.handle(TERMINAL_INVOKE.SET_DEFAULT_SHELL_PREF, (_event, valueArg: unknown) => {
    if (typeof valueArg !== 'string' || !VALID_SHELL_PREFS.has(valueArg as ShellId)) {
      throwIpcError('INVALID_PARAMS', `invalid shell pref: ${String(valueArg)}`);
    }
    setDefaultShellPref(valueArg as ShellId);
  });

  return manager;
}

// ---------- params 校验 helpers ----------

function parseCreateParams(raw: unknown, owner: WebContents): CreateOptions {
  if (!raw || typeof raw !== 'object') {
    throwIpcError('INVALID_PARAMS', 'create params must be an object');
  }
  const obj = raw as Record<string, unknown>;
  const id = requireString(obj.id, 'id');
  const cwd = requireString(obj.cwd, 'cwd');
  const cols = optionalPositiveInt(obj.cols);
  const rows = optionalPositiveInt(obj.rows);
  const shellPref = optionalShellPref(obj.shellPref);
  return { id, cwd, cols, rows, shellPref, owner };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || value.length === 0) {
    throwIpcError('INVALID_PARAMS', `${name} must be a non-empty string`);
  }
  return value;
}

function requirePositiveInt(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throwIpcError('INVALID_PARAMS', `${name} must be a positive integer`);
  }
  return value;
}

function optionalPositiveInt(value: unknown): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 1 || !Number.isInteger(value)) {
    throwIpcError('INVALID_PARAMS', `optional number must be a positive integer if provided`);
  }
  return value;
}

function optionalShellPref(value: unknown): ShellId | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  if (typeof value !== 'string' || !VALID_SHELL_PREFS.has(value as ShellId)) {
    throwIpcError('INVALID_PARAMS', `invalid shellPref: ${String(value)}`);
  }
  return value as ShellId;
}
