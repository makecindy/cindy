/**
 * GhostOverlayCursorStream —— overlay 浮窗光标流的节拍器(main 侧,依赖注入可测)。
 *
 * 30Hz(约 33ms)周期把鼠标屏幕坐标推送给每个「已订阅且可见」的 ghost:
 *   - subscribe / unsubscribe / setVisible 三态驱动;
 *   - 无订阅或全部不可见时停止定时器(不空转);
 *   - 定时器 unref,不阻止进程退出;dispose 清表停表。
 *
 * 真实接线(Task 7):getCursorScreenPoint = screen.getCursorScreenPoint,
 * send 走 overlay cursor IPC;controller 的 onVisibilityChanged 钩子接 setVisible。
 */

export const GHOST_OVERLAY_CURSOR_STREAM_INTERVAL_MS = 33;

export interface GhostOverlayCursorStreamDeps {
  /** 当前鼠标屏幕坐标(真实实现由 Task 7 接线为 screen.getCursorScreenPoint())。 */
  getCursorScreenPoint: () => { x: number; y: number };
  /** 向指定 ghost 推送一帧光标。 */
  send: (ghostId: string, payload: { type: 'overlay-cursor'; x: number; y: number }) => void;
  /** 单调时钟(ms),建议 performance.now();兜底 30Hz 上限,同一 33ms 窗口只推一帧。 */
  now: () => number;
}

export class GhostOverlayCursorStream {
  /** ghostId → 是否可见;键存在即「已订阅」。新订阅默认不可见(fail closed)。 */
  private readonly subscriptions = new Map<string, boolean>();
  private timer: ReturnType<typeof setInterval> | null = null;
  /** 上一帧实际推送的时间戳,配合 now() 兜底 30Hz 上限。 */
  private lastPushAt = Number.NEGATIVE_INFINITY;
  private disposed = false;

  constructor(private readonly deps: GhostOverlayCursorStreamDeps) {}

  /** 订阅指定 ghost 的光标流(幂等);新订阅默认不可见,等 setVisible(true) 后才推送。 */
  subscribe(ghostId: string): void {
    if (this.disposed || this.subscriptions.has(ghostId)) return;
    this.subscriptions.set(ghostId, false);
    this.syncTimer();
  }

  /** 退订指定 ghost;退订后不再推送,最后一个可见订阅消失时停表。 */
  unsubscribe(ghostId: string): void {
    if (this.subscriptions.delete(ghostId)) this.syncTimer();
  }

  /**
   * 宿主(controller)在 show/hide/unmount 时同步可见性;
   * 未订阅的 ghost 忽略,所有订阅都不可见时停表。
   */
  setVisible(ghostId: string, visible: boolean): void {
    if (this.disposed || !this.subscriptions.has(ghostId)) return;
    if (this.subscriptions.get(ghostId) === visible) return;
    this.subscriptions.set(ghostId, visible);
    this.syncTimer();
  }

  /** 清表停表(幂等);此后不再推送。 */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.subscriptions.clear();
    this.stopTimer();
  }

  /** 定时器只在「至少存在一个已订阅且可见的 ghost」时运行,不空转。 */
  private syncTimer(): void {
    const shouldRun = this.hasVisibleSubscription();
    if (shouldRun && this.timer === null) this.startTimer();
    else if (!shouldRun && this.timer !== null) this.stopTimer();
  }

  private hasVisibleSubscription(): boolean {
    for (const visible of this.subscriptions.values()) {
      if (visible) return true;
    }
    return false;
  }

  private startTimer(): void {
    // 重置上一帧时间戳:hide→show 重启后首帧立即推送,不残留旧节拍造成约 66ms 延迟。
    this.lastPushAt = Number.NEGATIVE_INFINITY;
    this.timer = setInterval(() => this.tick(), GHOST_OVERLAY_CURSOR_STREAM_INTERVAL_MS);
    // 不阻止进程退出:光标流不是进程存活的理由。
    this.timer.unref?.();
  }

  private stopTimer(): void {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  private tick(): void {
    if (this.disposed) return;
    const now = this.deps.now();
    // 兜底 30Hz 上限:即便 setInterval 抖动提前触发,同一 33ms 窗口内只推一帧。
    if (now - this.lastPushAt < GHOST_OVERLAY_CURSOR_STREAM_INTERVAL_MS) return;
    this.lastPushAt = now;
    const { x, y } = this.deps.getCursorScreenPoint();
    for (const [ghostId, visible] of this.subscriptions) {
      if (visible) this.deps.send(ghostId, { type: 'overlay-cursor', x, y });
    }
  }
}
