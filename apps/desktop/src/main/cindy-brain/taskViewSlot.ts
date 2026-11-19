/**
 * taskViewSlot.ts — 任务页开页槽(taskView)。
 * ---------------------------------------------------------------------------
 * 插件经管子上行 `{type:'task-view-request', sessionId?}`,请主机在指定任务的
 * 右侧栏打开(或聚焦)它自己的任务页页签。页签只承载插件自己的包内页面,
 * 不接收任何网址:没有跳转面,也就没有 preview 那样的白名单与限速。
 *
 * - 资格审:已装、启用、声明了 taskView;
 * - 落点:显式 sessionId 优先(通常来自 session-context 注入),缺省台前任务,
 *   两者皆无如实拒;sessionId 只做形状校验(右侧栏是本机用户自己的 UI);
 * - 成功回执带回实际落点任务,插件据此绑定自己的业务状态;
 * - `peek: true` 只回答"现在打开会落到哪个任务"(没有任务则 HOST_NOT_READY),
 *   不开页签;供插件决定界面里是否出现"在当前任务中打开"一类入口。
 * - 另一台电脑上的任务用 list_sessions 给出的 `deviceId::sessionId`(`local::` 即本机):
 *   只接受 focus:true 并消费真实点击,经既有任务导航带上设备打开;页签只推给声明了
 *   `taskView.remote` 的插件(其余插件的任务页在远程任务上本就不显示)。
 *
 * 纯逻辑 + 依赖注入:广播在 cindy-brain/index.ts 组装时注入。
 */

import type { BrowserWindow } from 'electron';

import type { GhostPipeTaskViewResult, InstalledGhost } from '../../shared/ghost.js';
import { installedGhostStoragePart } from '../../shared/pluginIdentity.js';
import { isMainShellWindowUrl } from './scheduleSlot.js';

/** 推给 renderer 的开页载荷(实例 id 由主机按已装清单填,不信自报)。 */
export interface GhostTaskViewOpenPush {
  instanceId: string;
  sessionId: string;
  focus?: true;
}

/** Electron 投递适配器；保留在槽旁边以便免启动 Electron 验证窗口生命周期。 */
export function broadcastTaskViewOpen<T extends Pick<BrowserWindow, 'isDestroyed' | 'webContents'>>(
  windows: T[],
  payload: GhostTaskViewOpenPush,
  send: (window: T, payload: GhostTaskViewOpenPush) => void,
): boolean {
  let delivered = false;
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    const contents = window.webContents;
    if (contents.isDestroyed() || contents.isCrashed() ||
      contents.isLoadingMainFrame() || !isMainShellWindowUrl(contents.getURL())) continue;
    // 沙箱、副任务窗、侧栏窗不消费此推送；重载期间也不能报告成功。
    try {
      send(window, payload);
      delivered = true;
    } catch {
      // 窗口可能在检查后关闭；继续尝试其它主窗口，无投递则回 HOST_NOT_READY。
    }
  }
  return delivered;
}

export interface TaskViewSlotDeps {
  getGhost(id: string): InstalledGhost | null;
  /** 把开页请求推给主窗口;false = 没有可接收的主 Renderer(HOST_NOT_READY)。 */
  broadcast(payload: GhostTaskViewOpenPush): boolean;
  /** 台前任务快照(请求缺省 sessionId 时的落点;非任务页为 null)。 */
  focusedSessionId(): string | null;
  /** 消费 Host 观察到的该实例真实点击，不信任插件自报 focus。 */
  consumeUserGesture(ghostId: string): boolean;
  /** 本机设备 id:`<本机>::id` 与 `local::id` 一样按本机任务处理。 */
  localDeviceId?(): string | null;
  log?: { info: (msg: string, meta?: Record<string, unknown>) => void };
}

const SESSION_ID_RE = /^[A-Za-z0-9-]{1,64}$/;
/**
 * `deviceId::sessionId` as list_sessions qualifies remote rows (`_history_devices.ts`). Device ids
 * are machine ids or an explicit override, so only whitespace and `:` are excluded; the session
 * part keeps the local shape.
 */
