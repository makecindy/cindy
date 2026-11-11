/**
 * SidebarTabWindowsController —— 右侧栏页签独立窗口的状态机(main 侧单例,
 * 依赖注入可测)。
 *
 * 模型:一扇窗口 = 一个住在别的窗口里的页签组,承载同一任务的若干页签 + 任意全局
 * 页签。主窗的侧边栏继续存在并显示其余页签;「合并回侧边栏」按页签送回,窗口清空即
 * 销毁;关窗(红绿灯 / Windows X)= 关闭窗口里的全部页签(与侧边栏里关页签同一条
 * store.closeTab 流程,插件清理与确认拦截照常);崩溃 = 全部页签回到侧边栏(数据不丢)。
 * 没有「偏好」可落盘:弹出是本次运行期的视图态,客户端重启后所有页签都回到主窗。
 *
 * 生命周期基线对齐 docs/dev-rules/electron-security-and-process-boundaries.md §3.1
 * (资源用量窗口 controller 为权威基线):
 *   - 预热:主窗首帧稳定后后台创建一扇**未指派**的隐藏窗口(spare);弹出时直接
 *     指派页签给它,用户点击路径只剩「指派 → 首份内容 → show+focus」。指派后再
 *     延迟补一扇 spare。
 *   - 双阶段就绪:renderer-ready(壳已挂载,可接收指派)→ presentation-ready
 *     (被指派页签的首份内容已提交)后才 show;超时只展示已挂载的 Loading 壳。
 *   - 关闭即销毁而非隐藏复用:页签关掉 / 回到侧边栏后窗口没有可复用的内容,隐藏
 *     保活只会按页签数囤积 renderer;§3.1 的隐藏复用面向「同一内容反复打开」的窗口,
 *     这里由 spare 预热承担「下次弹出不冷启动」。
 *   - 故障隔离且恢复有界:弹出窗口崩溃 / 加载失败 → 销毁并把页签交回侧边栏
 *     (侧边栏本身就是安全态,不重建 renderer 循环);spare 崩溃最多自动补建一次。
 *
 * 不直接 import electron —— BrowserWindow 的创建 / 广播全部由 bootstrap-electron
 * 注入,单测用 mock deps 直接驱动状态机。
 */

import type { BrowserWindow, WebContents } from 'electron';

import type { RsbWindowTabSnapshot } from '../../shared/rightSidebarWindow.js';
import type {
  SidebarTabReturnSnapshot,
  SidebarTabReturnedPayload,
  SidebarTabWindowAssignment,
  SidebarTabWindowAssignmentPayload,
  SidebarTabWindowOpenRequest,
  SidebarTabWindowTabRef,
  SidebarTabWindowsState,
} from '../../shared/sidebarTabWindow.js';
import {
  SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL,
  SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL,
  SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL,
  SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL,
} from '../../shared/sidebarTabWindow.js';
import type { SupportedLocale } from '../../shared/locale.js';

interface ControllerLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
  error(message: string, ...args: unknown[]): void;
}

export interface SidebarTabWindowsControllerDeps {
  /** 创建隐藏窗口;cascadeIndex = 当前已指派窗口数,工厂据此层叠位置。 */
  createWindow: (cascadeIndex: number) => BrowserWindow;
  /** 状态变化广播(所有窗口)。 */
  broadcastState: (state: SidebarTabWindowsState) => void;
  /** main → 某扇弹出窗口。 */
  sendToWindow: (win: BrowserWindow, channel: string, payload: unknown) => void;
  /** 页签回到侧边栏:只发给主窗 renderer。 */
  notifyTabReturned: (payload: SidebarTabReturnedPayload) => void;
  /** 拖出窗口松手弹窗:首次展示前把窗口放到松手点附近(缺省不动)。 */
  positionWindow?: (win: BrowserWindow, point: { x: number; y: number }) => void;
  isQuitting: () => boolean;
  log: ControllerLogger;
}

const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const SPARE_REPLENISH_DELAY_MS = 1_500;
const MAX_SPARE_RECOVERY_ATTEMPTS = 1;

