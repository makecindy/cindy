/**
 * WindowManualDragController — 手动窗口拖拽控制器
 * ---------------------------------------------------------------------------
 * 为什么存在:Electron 的 `-webkit-app-region: drag` 区域会吞掉全部 DOM 鼠标
 * 事件(macOS/Windows 实测连 mousedown 都收不到,见 electron#37789),因此
 * "既能拖窗、又能响应双击"的元素(如会话标题文字)无法用原生拖拽区实现。
 * 解法:元素标 no-drag 保留 DOM 事件,renderer 检测到按住移动后通过 IPC 请求
 * 本控制器接管——用光标屏幕坐标驱动 win.setBounds() 跟随,直到 renderer
 * 发 stop(pointerup / pointercancel)。Windows 优先由原生 bridge 在物理坐标下
 * 使用 SWP_NOSIZE 移窗,避免分数 DPI 下宽高反复取整。
 *
 * 逻辑:start 时记录"光标 → 窗口原点"的偏移,之后按固定间隔把窗口移动到
 * (cursor - offset)。窗口 y 以光标所在显示器的 workArea.y 为上限 clamp,
 * 模仿 macOS 原生"标题栏不能拖进菜单栏"的行为(Windows 上 workArea.y 通常
 * 为 0,clamp 是 no-op,不改变平台习惯)。
 *
 * 防御:
 *  - 同一时刻只有一个活动拖拽,重复 start 会先停掉旧的;
 *  - 窗口销毁 / 超过保险丝时长(renderer 崩溃等导致 stop 永远不来)自动停,
 *    避免窗口永久"粘"在光标上;
 *  - 最大化 / 全屏窗口忽略 start(原生拖拽区在这两种状态同样不响应拖动)。
 *
 * 依赖注入 ScreenLike / DragWindowLike 而非直接 import electron,单测无需
 * mock electron 模块。
 */

interface Point {
  x: number;
  y: number;
}

/** electron.screen 的最小子集。 */
export interface ScreenLike {
  getCursorScreenPoint(): Point;
  getDisplayNearestPoint(point: Point): { workArea: { x: number; y: number; width: number; height: number } };
}

/** BrowserWindow 的最小子集。 */
export interface DragWindowLike {
  isDestroyed(): boolean;
  isMaximized(): boolean;
  isFullScreen(): boolean;
  getNativeWindowHandle?(): Buffer;
  getBounds(): { x: number; y: number; width: number; height: number };
  setBounds(bounds: { x: number; y: number; width: number; height: number }, animate?: boolean): void;
}

/** 跟随间隔:~60fps,和原生拖拽手感对齐。 */
const FOLLOW_INTERVAL_MS = 16;

/** 保险丝:单次拖拽最长持续时间,超过视为 stop 丢失,强制结束。 */
const MAX_DRAG_DURATION_MS = 30_000;

export class WindowManualDragController {
  private timer: ReturnType<typeof setInterval> | null = null;

  /** 当前拖拽所属窗口:stop 按 owner 校验,防跨窗口误停(多完整窗口场景)。 */
  private activeWin: DragWindowLike | null = null;

  constructor(
    private readonly screen: ScreenLike,
    private readonly intervalMs: number = FOLLOW_INTERVAL_MS,
    private readonly maxDurationMs: number = MAX_DRAG_DURATION_MS,
    private readonly nativeFollower?: (win: DragWindowLike) => (() => boolean) | null,
    private readonly onNativeStartError?: (error: unknown) => void,
  ) {}

  /**
   * 开始拖拽跟随。窗口最大化 / 全屏 / 已销毁时忽略。
   *
   * 他窗拖拽进行中的 start 一律拒绝:用户只有一个物理指针,窗口 B 拖拽
   * 进行中到达的窗口 A start 必然是陈旧 / 延迟消息,不允许它抢占(停掉 B、
   * 让 A 粘附光标)。同窗口重复 start 则视为新手势正常重启(前一次 stop
   * 丢失时的自愈路径);极端的跨窗 stop 丢失由保险丝兜底。
   */
  start(win: DragWindowLike): void {
    if (this.timer !== null && this.activeWin !== null && this.activeWin !== win) return;
    this.stop();
    if (win.isDestroyed() || win.isMaximized() || win.isFullScreen()) return;

    let followNative: (() => boolean) | null | undefined;
    try {
      followNative = this.nativeFollower?.(win);
    } catch (error: unknown) {
      // Offset reads may fail during a Windows desktop switch. Keep the drag
      // available through the fixed-bounds fallback instead of escaping IPC.
      this.onNativeStartError?.(error);
    }
    const cursor = this.screen.getCursorScreenPoint();
    const { x: winX, y: winY, width, height } = win.getBounds();
    const offsetX = cursor.x - winX;
    const offsetY = cursor.y - winY;
    const startedAt = Date.now();
    let lastX = winX;
    let lastY = winY;

    this.activeWin = win;
    this.timer = setInterval(() => {
      if (win.isDestroyed() || Date.now() - startedAt > this.maxDurationMs) {
        this.stop();
        return;
      }
      if (followNative) {
        if (!followNative()) this.stop();
        return;
      }
      const point = this.screen.getCursorScreenPoint();
      const minY = this.screen.getDisplayNearestPoint(point).workArea.y;
      const x = point.x - offsetX;
      const y = Math.max(minY, point.y - offsetY);
      if (x === lastX && y === lastY) return;
      // On Windows fractional DPI, setPosition round-trips the current native
      // size through integer DIPs and can enlarge it on every tick (#7860).
      // Keep the gesture's starting size instead of feeding that rounding back.
      win.setBounds({ x, y, width, height }, false);
      lastX = x;
      lastY = y;
    }, this.intervalMs);
  }

  /**
   * 结束拖拽跟随。未在拖拽时为 no-op。
   *
   * @param requester 发起 stop 的窗口。传入时按 owner 校验:「在新窗口打开」
   * 会有多个完整窗口共享本单例,窗口 A 遗留 / 延迟到达的 stop 不能清掉窗口 B
   * 正在进行的拖拽,非当前拖拽 owner 的 stop 一律忽略。省略(内部自停 /
   * 替换旧拖拽)则无条件停止。
   */
  stop(requester?: DragWindowLike): void {
    if (requester !== undefined && this.activeWin !== null && requester !== this.activeWin) {
      return;
    }
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.activeWin = null;
  }

  /** 当前是否处于拖拽跟随中(供测试断言)。 */
  isDragging(): boolean {
    return this.timer !== null;
  }
}
