/**
 * RSB 终端 tab 的 IPC handler 集合。
 *
 * 设计：
 *   - 单一 `registerTerminalHandlers()` 入口，由 `register.ts` 在 maker IPC 注册末尾调一次。
 *   - 复用进程级 HostTerminalService 的 PtyManager，与宿主命令共用会话注册表；
 *     绑定 UI sink，通过 `webContents.send` 把 PTY data / exit 推回 owner 窗口。
 *   - 所有失败统一走 `throwIpcError(code, message)`（rule 13），renderer 侧用
 *     `extractIpcError` 反解 code。
 *
 * channels：TERMINAL_INVOKE / TERMINAL_PUSH（见 channels.ts）。
 */

import { randomUUID } from 'node:crypto';
import { ipcMain, type IpcMainInvokeEvent, type WebContents } from 'electron';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { isIpcErrorCode } from '../../shared/ipc-errors.js';
import { parseRemoteContext, parseRemoteConnection, remoteContextKey, type RemoteTerminalRuntime } from '../terminal/remoteTerminal.js';

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
  remote?: RemoteTerminalRuntime;
  /**
   * owner webContents destroyed 时的 PTY 接管者(典型:主窗 webContents)。
   * RSB 独立子窗口销毁时把它名下的 PTY 转移回主窗保活,而不是杀掉;
   * 解析不到活 webContents(app 退出)时 PtyManager 回落 dispose。
   */
  getFallbackOwner?: () => WebContents | null;
}

const REMOTE_TICKET_TTL_MS = 30_000;

/** A preparation, then single-use launch, bound to its window, tab and account generation. */
interface RemoteTicket {
  id: string;
  owner: WebContents;
  scope: string;
  epoch: number;
  context: string;
  expiresAt: number;
  launch?: Pick<CreateOptions, 'launch' | 'cwd'>;
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

  const tickets = new Map<string, RemoteTicket>();
  let accountEpoch = 0;
  const remoteScope = () => options?.remote?.scope() ?? '';
  const remoteOwnerKey = () => options?.remote?.ownerKey() ?? throwIpcError('PERMISSION_DENIED', 'Remote terminal owner is unavailable');
  options?.remote?.onInvalidated((disposeSessions) => {
    accountEpoch++;
    tickets.clear();
    // A temporary boundary or known same-owner projection repair invalidates
    // requests, not the independent SSH process. Real identity changes still
    // dispose before the new owner is published, including same-id realm moves.
    if (disposeSessions) manager.disposeRemote();
  });