const QUALIFIED_SESSION_ID_RE = /^([^\s:]{1,128})::([A-Za-z0-9-]{1,64})$/;

function fail(
  errorCode: Extract<GhostPipeTaskViewResult, { ok: false }>['errorCode'],
  message: string,
): GhostPipeTaskViewResult {
  return { ok: false, errorCode, message };
}

export class GhostTaskViewSlot {
  private revealSession: ((sessionId: string, deviceId?: string) => void) | null = null;

  constructor(private readonly deps: TaskViewSlotDeps) {}

  setRevealSession(reveal: ((sessionId: string, deviceId?: string) => void) | null): void {
    this.revealSession = reveal;
  }

  handleRequest(ghostId: string, payload: unknown): GhostPipeTaskViewResult {
    const ghost = this.deps.getGhost(ghostId);
    if (!ghost?.enabled || !ghost.manifest.taskView) {
      return fail('PERMISSION_DENIED', '插件未声明任务页(taskView),或当前未启用');
    }
    if (payload !== undefined && (!payload || typeof payload !== 'object' || Array.isArray(payload))) {
      return fail('INVALID_REQUEST', 'task-view-request 载荷必须是对象');
    }
    const request = (payload ?? {}) as Record<string, unknown>;
    let requestedSessionId: string | undefined;
    let deviceId: string | undefined;
    if (request.sessionId !== undefined) {
      const qualified = typeof request.sessionId === 'string' ? QUALIFIED_SESSION_ID_RE.exec(request.sessionId) : null;
      if (qualified) {
        requestedSessionId = qualified[2];
        if (qualified[1] !== 'local' && qualified[1] !== this.deps.localDeviceId?.()) deviceId = qualified[1];
      } else if (typeof request.sessionId === 'string' && SESSION_ID_RE.test(request.sessionId)) {
        requestedSessionId = request.sessionId;
      } else {
        return fail('INVALID_REQUEST', 'sessionId 形状不合法');
      }
    }
    if (request.peek !== undefined && request.peek !== true) {
      return fail('INVALID_REQUEST', 'peek 只接受 true');
    }
    if (request.focus !== undefined && typeof request.focus !== 'boolean') {
      return fail('INVALID_REQUEST', 'focus 必须是布尔值');
    }
    const sessionId = requestedSessionId ?? this.deps.focusedSessionId();
    if (!sessionId) return fail('HOST_NOT_READY', '当前没有任务可承载任务页');
    // Receipts keep the qualified id so the plugin binds the same task it listed.
    const receiptSessionId = deviceId ? `${deviceId}::${sessionId}` : sessionId;
    if (request.peek === true) return { ok: true, sessionId: receiptSessionId };
    if (deviceId && request.focus !== true) {
      return fail('INVALID_REQUEST', '其它电脑上的任务只能在用户点击时打开(focus: true)');
    }
    if (request.focus === true && !this.revealSession)
      return fail('HOST_NOT_READY', '任务导航尚未就绪');
    if (request.focus === true && !this.deps.consumeUserGesture(ghostId))
      return fail('PERMISSION_DENIED', '切换任务需要用户当次点击');
    // A remote task only shows plugin task pages declared with taskView.remote.
    if (!deviceId || ghost.manifest.taskView?.remote === true) {
      const delivered = this.deps.broadcast({
        instanceId: installedGhostStoragePart(ghost),
        sessionId,
        ...(request.focus === true ? { focus: true as const } : {}),
      });
      if (!delivered) return fail('HOST_NOT_READY', '当前没有可用的宿主窗口');
    }
    if (request.focus === true) {
      if (deviceId) this.revealSession!(sessionId, deviceId);
      else this.revealSession!(sessionId);
    }
    this.deps.log?.info('ghost task view open requested', { ghostId, sessionId, remote: !!deviceId });
    return {
      ok: true,
      sessionId: receiptSessionId,
      ...(request.focus === true ? { focusRequested: true as const } : {}),
    };
  }
}
