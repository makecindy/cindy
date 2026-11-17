/**
 * process-monitor/heap-sampling —— 主进程堆采样诊断(只在开发版、显式开启时运行)。
 *
 * 为什么需要它:`memory-usage` 只能说明主进程在涨,说不出涨的是谁。完整堆快照在 GB 级
 * 主进程上会冻结一两分钟、再吃掉同等内存,不能在用户正在用的实例上拍。V8 的采样式堆分析
 * (`HeapProfiler.startSampling`)开销小、可以常驻几小时,`getSamplingProfile` 只含仍存活
 * 的采样对象,按分配调用栈聚合——持续变大的分配位置就是泄漏点。
 *
 * 开启:开发版日志目录(`apps/desktop/logs/`)的 `log-config.json` 写
 * `"mainHeapSampling": true`,重启生效。每个周期把原始 profile 写进 `<logs>/heap-sampling/`
 * (`.heapprofile` 可在 Chrome DevTools 的 Memory 面板载入),并写一份按大小排序的摘要。
 * 文件只留本机:调用栈里有本机代码路径,`heap-sampling` 不在日志上报白名单里。
 */

import fs from 'node:fs';
import { Session } from 'node:inspector';
import path from 'node:path';

/** HeapProfiler.SamplingHeapProfile 里本模块用到的子集。 */
export interface SamplingHeapProfileNode {
  callFrame: { functionName: string; url: string; lineNumber: number; columnNumber: number };
  selfSize: number;
  children: SamplingHeapProfileNode[];
}

export interface SamplingHeapProfile {
  head: SamplingHeapProfileNode;
}

export interface HeapSiteTotal {
  site: string;
  bytes: number;
}

export interface HeapProfileSummary {
  totalBytes: number;
  /** 按分配发生的那一帧聚合。 */
  byAllocationFrame: HeapSiteTotal[];
  /** 归到调用栈上最近的一帧应用代码:叶子常是 JSON.parse / Array.push 这类通用帧。 */
  byAppFrame: HeapSiteTotal[];
}

const MB = 1024 * 1024;
const DEFAULT_SAMPLING_INTERVAL_BYTES = 256 * 1024;
const DEFAULT_KEEP_PROFILES = 48;
const SUMMARY_TOP = 40;

function siteOf(frame: SamplingHeapProfileNode['callFrame']): string {
  const name = frame.functionName || '(anonymous)';
  if (!frame.url) return name;
  return `${name} ${frame.url}:${frame.lineNumber + 1}:${frame.columnNumber + 1}`;
}

function top(totals: Map<string, number>, n: number): HeapSiteTotal[] {
  return [...totals]
    .map(([site, bytes]) => ({ site, bytes }))
    .sort((a, b) => b.bytes - a.bytes)
    .slice(0, n);
}

/** 主进程打包产物里的帧算应用代码;node_modules 外置依赖与 V8/Node 内部帧不算。 */
export function isMainBundleFrame(url: string): boolean {
  return url.includes('/.vite/build/') && !url.includes('/node_modules/');
}

export function summarizeSamplingProfile(
  profile: SamplingHeapProfile,
  isAppFrame: (url: string) => boolean = isMainBundleFrame,
  limit = SUMMARY_TOP,
): HeapProfileSummary {
  const byAllocation = new Map<string, number>();
  const byApp = new Map<string, number>();
  let totalBytes = 0;
  const stack: Array<{ node: SamplingHeapProfileNode; appSite: string | null }> = [
    { node: profile.head, appSite: null },
  ];
  while (stack.length > 0) {
    const { node, appSite: parentAppSite } = stack.pop()!;
    const site = siteOf(node.callFrame);
    const appSite = isAppFrame(node.callFrame.url) ? site : parentAppSite;
    if (node.selfSize > 0) {
      totalBytes += node.selfSize;
      byAllocation.set(site, (byAllocation.get(site) ?? 0) + node.selfSize);
      const key = appSite ?? '(no app frame)';
      byApp.set(key, (byApp.get(key) ?? 0) + node.selfSize);
    }
    for (const child of node.children) stack.push({ node: child, appSite });
  }
  return { totalBytes, byAllocationFrame: top(byAllocation, limit), byAppFrame: top(byApp, limit) };
}

