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

    // ── 第一遍:解析每个 tab 的进程归属,按 PID 聚合豁免状态 ────────────────
    // Chromium 可能把 same-site 的多个 webview guest 合并进同一个 renderer 进程,
    // 此时 CPU / 内存指标是进程级的,pin / 前台却是 tab 级 —— 独立裁决会出现
    // "杀前台超限 tab 连带杀掉同进程的 pinned 兄弟"或"后台兄弟替前台的负载
    // 背锅被淘汰"。聚合规则:同 PID 内任一 tab pinned → 全体豁免;任一 tab
    // 前台 → 全体按前台策略;kill 每 tick 每 PID 至多一次(杀进程本来就会
    // 带走同进程所有 tab,重复调用无意义)。
    interface ResolvedTab {
      tabId: string;
      wc: GuestWebContentsLike;
      pid: number;
      metric: GuestProcessMetric;
    }
    const resolved: ResolvedTab[] = [];
    const pidPinned = new Set<number>();
    const pidForeground = new Set<number>();
    const pidTabs = new Map<number, string[]>();
    const liveTabIds = new Set<string>();
    for (const tab of tabs) {
      liveTabIds.add(tab.tabId);
      const wc = this.deps.lookupWebContents(tab.webContentsId);
      if (!wc || wc.isDestroyed()) {
        this.states.delete(tab.tabId);
        continue;
      }
      let pid: number;
      try {
        pid = wc.getOSProcessId();
      } catch {
        // guest 正处于 crash / attach 中间态,取不到 pid —— 本轮跳过。
        continue;
      }
      const metric = metricsByPid.get(pid);
      if (!metric) continue;
      if (this.deps.isPinned(tab.tabId)) pidPinned.add(pid);
      if (this.deps.isForeground(tab.tabId)) pidForeground.add(pid);
      const siblings = pidTabs.get(pid);
      if (siblings) {
        siblings.push(tab.tabId);
      } else {
        pidTabs.set(pid, [tab.tabId]);
      }
      resolved.push({ tabId: tab.tabId, wc, pid, metric });
    }

    // ── 第二遍:按聚合后的进程级状态执行阶梯 ─────────────────────────────
    const killedPids = new Set<number>();
    for (const tab of resolved) {
      if (pidPinned.has(tab.pid)) {
        // automation 驱动中的进程全豁免(含同进程兄弟 tab);连击计数一并清零,
        // pin 释放后重新累计,避免 automation 期间的高负载"记账"到用户头上。
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

      const cpu = tab.metric.cpu.percentCPUUsage;
      const memoryKB = tab.metric.memory.workingSetSize;
      const wc = tab.wc;

      if (pidForeground.has(tab.pid)) {
        state.bgCpuStrikes = 0;
        if (memoryKB >= FG_MEMORY_KILL_KB) {
          // 同 PID 每 tick 至多杀一次:forcefullyCrashRenderer 杀的是整个进程,
          // 同进程兄弟 tab 会一起收到 render-process-gone,重复调用无意义。
          if (killedPids.has(tab.pid)) {
            this.states.delete(tab.tabId);
            continue;
          }
          killedPids.add(tab.pid);
          this.deps.logger.warn(
            `resource watchdog killing foreground guest: tab=${tab.tabId} pid=${tab.pid} memoryKB=${memoryKB}`,
          );
          // 先 notice 后 kill:renderer 记下原因,随后的 render-process-gone
          // banner 才能显示"内存过高被终止"而不是笼统的"页面崩溃"。
          // notice 发给该进程的**所有** tab —— 杀进程会让同进程兄弟一起崩,
          // 每个 tab 的 banner 都该显示真实原因,而不是只有恰好先被遍历到的
          // 那个(遍历顺序可能先命中后台兄弟,导致可见 tab 拿不到原因)。
          for (const sibling of pidTabs.get(tab.pid) ?? [tab.tabId]) {
            this.deps.notifyKillNotice(sibling);
          }
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
 * 资源事件的目标 renderer 选择(纯函数,ipc.ts 消费):只认 guest 的实际宿主
 * (hostWebContents)—— 主窗内嵌 RSB / detached 子窗口 / 副窗口各自是独立
 * renderer,pool 与订阅只在宿主侧存在,送给别的 renderer 是空操作还会掩盖
 * 问题。宿主已销毁 / guest 已死的竞态下返回 null 放弃本轮投递:webview guest
 * 与宿主 renderer 同生共死,这种瞬态里 tab 要么正随宿主消亡,要么马上会被新
 * 宿主 re-report,下个采样周期自然重试,不做"回退到另一个窗口"的错投。
 */
export function pickResourceEventTarget<T extends { isDestroyed(): boolean }>(
  owner: T | null | undefined,
): T | null {
  return owner && !owner.isDestroyed() ? owner : null;
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

  /**
   * 归属校验版:仅当"声明该 tab 为前台的 sender"就是指定 renderer 时才算前台。
   * 看门狗消费时用它交叉验证 guest 的实际 hostWebContents —— 防止别的 renderer
   * 冒领前台让目标 tab 享受豁免(review:set-foreground 不做上报时校验是因为
   * 上报可能早于 dom-ready 的 registry report,硬拒会把可见 tab 永久打成后台)。
   */
  isForegroundFor(tabId: string, senderId: number): boolean {
    return this.bySender.get(senderId) === tabId;
  }
}
