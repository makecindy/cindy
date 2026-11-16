/**
 * process-monitor/memory-log —— 低频把各进程内存写进 main 日志(scope `memory-usage`)。
 *
 * 为什么要常驻:2026-11 翻个人版(dev)日志里的 30s 采样才发现,主进程自 10 月中旬起
 * 随使用持续上涨(每小时 40MB~1.2GB,最高 8.5GB),重启才回落;正式版此前没有任何
 * 同类记录,用户反馈「越用越卡」时日志答不出是哪个进程、涨的是 JS 堆还是 Buffer。
 *
 * 一行一个采样:主进程 `process.memoryUsage()` 细分 + `app.getAppMetrics()` 按进程类型
 * 分组(组内从大到小,单位 MB)。只写进程类型与数字——不写 webContents 标题、
 * serviceName、pid 或路径,所以 `memory-usage` 可以精确放行进日志上报白名单。
 *
 * 依赖全注入,不直接 import electron(engineering-conventions 规则 3)。
 */

/** app.getAppMetrics() 返回项里本模块用到的子集。memory.workingSetSize 单位是 KB。 */
export interface MemoryLogMetric {
  type: string;
  memory: { workingSetSize: number };
}

/** process.memoryUsage() 的子集,单位字节。 */
export interface MainMemoryUsage {
  rss: number;
  heapTotal: number;
  heapUsed: number;
  external: number;
  arrayBuffers: number;
}

const MB = 1024 * 1024;

const toMb = (bytes: number): number => Math.round(bytes / MB);

/** 进程表之外的计数类诊断(如存活的 MCP 会话数);只允许整数,保持本行可上报。 */
export type MemoryLogCounters = Readonly<Record<string, number>>;

/** 把一次采样格式化成一行日志正文。 */
export function formatMemorySample(
  main: MainMemoryUsage,
  metrics: readonly MemoryLogMetric[],
  counters: MemoryLogCounters = {},
): string {
  const byType = new Map<string, number[]>();
  let totalKb = 0;
  for (const m of metrics) {
    const kb = m.memory.workingSetSize;
    totalKb += kb;
    const list = byType.get(m.type) ?? [];
    list.push(Math.round(kb / 1024));
    byType.set(m.type, list);
  }
  const groups = [...byType]
    .map(([type, sizes]) => `${type}=${sizes.sort((a, b) => b - a).join(',')}`)
    .join(' ');
  return (
    `sample main{rss=${toMb(main.rss)} heapUsed=${toMb(main.heapUsed)} heapTotal=${toMb(main.heapTotal)} ` +
    `external=${toMb(main.external)} arrayBuffers=${toMb(main.arrayBuffers)}} ` +
    `processes=${metrics.length} total=${Math.round(totalKb / 1024)} ` +
    Object.entries(counters).map(([key, value]) => `${key}=${Math.round(value)} `).join('') +
    `${groups} (MB)`
  );
}

/** perf_hooks `monitorEventLoopDelay()` 返回的直方图里本模块用到的子集,单位纳秒。 */
export interface EventLoopDelayHistogram {
  percentile(percentile: number): number;
  readonly max: number;
  reset(): void;
  disable(): boolean;
}

const NS_PER_MS = 1_000_000;

/**
 * 主进程事件循环延迟计数:每次采样输出上一个采样窗口内的 p99 / 最大值(毫秒)后清零。
 *
 * 2026-11 个人版日志里远程请求偶发 50 秒、日志出现多段 5–11 秒空白,同时 DB worker 执行
 * 只有几毫秒、结果回到主线程却要等将近 1 秒——症状指向主线程被占,但没有任何指标能直接
 * 证明是哪一段时间、卡了多久。窗口最大值能回答「这 10 分钟里最长卡了多久」,p99 区分
 * 偶发长停顿和持续拥塞。只有整数毫秒,保持本行可上报。
 */
export function createEventLoopDelayCounters(histogram: EventLoopDelayHistogram): {
  counters(): MemoryLogCounters;
  stop(): void;
} {
  return {
    counters() {
      const p99 = histogram.percentile(99) / NS_PER_MS;
      const max = histogram.max / NS_PER_MS;
      histogram.reset();
      return { eventLoopDelayP99Ms: Math.round(p99), eventLoopDelayMaxMs: Math.round(max) };
    },
    stop() {
      histogram.disable();
    },
  };
}

export interface MemoryLogDeps {
  getMetrics(): readonly MemoryLogMetric[];
  memoryUsage(): MainMemoryUsage;
  counters?(): MemoryLogCounters;
  log: { info(message: string): void; warn(message: string, meta?: Record<string, unknown>): void };
  intervalMs: number;
}

/** 开始周期采样;返回停止函数。定时器 unref,不拖住退出。 */
export function startMemoryLog(deps: MemoryLogDeps): () => void {
  const timer = setInterval(() => {
    try {
      deps.log.info(formatMemorySample(deps.memoryUsage(), deps.getMetrics(), deps.counters?.()));
    } catch (err) {
      deps.log.warn('memory sample failed', { error: err instanceof Error ? err.message : String(err) });
    }
  }, deps.intervalMs);
  timer.unref?.();
  return () => clearInterval(timer);
}