export interface WindowSlot {
  win: BrowserWindow;
  /** null = 预热中的 spare,尚未承载任何页签。 */
  assignment: SidebarTabWindowAssignment | null;
  /** 随指派一次性交付的不可持久化会话快照。 */
  handoff: RsbWindowTabSnapshot | null;
  assignmentDelivered: boolean;
  rendererReady: boolean;
  presentationReady: boolean;
  visible: boolean;
  pendingOpen: boolean;
  /** 窗口里新建的不可持久化页签的内存态(tabId → 快照):崩溃 / 作废交回时带回,不让页签连窗口一起消失。 */
  adoptedSnapshots: Map<string, SidebarTabReturnSnapshot>;
  /** 首次展示前要套用的位置(拖出窗口松手点);展示后清空。 */
  pendingPosition: { x: number; y: number } | null;
  destroyingWindow: boolean;
  openTimeout: NodeJS.Timeout | null;
}

/**
 * 窗口 renderer 回传的页签快照只在「页签 id 与任务都对得上」时可信:来自被攻破或过期的 renderer 的
 * 快照不能借自己的页签 id 把内容塞进别的任务的缓存;全局页签(无任务)没有快照可言。
 */
function snapshotBoundTo(
  snapshot: SidebarTabReturnSnapshot | null,
  tabId: string,
  sessionId: string | null,
): SidebarTabReturnSnapshot | null {
  if (!snapshot || sessionId === null) return null;
  return snapshot.tab.id === tabId && snapshot.sessionId === sessionId ? snapshot : null;
}

export class SidebarTabWindowsController {
  /** windowId → 已指派的窗口。 */
  private readonly slots = new Map<string, WindowSlot>();
  /** tabId → windowId。 */
  private readonly tabToWindow = new Map<string, string>();
  private windowSeq = 0;
  private spare: WindowSlot | null = null;
  private spareRecoveryAttempts = 0;
  private replenishTimer: NodeJS.Timeout | null = null;
  private disposed = false;
  private locale: SupportedLocale | null = null;

  constructor(private readonly deps: SidebarTabWindowsControllerDeps) {}

  // ══════════════════════════════════════════════════════════════════════
  // 公共接口
  // ══════════════════════════════════════════════════════════════════════

  getState(): SidebarTabWindowsState {
    const out: SidebarTabWindowsState = {};
    for (const slot of this.slots.values()) {
      if (!slot.assignment || slot.win.isDestroyed()) continue;
      for (const tab of slot.assignment.tabs) {
        out[tab.tabId] = {
          windowId: slot.assignment.windowId,
          sessionId: tab.sessionId,
          open: slot.visible || slot.pendingOpen,
        };
      }
    }
    return out;
  }

  /** 后台预热一扇未指派的隐藏窗口。幂等:已有活着的 spare 时 no-op。 */
  prewarm(): void {
    if (this.disposed) return;
    if (this.spare && !this.spare.win.isDestroyed()) return;
    this.spare = this.createSlot();
  }

  setLocale(locale: SupportedLocale): void {
    this.locale = locale;
    for (const slot of this.allSlots()) {
      if (slot.win.isDestroyed()) continue;
      try {
        slot.win.webContents.send(SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL, locale);
      } catch {
        // Window may be tearing down.
      }
    }
  }

  /**
   * 把页签弹出到独立窗口。已弹出则只聚焦。指定 targetWindowId 且该窗口能接(同一
   * 任务或任一方是全局)→ 搬进去;否则新开一扇:优先消费预热的 spare,没有时冷建
   * (首份内容前不显示,超时展示 Loading 壳)。返回 false = 没能开出窗口(已销毁 / 创建失败)。
   */
  open(request: SidebarTabWindowOpenRequest): boolean {
    if (this.disposed) return false;
    if (this.tabToWindow.has(request.tabId)) {
      this.focus(request.tabId);
      return true;
    }
    const target = request.targetWindowId ? this.slots.get(request.targetWindowId) : undefined;
    if (target?.assignment && !target.win.isDestroyed() && this.canHost(target, request)) {
      this.addTabToSlot(target, request);
      this.deliverAssignment(target);
      this.broadcast();
      this.focus(request.tabId);
      this.deps.log.info('sidebar tab moved into window', {
        tabId: request.tabId,
        windowId: target.assignment.windowId,
      });
      return true;
    }
    const slot = this.takeSpare() ?? this.createSlot();
    // 窗口没建出来:告诉调用方失败,它才能不释放浏览器 webview / 不记窗口放置。
    if (!slot) return false;
    const windowId = `w${++this.windowSeq}`;
    slot.assignment = {
      windowId,
      sessionId: request.sessionId,
      tabs: [{ tabId: request.tabId, sessionId: request.sessionId }],
      context: request.context,
    };
    slot.handoff = request.handoff ?? null;
    slot.assignmentDelivered = false;
    slot.presentationReady = false;
    slot.pendingOpen = true;
    slot.pendingPosition = request.position ?? null;
    this.slots.set(windowId, slot);
    this.tabToWindow.set(request.tabId, windowId);
    if (slot.rendererReady) this.deliverAssignment(slot);
    this.scheduleOpenFallback(slot);
    this.broadcast();
    this.scheduleSpareReplenish();
    this.deps.log.info('sidebar tab window assigned', {
      windowId,
      tabId: request.tabId,
      sessionId: request.sessionId,
      prewarmed: slot.rendererReady,
    });
    return true;
  }