  ipcMain.handle(TERMINAL_INVOKE.DESCRIBE_REMOTE, async (event, raw) => {
    assertTrustedAppRendererEvent(event);
    const remote = options?.remote;
    if (!remote) return throwIpcError('PRECONDITION_FAILED', 'Remote terminal is unavailable');
    const context = parseRemoteContext(raw);
    const params = raw as Record<string, unknown>;
    const id = requireRemoteId(params.id);
    const connection = params.connection === undefined ? undefined : parseRemoteConnection(params.connection);
    const account = remoteScope();
    const epoch = accountEpoch;
    const ticket = randomUUID();
    const request: RemoteTicket = { id, owner: event.sender, scope: account, epoch, context: remoteContextKey(context), expiresAt: Infinity };
    // Register before the first await so closing from any authorized window also
    // fences metadata, preparation and a binding write waiting for its lock.
    tickets.set(ticket, request);
    const assertCurrent = () => {
      if (tickets.get(ticket) !== request || event.sender.isDestroyed() || accountEpoch !== epoch || remoteScope() !== account) {
        throwIpcError('PERMISSION_DENIED', 'Terminal preparation is no longer valid');
      }
      assertTrustedAppRendererEvent(event);
    };
    try {
      const description = await remote.describe(context);
      assertCurrent();
      const selected = connection ?? description.connection;
      if (!selected) return description;
      const launch = await remote.prepare(selected, description.target.cwd, description.target.key, account, assertCurrent);
      assertCurrent();
      if (connection) {
        await remote.save(description.target.key, connection, account, assertCurrent);
        assertCurrent();
      }
      for (const [key, entry] of tickets) {
        if (entry.expiresAt <= Date.now() || entry.owner.isDestroyed()) tickets.delete(key);
      }
      request.launch = launch;
      request.expiresAt = Date.now() + REMOTE_TICKET_TTL_MS;
      setTimeout(() => tickets.delete(ticket), REMOTE_TICKET_TTL_MS).unref();
      return { ...description, connection: selected, ticket };
    } finally {
      if (!request.launch) tickets.delete(ticket);
    }
  });

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
    const rawRemote = (params as Record<string, unknown>).remote;
    const context = rawRemote === undefined ? null : parseRemoteContext(rawRemote);
    // Local terminals need no account gate, but must not attach to an SSH session.
    if (!context) {
      if (manager.isRemote(opts.id)) return throwIpcError('PERMISSION_DENIED', 'Terminal is remote');
      return spawn(resolvedOpts);
    }
    assertTrustedAppRendererEvent(event);
    requireRemoteId(opts.id);
    if (event.sender.isDestroyed()) return throwIpcError('PERMISSION_DENIED', 'Terminal owner is unavailable');
    const account = remoteScope();
    // A tab can move between trusted windows, but cannot change its task or account.
    if (manager.has(opts.id)) {
      const identity = manager.remoteIdentity(opts.id);
      if (!identity || identity.context !== remoteContextKey(context) || identity.ownerKey !== remoteOwnerKey()) {
        return throwIpcError('PERMISSION_DENIED', 'Terminal context mismatch');
      }
      return spawn(resolvedOpts);
    }
    const ticket = (rawRemote as Record<string, unknown>).ticket;
    if (ticket === undefined) return throwIpcError('PRECONDITION_FAILED', 'Remote terminal preparation is required');
    if (typeof ticket !== 'string' || !ticket.length) return throwIpcError('INVALID_PARAMS', 'Invalid terminal ticket');
    const request = tickets.get(ticket);
    // A supplied ticket that lost authority requires explicit recovery. Returning
    // PRECONDITION_FAILED would automatically prepare again after a cross-window close.
    if (!request?.launch) return throwIpcError('PERMISSION_DENIED', 'Remote terminal ticket is unavailable');
    if (request.id !== opts.id || request.owner !== event.sender || request.epoch !== accountEpoch || request.scope !== account || request.context !== remoteContextKey(context)) {
      return throwIpcError('PERMISSION_DENIED', 'Terminal ticket context mismatch');
    }
    tickets.delete(ticket);
    if (request.expiresAt <= Date.now()) return throwIpcError('PERMISSION_DENIED', 'Remote terminal ticket expired');
    // Consume before spawn, including failures; create performs no asynchronous work.
    return spawn({
      ...resolvedOpts, ...request.launch,
      remoteIdentity: { context: request.context, ownerKey: remoteOwnerKey() },
    });
  });

  function spawn(opts: CreateOptions): CreateResult {
    const isRemote = Boolean(opts.launch) || manager.isRemote(opts.id);
    try {
      return manager.create(opts);
    } catch (err) {
      if (err && typeof err === 'object' && 'code' in err && isIpcErrorCode(err.code)) throw err;
      // 区分 shell not found vs 通用 spawn 失败。shellResolver 永远返回 ResolvedShell，
      // 兜底到 /bin/sh / cmd.exe；这里失败一般是 spawn 系统调用层面的（权限 / 路径不可达）。
      const msg = err instanceof Error ? err.message : String(err);
      if (/ENOENT|not found|no such file/i.test(msg)) {
        throwIpcError('TERMINAL_SHELL_NOT_FOUND', isRemote ? 'Shell or SSH binary is unavailable' : `shell binary unavailable: ${msg}`);
      }
      throwIpcError('TERMINAL_SPAWN_FAILED', isRemote ? 'Failed to spawn terminal' : `failed to spawn pty: ${msg}`);
    }
  }

  // Remote operations extend the local terminal API with SSH authority. Keep that
  // authority at the trusted top-level frame and current PTY owner after transfers.
  function assertRemoteOwner(event: IpcMainInvokeEvent, id: string, closingContext?: unknown): void {
    if (!manager.isRemote(id)) return;
    assertTrustedAppRendererEvent(event);
    const identity = manager.remoteIdentity(id);
    // Closing a popped-out tab from the main window must still release its PTY.
    // That path supplies the task identity; a bare id grants only the current owner access.
    const ownsOperation = manager.isOwned(id, event.sender) || (closingContext !== undefined
      && identity?.context === remoteContextKey(parseRemoteContext(closingContext)));
    if (event.sender.isDestroyed() || !ownsOperation || !identity || identity.ownerKey !== remoteOwnerKey()) {
      throwIpcError('PERMISSION_DENIED', 'Terminal owner is no longer valid');
    }
  }

  ipcMain.handle(TERMINAL_INVOKE.WRITE, (event, idArg: unknown, dataArg: unknown) => {
    const id = requireString(idArg, 'id');
    assertRemoteOwner(event, id);
    const data = requireString(dataArg, 'data');
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    manager.write(id, data);
  });

  ipcMain.handle(TERMINAL_INVOKE.RESIZE, (event, idArg: unknown, colsArg: unknown, rowsArg: unknown) => {
    const id = requireString(idArg, 'id');
    assertRemoteOwner(event, id);
    const cols = requirePositiveInt(colsArg, 'cols');
    const rows = requirePositiveInt(rowsArg, 'rows');
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    manager.resize(id, cols, rows);
  });

  ipcMain.handle(TERMINAL_INVOKE.DISPOSE, (event, idArg: unknown, contextArg?: unknown) => {
    const id = requireString(idArg, 'id');
    assertRemoteOwner(event, id, contextArg);
    const preparations = [...tickets.entries()].filter(([, entry]) => entry.id === id);
    // A colliding local PTY retains the existing local close semantics; it does
    // not grant authority over another window's remote preparation.
    if (preparations.length && (!manager.has(id) || manager.isRemote(id))) {
      assertTrustedAppRendererEvent(event);
      const account = remoteScope();
      const identity = manager.remoteIdentity(id);
      const context = identity?.context ?? (contextArg === undefined ? undefined : remoteContextKey(parseRemoteContext(contextArg)));
      const authorized = preparations.filter(([, entry]) => entry.scope === account && entry.epoch === accountEpoch
        && (entry.owner === event.sender || entry.context === context));
      if (event.sender.isDestroyed() || (!identity && !authorized.length)) {
        return throwIpcError('PERMISSION_DENIED', 'Terminal owner is no longer valid');
      }
      // An owner closing by id also cancels the same tab/context's preparations
      // in other windows. Do not widen that authority to unrelated contexts.
      const contexts = new Set(authorized.map(([, entry]) => entry.context));
      for (const [ticket, entry] of preparations) {
        if (entry.scope === account && entry.epoch === accountEpoch && contexts.has(entry.context)) tickets.delete(ticket);
      }
    }
    manager.dispose(id);
  });

  ipcMain.handle(TERMINAL_INVOKE.RESTART, (event, idArg: unknown) => {
    const id = requireString(idArg, 'id');
    assertRemoteOwner(event, id);
    if (!manager.has(id)) throwIpcError('TERMINAL_NOT_FOUND', `pty session not found: ${id}`);
    const isRemote = manager.isRemote(id);
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
      throwIpcError('TERMINAL_SPAWN_FAILED', isRemote ? 'Failed to restart terminal' : `restart failed: ${msg}`);
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
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
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

function requireRemoteId(value: unknown): string {
  const id = requireString(value, 'id');
  if (id.length > 1024 || /[\x00-\x1f\x7f]/.test(id)) return throwIpcError('INVALID_PARAMS', 'Invalid remote terminal id');
  return id;
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
