/**
 * BrowserGuestResourceWatchdog —— RSB 浏览器 `<webview>` guest 的资源看门狗。
 *
 * 为什么需要它:guest 是独立进程,JS 死循环 / 泄漏不会阻塞主界面的 event loop,
 * 但会通过三条系统级路径拖垮整个 App:
 *   1. 系统内存压力(guest 吃到几个 GB → 全系统换页,主窗口整体卡顿);
 *   2. 共享 GPU 进程被打满(所有 surface 由同一 GPU 进程合成);
 *   3. 停车区的后台 webview 在 Chromium 眼里仍"可见",不吃后台降频,全速烧 CPU。
 * 对"高占用但不崩溃"的页面,唯一有效的手段是主动淘汰 / 主动终止(Chrome 的
 * out-of-memory tab kill 同理)。终止后的善后复用现成链路:forcefullyCrashRenderer
 * 触发 guest `render-process-gone` → renderer 的 crash banner + reload 恢复。
 *
 * 阶梯策略(阈值全部导出为常量,便于按线上数据调整):
 *   - 后台 & 内存 ≥ BG_MEMORY_EVICT_KB           → 淘汰(renderer pool.release;
 *     对用户等价于 LRU 淘汰,tab 保留,下次激活重新加载)
 *   - 后台 & CPU ≥ BG_CPU_PERCENT 连续 N 个采样   → 淘汰(正在发声的除外 ——
 *     用户后台放音乐 / 视频是合法场景)
 *   - 前台 & 内存 ≥ FG_MEMORY_KILL_KB            → 先发 kill-notice 再强杀,
 *     banner 显示"内存过高被终止"
 *   - 前台 & CPU ≥ FG_CPU_PERCENT 连续 N 个采样   → 只发 cpu-alert 提示,不自动杀
 *     (可能是用户在跑正经的重页面);告警后进入冷却,不反复骚扰
 *   - automation pinned 的 tab 全部豁免 —— agent 正在驱动的页面,杀了会让自动化
 *     拿到 destroyed webContents 中途失败;pin 的生命周期本来就短
 *
 * 依赖全部注入(metrics / webContents 查找 / 前台判定 / 通知动作),不直接 import
 * electron —— main 侧业务逻辑默认带单测(engineering-conventions 规则 3)。
 */

interface WatchdogLogger {
  info(message: string, ...args: unknown[]): void;
  warn(message: string, ...args: unknown[]): void;
}

/** app.getAppMetrics() 返回项的最小子集。memory.workingSetSize 单位是 KB。 */
export interface GuestProcessMetric {
  pid: number;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
}

/** 看门狗对 guest webContents 的最小依赖面(便于测试注入 fake)。 */
export interface GuestWebContentsLike {
  isDestroyed(): boolean;
  getOSProcessId(): number;
  isCurrentlyAudible(): boolean;
  forcefullyCrashRenderer(): void;
}

export interface ResourceWatchdogDeps {
  /** 当前注册的全部浏览器 tab(TabRegistry.listAll 的子集视图)。 */
  listTabs(): Array<{ tabId: string; webContentsId: number }>;
  /** tabId 是否被 automation pin(TabRegistry.isPinned)。 */
  isPinned(tabId: string): boolean;
  /** tabId 是否是某个 renderer 正在展示的前台 tab(ForegroundTabTracker)。 */
  isForeground(tabId: string): boolean;
  lookupWebContents(id: number): GuestWebContentsLike | null;
  /** app.getAppMetrics() —— 每次 tick 调一次,percentCPUUsage 即两次调用间的均值。 */
  getMetrics(): GuestProcessMetric[];
  /** 请 renderer 淘汰该后台 tab(main → renderer resource-event: evict-request)。 */
  notifyEvict(tabId: string): void;
  /** 通知 renderer "即将强杀"(kill-notice),banner 才能显示资源原因。 */
  notifyKillNotice(tabId: string): void;
  /** 前台持续高 CPU 提示(cpu-alert)。 */
  notifyCpuAlert(tabId: string, cpuPercent: number): void;
  logger: WatchdogLogger;
}

/** 采样周期。30s 在"及时止损"和"采样本身的开销 / 误报率"之间取平衡。 */
export const RESOURCE_WATCHDOG_INTERVAL_MS = 30_000;