  /** 窗口能否接下这个页签:全局页签哪里都能去;任务页签只进同任务或尚无任务的窗口。 */
  private canHost(slot: WindowSlot, request: SidebarTabWindowOpenRequest): boolean {
    if (!slot.assignment) return false;
    if (request.sessionId === null || slot.assignment.sessionId === null) return true;
    return slot.assignment.sessionId === request.sessionId;
  }

  private addTabToSlot(slot: WindowSlot, request: SidebarTabWindowOpenRequest): void {
    if (!slot.assignment) return;
    if (slot.assignment.sessionId === null && request.sessionId !== null) {
      // 只有全局页签的窗口第一次接任务页签:接过任务上下文(与不可持久化会话的快照)。
      slot.assignment = {
        ...slot.assignment,
        sessionId: request.sessionId,
        context: request.context,
      };
    }
    // 搬入的页签带着主窗此刻最新的内存快照:总是换成最新一份(renderer 只导入新增页签的数据)。
    if (request.handoff) slot.handoff = request.handoff;
    slot.assignment.tabs = [
      ...slot.assignment.tabs,
      { tabId: request.tabId, sessionId: request.sessionId },
    ];
    this.tabToWindow.set(request.tabId, slot.assignment.windowId);
  }

  /** 从窗口里摘掉一个页签;返回它的引用(不在该窗口则 null)。不负责销毁 / 广播。 */
  private removeTabFromSlot(slot: WindowSlot, tabId: string): SidebarTabWindowTabRef | null {
    if (!slot.assignment) return null;
    const ref = slot.assignment.tabs.find((tab) => tab.tabId === tabId) ?? null;
    if (!ref) return null;
    slot.assignment.tabs = slot.assignment.tabs.filter((tab) => tab.tabId !== tabId);
    if (this.tabToWindow.get(tabId) === slot.assignment.windowId) this.tabToWindow.delete(tabId);
    slot.adoptedSnapshots.delete(tabId);
    // 最后一个任务页签离开后,窗口只剩全局页签:解除任务绑定,它才能再接别的任务的页签,
    // 窗内「+」也不会继续往旧任务里建页签。
    if (!slot.assignment.tabs.some((tab) => tab.sessionId !== null)) {
      slot.assignment = { ...slot.assignment, sessionId: null };
    }
    return ref;
  }

  private slotForTab(tabId: string): WindowSlot | null {
    const windowId = this.tabToWindow.get(tabId);
    const slot = windowId ? this.slots.get(windowId) : undefined;
    return slot ?? null;
  }

  /** 聚焦已弹出页签的窗口;未弹出 / 仍在等首份内容时 no-op。 */
  focus(tabId: string, options: { userInitiated?: boolean } = {}): void {
    const slot = this.slotForTab(tabId);
    if (!slot || slot.win.isDestroyed()) return;
    if (!slot.visible) return;
    this.deliverAssignment(slot, tabId);
    if (options.userInitiated === false) return;
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.show();
    slot.win.focus();
  }

