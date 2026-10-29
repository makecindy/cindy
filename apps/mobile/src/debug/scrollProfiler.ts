/**
 * DEV-only 滚动帧率测量(临时,profiling 结束后删)。
 * 固定速度(px/帧)驱动列表滚动,模拟真实 fling 的匀速位移;用 requestAnimationFrame 时间戳测
 * 「JS 线程帧间隔」:若某帧的挂载/协调把 JS 线程占住 >16.7ms,下一次 rAF 就被推迟 —— 帧间隔即
 * JS 线程真实帧时。跳过前若干 warmup 帧(首帧跳到起点会一次挂载一批,不代表稳态)。
 * 输出 avg / p50 / p95 / p99 / max + jank 帧计数,给三嫌疑(重 mount / 大树 / WebView)定序。
 */
export interface FrameStats {
  label: string;
  frames: number;
  durationMs: number;
  avgMs: number;
  p50: number;
  p95: number;
  p99: number;
  maxMs: number;
  jank32: number; // 帧间隔 > 32ms(掉 ≥1 帧 @60fps)
  jank50: number; // 帧间隔 > 50ms(明显卡顿)
  fps: number; // 有效 fps = frames / duration
}

function pct(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length));
  return Math.round(sorted[idx] * 10) / 10;
}

function summarize(label: string, intervals: number[], durationMs: number): FrameStats {
  const sorted = [...intervals].sort((a, b) => a - b);
  const sum = intervals.reduce((a, b) => a + b, 0);
  return {
    label,
    frames: intervals.length,
    durationMs: Math.round(durationMs),
    avgMs: intervals.length ? Math.round((sum / intervals.length) * 10) / 10 : 0,
    p50: pct(sorted, 50),
    p95: pct(sorted, 95),
    p99: pct(sorted, 99),
    maxMs: sorted.length ? Math.round(sorted[sorted.length - 1] * 10) / 10 : 0,
    jank32: intervals.filter((x) => x > 32).length,
    jank50: intervals.filter((x) => x > 50).length,
    fps: durationMs > 0 ? Math.round((intervals.length / durationMs) * 1000 * 10) / 10 : 0,
  };
}

/**
 * 从 fromY 以固定速度(pxPerFrame,向 toY 方向)滚动,每帧推进一小段并记录帧间隔。
 * scrollTo 用 animated:false(自己控制匀速推进,精确测 JS 帧时)。
 * warmup:跳过前 N 帧(首帧跳到 fromY 会一次挂载一批,不算稳态)。
 * 返回取消函数；调用后停止滚动，也不发布未完成的测量。
 */
export function runScrollSweep(opts: {
  label: string;
  fromY: number;
  toY: number;
  pxPerFrame: number;
  scrollTo: (y: number) => void;
  onDone: (stats: FrameStats) => void;
  warmup?: number;
  maxFrames?: number;
}): () => void {
  const { label, fromY, toY, pxPerFrame, scrollTo, onDone } = opts;
  const warmup = opts.warmup ?? 3;
  const maxFrames = opts.maxFrames ?? 400;
  const dir = toY >= fromY ? 1 : -1;
  const step = Math.abs(pxPerFrame) * dir;
  const intervals: number[] = [];
  let y = fromY;
  let lastTs = 0;
  let frameIdx = 0;
  let measureStartTs = 0;
  let cancelled = false;
  let frame: ReturnType<typeof requestAnimationFrame>;

  const tick = (ts: number) => {
    if (cancelled) return;
    if (lastTs === 0) {
      lastTs = ts;
      scrollTo(y);
      frame = requestAnimationFrame(tick);
      return;
    }
    const dt = ts - lastTs;
    lastTs = ts;
    frameIdx += 1;
    // 跳过 warmup 帧后才开始记录(并记稳态起点时间)。
    if (frameIdx > warmup) {
      if (measureStartTs === 0) measureStartTs = ts - dt;
      intervals.push(dt);
    }
    y += step;
    const reachedEnd = dir < 0 ? y <= toY : y >= toY;
    if (reachedEnd || frameIdx >= maxFrames + warmup) {
      onDone(summarize(label, intervals, ts - (measureStartTs || ts)));
      return;
    }
    scrollTo(y);
    frame = requestAnimationFrame(tick);
  };
  frame = requestAnimationFrame(tick);
  return () => {
    cancelled = true;
    cancelAnimationFrame(frame);
  };
}