/** 后台 guest 内存淘汰阈值(KB)= 1 GiB。淘汰对用户无感(等价 LRU),从严。 */
export const BG_MEMORY_EVICT_KB = 1024 * 1024;
/** 后台 guest 高 CPU 阈值(%,单核百分比)。 */
export const BG_CPU_PERCENT = 50;
/** 后台高 CPU 连续命中多少个采样后淘汰(2 分钟)。 */
export const BG_CPU_EVICT_STRIKES = 4;

/** 前台 guest 内存强杀阈值(KB)= 2 GiB。前台动作要保守,只拦真失控的。 */
export const FG_MEMORY_KILL_KB = 2 * 1024 * 1024;
/** 前台 guest 高 CPU 阈值(%)。 */
export const FG_CPU_PERCENT = 90;
/** 前台高 CPU 连续命中多少个采样后提示(2 分钟)。 */
export const FG_CPU_ALERT_STRIKES = 4;
/** cpu-alert 发出后的冷却 tick 数(5 分钟),避免反复弹提示。 */
export const FG_CPU_ALERT_COOLDOWN_TICKS = 10;

/** 单个 tab 的连击计数状态。tab 淘汰 / 被杀 / 注销后清除。 */
interface TabWatchState {
  bgCpuStrikes: number;
  fgCpuStrikes: number;
  alertCooldownTicks: number;
}

export class BrowserGuestResourceWatchdog {
  private readonly states = new Map<string, TabWatchState>();
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(private readonly deps: ResourceWatchdogDeps) {}

  start(intervalMs: number = RESOURCE_WATCHDOG_INTERVAL_MS): void {
    if (this.timer) return;
    this.timer = setInterval(() => this.tick(), intervalMs);
    // 采样定时器不该阻止进程退出(main 退出编排在 lifecycle.ts)。
    this.timer.unref?.();
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.states.clear();
  }