  /**
   * 页签已在宿主 renderer 里关闭(agent close / 关闭全部 / guest 自关 / 窗口里关页签):
   * 从窗口里摘掉,不交回;窗口没有页签了就销毁。
   */
  closeForTab(tabId: string): void {
    const slot = this.slotForTab(tabId);
    if (!slot?.assignment) return;
    const ref = this.removeTabFromSlot(slot, tabId);
    if (slot.assignment.tabs.length === 0) {
      this.disposeSlot(slot);
    } else {
      this.deliverAssignment(slot);
    }
    // 先告知主窗「这个页签已被关掉」再广播状态:不可持久化会话的页签只存在于各 renderer
    // 内存里,没有数据库广播;窗口归属一清,主窗缓存里的旧副本会重新显示出来(复活)。
    if (ref && !this.deps.isQuitting()) {
      this.deps.notifyTabReturned({
        sessionId: ref.sessionId,
        tabId,
        snapshot: null,
        reason: 'closed',
      });
    }
    this.broadcast();
    this.deps.log.info('sidebar tab window dropped closed tab', { tabId });
  }

  /** 弹出窗口 renderer 请求把某个页签合并回侧边栏(按钮 / 右键菜单)。 */
  mergeBack(sender: WebContents, tabId: string, snapshot: SidebarTabReturnSnapshot | null): void {
    const slot = this.slotForSender(sender);
    if (!slot?.assignment) return;
    const ref = this.removeTabFromSlot(slot, tabId);
    if (!ref) return;
    if (slot.assignment.tabs.length === 0) {
      this.disposeSlot(slot);
    } else {
      this.deliverAssignment(slot);
    }
    if (!this.deps.isQuitting()) {
      this.deps.notifyTabReturned({
        sessionId: ref.sessionId,
        tabId,
        snapshot: snapshotBoundTo(snapshot, tabId, ref.sessionId),
        reason: 'merge',
      });
    }
    this.broadcast();
    this.deps.log.info('sidebar tab merged back', { tabId, withSnapshot: snapshot !== null });
  }

  /**
   * 主窗口把弹在窗口里的**全局页签**交回侧栏(左侧导航入口 / 详情页「在侧边栏中打开」「恢复默认
   * 位置」)。任务页签带内存态,必须由窗口自己合并回来(mergeBack),这里拒绝。
   */
  returnGlobalTab(tabId: string): boolean {
    const slot = this.slotForTab(tabId);
    if (!slot?.assignment) return false;
    const ref = slot.assignment.tabs.find((tab) => tab.tabId === tabId);
    if (!ref || ref.sessionId !== null) return false;
    this.removeTabFromSlot(slot, tabId);
    if (slot.assignment.tabs.length === 0) {
      this.disposeSlot(slot);
    } else {
      this.deliverAssignment(slot);
    }
    if (!this.deps.isQuitting()) {
      this.deps.notifyTabReturned({ sessionId: null, tabId, snapshot: null, reason: 'merge' });
    }
    this.broadcast();
    return true;
  }

  /** 弹出窗口 renderer 在自己里面新建了页签:归它承载。已在别处的页签忽略。 */
  adoptTab(
    sender: WebContents,
    tabId: string,
    sessionId: string | null,
    snapshot: SidebarTabReturnSnapshot | null = null,
  ): void {
    const slot = this.slotForSender(sender);
    if (!slot?.assignment || this.tabToWindow.has(tabId)) return;
    if (
      sessionId !== null &&
      slot.assignment.sessionId !== null &&
      slot.assignment.sessionId !== sessionId
    ) {
      this.deps.log.warn('adopt tab rejected: session mismatch', { tabId, sessionId });
      return;
    }
    if (slot.assignment.sessionId === null && sessionId !== null) {
      slot.assignment = { ...slot.assignment, sessionId };
    }
    slot.assignment.tabs = [...slot.assignment.tabs, { tabId, sessionId }];
    this.tabToWindow.set(tabId, slot.assignment.windowId);
    const bound = snapshotBoundTo(snapshot, tabId, sessionId);
    if (bound) slot.adoptedSnapshots.set(tabId, bound);
    this.deliverAssignment(slot);
    this.broadcast();
  }

  getAssignment(sender: WebContents): SidebarTabWindowAssignmentPayload | null {
    const slot = this.slotForSender(sender);
    if (!slot?.assignment) return null;
    slot.assignmentDelivered = true;
    return { ...slot.assignment, handoff: slot.handoff };
  }

  // ── 双阶段就绪 ──────────────────────────────────────────────────────

  markRendererReady(sender: WebContents): void {
    const slot = this.slotForSender(sender);
    if (!slot) return;
    slot.rendererReady = true;
    if (this.locale) {
      try {
        sender.send(SIDEBAR_TAB_WINDOW_LOCALE_CHANGED_CHANNEL, this.locale);
      } catch {
        // Renderer may be tearing down.
      }
    }
    if (slot.assignment && !slot.assignmentDelivered) this.deliverAssignment(slot);
  }