export function formatHeapProfileSummary(summary: HeapProfileSummary): string {
  const lines = (rows: HeapSiteTotal[]) =>
    rows.map((row) => `${(row.bytes / MB).toFixed(1).padStart(9)} MB  ${row.site}`).join('\n');
  return (
    `sampled live heap: ${(summary.totalBytes / MB).toFixed(1)} MB\n\n` +
    `== by nearest app frame ==\n${lines(summary.byAppFrame)}\n\n` +
    `== by allocation frame ==\n${lines(summary.byAllocationFrame)}\n`
  );
}

/** 读开发版日志目录 `log-config.json` 的 `mainHeapSampling` 开关;缺失或损坏视为关闭。 */
export function readMainHeapSamplingFlag(logDir: string): boolean {
  try {
    const raw = fs.readFileSync(path.join(logDir, 'log-config.json'), 'utf-8');
    return (JSON.parse(raw) as { mainHeapSampling?: unknown }).mainHeapSampling === true;
  } catch {
    return false;
  }
}

interface HeapSamplingLogger {
  info(message: string, meta?: Record<string, unknown>): void;
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface MainHeapSamplingOptions {
  dir: string;
  intervalMs: number;
  log: HeapSamplingLogger;
  samplingIntervalBytes?: number;
  keepProfiles?: number;
}

function post<T>(session: Session, method: string, params: object = {}): Promise<T> {
  return new Promise((resolve, reject) =>
    session.post(method, params, (error, value) => (error ? reject(error) : resolve(value as T))),
  );
}

async function pruneOldProfiles(dir: string, keep: number): Promise<void> {
  const names = (await fs.promises.readdir(dir)).filter((n) => n.endsWith('.heapprofile')).sort();
  for (const name of names.slice(0, Math.max(0, names.length - keep))) {
    const stem = name.slice(0, -'.heapprofile'.length);
    await fs.promises.rm(path.join(dir, name), { force: true });
    await fs.promises.rm(path.join(dir, `${stem}.summary.txt`), { force: true });
  }
}

/** 开始采样并按周期落盘;返回停止函数。 */
export function startMainHeapSampling(options: MainHeapSamplingOptions): () => void {
  const session = new Session();
  let stopped = false;
  let dumping = false;
  session.connect();

  const dump = async (): Promise<void> => {
    if (stopped || dumping) return;
    dumping = true;
    try {
      const { profile } = await post<{ profile: SamplingHeapProfile }>(session, 'HeapProfiler.getSamplingProfile');
      const stem = `main-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      const summary = summarizeSamplingProfile(profile);
      await fs.promises.mkdir(options.dir, { recursive: true });
      await fs.promises.writeFile(path.join(options.dir, `${stem}.heapprofile`), JSON.stringify(profile));
      await fs.promises.writeFile(path.join(options.dir, `${stem}.summary.txt`), formatHeapProfileSummary(summary));
      await pruneOldProfiles(options.dir, options.keepProfiles ?? DEFAULT_KEEP_PROFILES);
      options.log.info('heap sampling profile written', {
        file: `${stem}.heapprofile`,
        sampledMb: Math.round(summary.totalBytes / MB),
        topAppFrame: summary.byAppFrame[0]?.site ?? null,
      });
    } catch (err) {
      options.log.warn('heap sampling dump failed', { error: err instanceof Error ? err.message : String(err) });
    } finally {
      dumping = false;
    }
  };

  void (async () => {
    try {
      await post(session, 'HeapProfiler.enable');
      await post(session, 'HeapProfiler.startSampling', {
        samplingInterval: options.samplingIntervalBytes ?? DEFAULT_SAMPLING_INTERVAL_BYTES,
      });
      options.log.info('main heap sampling started', { dir: options.dir, intervalMs: options.intervalMs });
    } catch (err) {
      options.log.warn('main heap sampling failed to start', { error: err instanceof Error ? err.message : String(err) });
    }
  })();

  const timer = setInterval(() => void dump(), options.intervalMs);
  timer.unref?.();

  return () => {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    session.post('HeapProfiler.stopSampling', () => session.disconnect());
  };
}