  /** 单次采样 + 阶梯裁决。导出为 public 供单测直接驱动(不用假时钟)。 */
  tick(): void {
    const tabs = this.deps.listTabs();
    if (tabs.length === 0) {
      this.states.clear();
      return;
    }

    let metricsByPid: Map<number, GuestProcessMetric>;
    try {
      metricsByPid = new Map(this.deps.getMetrics().map((m) => [m.pid, m]));
    } catch (err) {
      this.deps.logger.warn('resource watchdog metrics collection failed', err);
      return;
    }

    const liveTabIds = new Set<string>();
    for (const tab of tabs) {
      liveTabIds.add(tab.tabId);
      const wc = this.deps.lookupWebContents(tab.webContentsId);
      if (!wc || wc.isDestroyed()) {
        this.states.delete(tab.tabId);
        continue;
      }
      let metric: GuestProcessMetric | undefined;
      try {
        metric = metricsByPid.get(wc.getOSProcessId());
      } catch {
        // guest 正处于 crash / attach 中间态,取不到 pid —— 本轮跳过。
        continue;
      }
      if (!metric) continue;

      if (this.deps.isPinned(tab.tabId)) {
        // automation 驱动中的 tab 全豁免;连击计数一并清零,pin 释放后重新累计,
        // 避免 automation 期间的高负载"记账"到用户头上。
        this.states.delete(tab.tabId);
        continue;
      }

      const state = this.states.get(tab.tabId) ?? {
        bgCpuStrikes: 0,
        fgCpuStrikes: 0,
        alertCooldownTicks: 0,
      };
      this.states.set(tab.tabId, state);
      if (state.alertCooldownTicks > 0) state.alertCooldownTicks -= 1;

      const cpu = metric.cpu.percentCPUUsage;
      const memoryKB = metric.memory.workingSetSize;

      if (this.deps.isForeground(tab.tabId)) {
        state.bgCpuStrikes = 0;
        if (memoryKB >= FG_MEMORY_KILL_KB) {
          this.deps.logger.warn(
            `resource watchdog killing foreground guest: tab=${tab.tabId} memoryKB=${memoryKB}`,
          );
          // 先 notice 后 kill:renderer 记下原因,随后的 render-process-gone
          // banner 才能显示"内存过高被终止"而不是笼统的"页面崩溃"。
          this.deps.notifyKillNotice(tab.tabId);
          try {
            wc.forcefullyCrashRenderer();
          } catch (err) {
            this.deps.logger.warn('forcefullyCrashRenderer threw', err);
          }
          this.states.delete(tab.tabId);
          continue;
        }
        if (cpu >= FG_CPU_PERCENT) {
          state.fgCpuStrikes += 1;
          if (state.fgCpuStrikes >= FG_CPU_ALERT_STRIKES && state.alertCooldownTicks === 0) {
            this.deps.logger.info(
              `resource watchdog cpu alert: tab=${tab.tabId} cpu=${cpu.toFixed(0)}%`,
            );
            this.deps.notifyCpuAlert(tab.tabId, cpu);
            state.fgCpuStrikes = 0;
            state.alertCooldownTicks = FG_CPU_ALERT_COOLDOWN_TICKS;
          }
        } else {
          state.fgCpuStrikes = 0;
        }
        continue;
      }

      // ── 后台 ────────────────────────────────────────────────────────────
      state.fgCpuStrikes = 0;
      if (memoryKB >= BG_MEMORY_EVICT_KB) {
        this.deps.logger.info(
          `resource watchdog evicting background guest (memory): tab=${tab.tabId} memoryKB=${memoryKB}`,
        );
        this.deps.notifyEvict(tab.tabId);
        this.states.delete(tab.tabId);
        continue;
      }
      if (cpu >= BG_CPU_PERCENT) {
        // 正在发声的后台页面(音乐 / 视频)是用户的合法使用场景,CPU 规则放行;
        // 内存规则(上面)不豁免 —— 音频页也不该吃 1GB。
        let audible = false;
        try {
          audible = wc.isCurrentlyAudible();
        } catch {
          // 中间态取不到,按不发声处理。
        }
        if (audible) {
          state.bgCpuStrikes = 0;
          continue;
        }
        state.bgCpuStrikes += 1;
        if (state.bgCpuStrikes >= BG_CPU_EVICT_STRIKES) {
          this.deps.logger.info(
            `resource watchdog evicting background guest (cpu): tab=${tab.tabId} cpu=${cpu.toFixed(0)}%`,
          );
          this.deps.notifyEvict(tab.tabId);
          this.states.delete(tab.tabId);
        }
      } else {
        state.bgCpuStrikes = 0;
      }
    }

    // 已注销 tab 的残留状态清理(registry 淘汰 / 关 tab 后)。
    for (const tabId of [...this.states.keys()]) {
      if (!liveTabIds.has(tabId)) this.states.delete(tabId);
    }
  }
}

/**
 * 资源事件的目标 renderer 选择(纯函数,ipc.ts 消费):guest 的实际宿主
 * (hostWebContents)优先 —— 主窗内嵌 RSB / detached 子窗口 / 副窗口各自是
 * 独立 renderer,pool 与订阅只在宿主侧存在,送错 renderer 事件会被静默丢弃。
 * 宿主已销毁 / guest 已死的竞态下回退到全局 host,双方都不可用返回 null。
 */
export function pickResourceEventTarget<T extends { isDestroyed(): boolean }>(
  owner: T | null | undefined,
  fallback: T | null,
): T | null {
  const wc = owner && !owner.isDestroyed() ? owner : fallback;
  return wc && !wc.isDestroyed() ? wc : null;
}

/**
 * ForegroundTabTracker —— 记录"每个 renderer 当前展示哪个浏览器 tab"。
 *
 * renderer 通过 `set-foreground` 上报全量状态(tabId | null);多窗口(主窗内嵌
 * RSB + detached 侧边栏子窗口)各自上报,按 senderId 分槽。任何一个 renderer
 * 正在展示的 tab 都算前台。renderer 销毁时槽位由 ipc.ts 调 drop 清除。
 */
export class ForegroundTabTracker {
  private readonly bySender = new Map<number, string>();

  set(senderId: number, tabId: string | null): void {
    if (tabId === null) {
      this.bySender.delete(senderId);
    } else {
      this.bySender.set(senderId, tabId);
    }
  }

  drop(senderId: number): void {
    this.bySender.delete(senderId);
  }

  isForeground(tabId: string): boolean {
    for (const v of this.bySender.values()) {
      if (v === tabId) return true;
    }
    return false;
  }
}