  markPresentationReady(sender: WebContents): void {
    const slot = this.slotForSender(sender);
    if (!slot?.assignment) return;
    slot.presentationReady = true;
    if (slot.pendingOpen) this.showAndFocus(slot);
  }

  /** 查找 sender 对应的 slot(含 spare);非本 controller 管理的窗口返回 null。 */
  slotForSender(sender: WebContents): WindowSlot | null {
    for (const slot of this.allSlots()) {
      if (!slot.win.isDestroyed() && slot.win.webContents === sender) return slot;
    }
    return null;
  }

  /** 页签所在弹出窗口的 WebContents;未弹出返回 null。tab-op / 命令按页签路由用。 */
  getWebContentsForTab(tabId: string): WebContents | null {
    const slot = this.slotForTab(tabId);
    if (!slot || slot.win.isDestroyed()) return null;
    return slot.win.webContents;
  }

  isTabPoppedOut(tabId: string): boolean {
    const slot = this.slotForTab(tabId);
    return Boolean(slot && !slot.win.isDestroyed());
  }

  /** 某窗口承载哪些页签(IPC 的 sender 归属校验用)。 */
  slotOwnsTab(slot: WindowSlot, tabId: string): boolean {
    return slot.assignment?.tabs.some((tab) => tab.tabId === tabId) ?? false;
  }

  // ── 生命周期 ────────────────────────────────────────────────────────

  /** 主窗口销毁时回收所有窗口(含 spare);主窗 renderer 已不在,不交回页签。 */
  destroyAllWindows(): void {
    this.clearReplenishTimer();
    for (const slot of this.allSlots()) {
      this.clearTimeouts(slot);
      slot.destroyingWindow = true;
      try {
        if (!slot.win.isDestroyed()) slot.win.destroy();
      } catch {
        /* already gone */
      }
    }
    this.slots.clear();
    this.tabToWindow.clear();
    this.spare = null;
    this.spareRecoveryAttempts = 0;
    // 让各 renderer 的「已弹出」镜像清空(owner 切换时页签留在原 renderer 缓存里,不再被隐藏)。
    if (!this.disposed) this.broadcast();
  }

  /** 应用退出时永久停止。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.destroyAllWindows();
  }

  // ══════════════════════════════════════════════════════════════════════
  // 内部:窗口创建与生命周期
  // ══════════════════════════════════════════════════════════════════════

  private allSlots(): WindowSlot[] {
    const out = [...this.slots.values()];
    if (this.spare) out.push(this.spare);
    return out;
  }

  private takeSpare(): WindowSlot | null {
    const spare = this.spare;
    this.spare = null;
    if (!spare || spare.win.isDestroyed()) return null;
    return spare;
  }

  private createSlot(): WindowSlot | null {
    let win: BrowserWindow;
    try {
      win = this.deps.createWindow(this.slots.size);
    } catch (error) {
      this.deps.log.warn('sidebar tab window creation failed', {
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
    const slot: WindowSlot = {
      win,
      assignment: null,
      handoff: null,
      assignmentDelivered: false,
      rendererReady: false,
      presentationReady: false,
      visible: false,
      pendingOpen: false,
      adoptedSnapshots: new Map(),
      pendingPosition: null,
      destroyingWindow: false,
      openTimeout: null,
    };

    win.on('close', (event) => {
      if (slot.destroyingWindow || this.disposed || this.deps.isQuitting()) return;
      // 原生关窗 = 关闭这个页签:交给 renderer 走 closeTab,页签消失后它再请求销毁窗口。
      event.preventDefault();
      this.requestCloseFromNative(slot);
    });
    win.on('show', () => this.onNativeVisibilityChanged(slot, true));
    win.on('hide', () => this.onNativeVisibilityChanged(slot, false));
    win.on('closed', () => this.onClosed(slot));
    win.webContents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) this.onRendererReloadStarted(slot);
    });
    win.webContents.on(
      'did-fail-load',
      (_event, errorCode, errorDescription, _validatedUrl, isMainFrame) => {
        if (isMainFrame && errorCode !== -3) {
          this.invalidateSlot(slot, `load failed (${errorCode}): ${errorDescription}`);
        }
      },
    );
    win.webContents.on('render-process-gone', (_event, details) => {
      this.invalidateSlot(slot, `renderer process gone: ${details.reason}`);
    });
    return slot;
  }

  private deliverAssignment(slot: WindowSlot, revealTabId?: string): void {
    if (!slot.assignment || slot.win.isDestroyed()) return;
    // 壳还没挂上:等 renderer-ready 时再送(它会主动 getAssignment / 收推送)。
    if (!slot.rendererReady) return;
    slot.assignmentDelivered = true;
    const payload: SidebarTabWindowAssignmentPayload = {
      ...slot.assignment,
      handoff: slot.handoff,
      ...(revealTabId ? { revealTabId } : {}),
    };
    this.deps.sendToWindow(slot.win, SIDEBAR_TAB_WINDOW_ASSIGNED_CHANNEL, payload);
  }

  private showAndFocus(slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
    slot.pendingOpen = false;
    if (slot.win.isDestroyed()) return;
    if (slot.pendingPosition) {
      const point = slot.pendingPosition;
      slot.pendingPosition = null;
      try {
        this.deps.positionWindow?.(slot.win, point);
      } catch (error) {
        this.deps.log.warn('position sidebar tab window failed', {
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (slot.win.isMinimized()) slot.win.restore();
    slot.win.show();
    slot.win.focus();
    slot.visible = true;
    this.deps.sendToWindow(slot.win, SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL, {
      visible: true,
    });
    this.broadcast();
  }

  private onNativeVisibilityChanged(slot: WindowSlot, visible: boolean): void {
    if (slot.win.isDestroyed() || slot.destroyingWindow || this.disposed) return;
    if (slot.visible === visible && !slot.pendingOpen) return;
    slot.visible = visible;
    if (visible) slot.pendingOpen = false;
    try {
      this.deps.sendToWindow(slot.win, SIDEBAR_TAB_WINDOW_VISIBILITY_CHANGED_CHANNEL, {
        visible,
      });
    } catch {
      // Native visibility can change while the renderer is tearing down.
    }
    if (slot.assignment) this.broadcast();
  }

  private requestCloseFromNative(slot: WindowSlot): void {
    if (!slot.assignment) {
      // spare 没有页签,直接丢弃。
      this.disposeSlot(slot);
      return;
    }
    if (slot.rendererReady) {
      // 每次关窗手势都转达:上一次可能被插件的确认框否决了。关闭流程(插件清理、
      // 确认拦截、落库)全在 renderer 里,页签消失后它再逐个调 close-for-tab。
      this.deps.sendToWindow(slot.win, SIDEBAR_TAB_WINDOW_CLOSE_REQUESTED_CHANNEL, undefined);
      return;
    }
    // renderer 还没挂上(冷开 / 重载中),无人能执行关闭流程:不丢数据,把页签全部交回侧边栏。
    this.finishSlot(slot, 'merge');
  }

  /** 整扇窗口结束:销毁窗口、把它承载的全部页签交回主窗、广播。 */
  private finishSlot(slot: WindowSlot, reason: SidebarTabReturnedPayload['reason']): void {
    const assignment = slot.assignment;
    this.disposeSlot(slot);
    if (assignment && !this.deps.isQuitting()) {
      // 先交回页签再广播状态:主窗 renderer 按序处理,刷新状态时页签尚未重新
      // 投影进侧边栏,避免先画旧状态再跳变。
      for (const tab of assignment.tabs) {
        this.deps.notifyTabReturned({
          sessionId: tab.sessionId,
          tabId: tab.tabId,
          snapshot: slot.adoptedSnapshots.get(tab.tabId) ?? null,
          reason,
        });
      }
    }
    this.broadcast();
    this.deps.log.info('sidebar tab window finished', {
      windowId: assignment?.windowId,
      tabIds: assignment?.tabs.map((tab) => tab.tabId),
      reason,
    });
  }

  private onClosed(slot: WindowSlot): void {
    this.clearTimeouts(slot);
    if (this.spare === slot) this.spare = null;
    const assignment = slot.assignment;
    if (assignment && this.slots.get(assignment.windowId) === slot) {
      this.slots.delete(assignment.windowId);
      for (const tab of assignment.tabs) {
        if (this.tabToWindow.get(tab.tabId) === assignment.windowId) {
          this.tabToWindow.delete(tab.tabId);
        }
      }
    }
    if (slot.destroyingWindow || this.deps.isQuitting()) return;
    // 不经 controller 的销毁(理论上不该发生):页签照样交回侧边栏,不让它消失。
    if (assignment) {
      for (const tab of assignment.tabs) {
        this.deps.notifyTabReturned({
          sessionId: tab.sessionId,
          tabId: tab.tabId,
          snapshot: null,
          reason: 'crash',
        });
      }
      this.broadcast();
    }
  }

  // ── 超时 ────────────────────────────────────────────────────────────

  private scheduleOpenFallback(slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
    slot.openTimeout = setTimeout(() => {
      slot.openTimeout = null;
      if (slot.win.isDestroyed() || !slot.pendingOpen) return;
      // 壳都没挂上:展示只会是空白窗口,按 §3.1 作废并让页签回到侧边栏。
      if (!slot.rendererReady) {
        this.invalidateSlot(slot, 'renderer readiness timed out');
        return;
      }
      if (!slot.visible) this.showAndFocus(slot);
    }, DEFAULT_OPEN_TIMEOUT_MS);
    slot.openTimeout.unref?.();
  }

  private clearOpenTimeout(slot: WindowSlot): void {
    if (!slot.openTimeout) return;
    clearTimeout(slot.openTimeout);
    slot.openTimeout = null;
  }

  private scheduleSpareReplenish(): void {
    if (this.disposed || this.replenishTimer) return;
    this.replenishTimer = setTimeout(() => {
      this.replenishTimer = null;
      this.prewarm();
    }, SPARE_REPLENISH_DELAY_MS);
    this.replenishTimer.unref?.();
  }

  private clearReplenishTimer(): void {
    if (!this.replenishTimer) return;
    clearTimeout(this.replenishTimer);
    this.replenishTimer = null;
  }

  // ── 崩溃恢复 ────────────────────────────────────────────────────────

  private onRendererReloadStarted(slot: WindowSlot): void {
    if (slot.win.isDestroyed()) return;
    slot.rendererReady = false;
    slot.presentationReady = false;
    slot.assignmentDelivered = false;
    // 可见窗口重载:等新 renderer 重新拿指派并提交首份内容;窗口本身不隐藏,
    // 避免闪烁。超时兜底与冷开一致。
    if (slot.assignment && (slot.visible || slot.pendingOpen)) {
      slot.pendingOpen = true;
      this.scheduleOpenFallback(slot);
    }
  }

  private invalidateSlot(slot: WindowSlot, reason: string): void {
    if (slot.win.isDestroyed()) return;
    if (!slot.assignment) {
      // spare 坏了:丢弃,最多自动补建一次;稳定后由下一次 open 的 replenish 重置。
      this.deps.log.warn('sidebar tab spare window invalidated', { reason });
      this.disposeSlot(slot);
      if (this.spareRecoveryAttempts >= MAX_SPARE_RECOVERY_ATTEMPTS) {
        this.deps.log.error('sidebar tab spare window recovery exhausted', { reason });
        return;
      }
      this.spareRecoveryAttempts += 1;
      this.scheduleSpareReplenish();
      return;
    }
    this.deps.log.warn('sidebar tab window invalidated, returning tabs to sidebar', {
      windowId: slot.assignment.windowId,
      tabIds: slot.assignment.tabs.map((tab) => tab.tabId),
      reason,
    });
    this.finishSlot(slot, 'crash');
  }

  // ── 销毁 ────────────────────────────────────────────────────────────

  private disposeSlot(slot: WindowSlot): void {
    this.clearTimeouts(slot);
    if (this.spare === slot) this.spare = null;
    const assignment = slot.assignment;
    if (assignment && this.slots.get(assignment.windowId) === slot) {
      this.slots.delete(assignment.windowId);
      for (const tab of assignment.tabs) {
        if (this.tabToWindow.get(tab.tabId) === assignment.windowId) {
          this.tabToWindow.delete(tab.tabId);
        }
      }
    }
    slot.destroyingWindow = true;
    try {
      if (!slot.win.isDestroyed()) slot.win.destroy();
    } catch {
      /* already gone */
    }
  }

  private clearTimeouts(slot: WindowSlot): void {
    this.clearOpenTimeout(slot);
  }

  private broadcast(): void {
    this.deps.broadcastState(this.getState());
  }
}
