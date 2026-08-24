/**
 * process-monitor/sampler —— 「资源用量」的采样合并逻辑(纯业务,依赖全注入,
 * 不直接 import electron —— main 侧业务逻辑默认带单测,模式照
 * rsb-browser-bridge/resource-watchdog.ts)。
 *
 * 两个数据源按 pid 合并:
 *  1. app.getAppMetrics():Electron 自家进程(Browser/Tab/GPU/Utility ——
 *     插件 Node 服务与 watcher-host 都是 Utility)。
 *  2. OS 级扫描(agent-scan):claude/codex/pi 的 agent 根进程 + 全局 PPID 图,
 *     每个根聚合整棵子树的 CPU / 内存(agent 干活的 bash / 测试 / MCP node
 *     都在子树里,只报根进程会严重低估)。
 *
 * OS 扫描比 getAppMetrics 贵得多(Windows 冷启 powershell 1.5s+),用独立的
 * 慢周期缓存:超龄才重扫,in-flight 共享,快 tick 之间复用上一次快照。
 * Windows 的 CPU% 没有现成值,由两次快照的累计 CPU 时间差分得出(首个快照
 * 报 0,第二个 tick 起有值)。
 */

import type {
  ProcessMonitorSample,
  ProcessUsageEntry,
  ProcessUsageKind,
} from '../../shared/processMonitor.js';
import {
  collectDescendantPids,
  type MonitoredAgentKind,
  type OsProcessRow,
  type OsProcessSnapshot,
} from './agent-scan.js';
import type { AgentProcessRegistration } from './codex-process-registry.js';

/** app.getAppMetrics() 返回项的最小子集。memory.workingSetSize 单位是 KB。 */
export interface ChromiumProcessMetric {
  pid: number;
  type: string;
  serviceName?: string;
  name?: string;
  cpu: { percentCPUUsage: number };
  memory: { workingSetSize: number };
}

interface SamplerLogger {
  warn(message: string, meta?: Record<string, unknown>): void;
}

export interface ProcessMonitorSamplerDeps {
  /** app.getAppMetrics() —— 每次 sample 调一次,percentCPUUsage 即两次调用间均值。 */
  getMetrics(): ChromiumProcessMetric[];
  scanOsProcesses(): Promise<OsProcessSnapshot>;
  /** pid → renderer 展示标签(webContents 标题);查不到返回 null。 */
  describeRendererProcess(pid: number): string | null;
  classify(cmdLineLower: string): MonitoredAgentKind | null;
  /** 本地根进程的 spawn-generation 登记；未知时返回 null，并按不可终止处理。 */
  resolveAgentProcessRegistration?(pid: number): AgentProcessRegistration | null;
  selfPid: number;
  log: SamplerLogger;
  /** OS 扫描的最小间隔;快 tick 之间复用缓存。 */
  osScanIntervalMs?: number;
  /** Windows 首帧先返回 Chromium 指标，OS 扫描在后台刷新后由下一 tick 合并。 */
  deferOsScan?: boolean;
  /** 注入时钟(测试用;生产缺省 Date.now)。 */
  now?: () => number;
}

/** OS 扫描缓存周期。5s 在「agent 树数据新鲜度」与「powershell 开销」间取平衡。 */
export const OS_SCAN_INTERVAL_MS = 5_000;

const AGENT_KIND_TO_USAGE_KIND: Record<MonitoredAgentKind, ProcessUsageKind> = {
  claude: 'agent-claude',
  codex: 'agent-codex',
  pi: 'agent-pi',
};

export interface ProcessMonitorSampler {
  sample(): Promise<ProcessMonitorSample>;
}

export function createProcessMonitorSampler(
  deps: ProcessMonitorSamplerDeps,
): ProcessMonitorSampler {
  const osScanIntervalMs = deps.osScanIntervalMs ?? OS_SCAN_INTERVAL_MS;
  const now = deps.now ?? Date.now;

  let cachedSnapshot: OsProcessSnapshot = { rows: [], childrenByParent: new Map() };
  let cachedAtMs = Number.NEGATIVE_INFINITY;
  let scanInFlight: Promise<void> | null = null;
  /** Windows CPU 差分账本:pid → 上一次**扫描**的累计 CPU 时间与时刻。 */
  const prevCpuTimes = new Map<
    number,
    { cpuTimeMs: number; atMs: number; startIdentity: string | null }
  >();
  /**
   * 扫描刷新时一次算好的 CPU%(仅 Windows 差分路径)。差分必须在扫描粒度做:
   * 若放在每个快 tick 上,复用缓存快照时会拿扫描周期(5s)的 CPU 增量去除以
   * tick 周期(2s)的墙钟窗口,百分比被高估 2.5 倍。
   */
  const computedCpuPercentByPid = new Map<number, number>();

  function onSnapshotRefreshed(snapshot: OsProcessSnapshot, atMs: number): void {
    cachedSnapshot = snapshot;
    cachedAtMs = atMs;
    const alive = new Set<number>();
    for (const row of snapshot.rows) {
      alive.add(row.pid);
      if (row.cpuTimeMs == null) continue;
      const prev = prevCpuTimes.get(row.pid);
      prevCpuTimes.set(row.pid, {
        cpuTimeMs: row.cpuTimeMs,
        atMs,
        startIdentity: row.startIdentity,
      });
      const percent =
        prev &&
        prev.startIdentity === row.startIdentity &&
        atMs > prev.atMs &&
        row.cpuTimeMs > prev.cpuTimeMs
          ? ((row.cpuTimeMs - prev.cpuTimeMs) / (atMs - prev.atMs)) * 100
          : 0;
      computedCpuPercentByPid.set(row.pid, percent);
    }
    // 账本剪枝:退出的进程不永久占内存(pid 复用时也不会拿到陈旧差分基线)。
    for (const pid of [...prevCpuTimes.keys()]) {
      if (!alive.has(pid)) {
        prevCpuTimes.delete(pid);
        computedCpuPercentByPid.delete(pid);
      }
    }
  }

  async function refreshSnapshotIfStale(): Promise<void> {
    if (now() - cachedAtMs < osScanIntervalMs) return;
    if (!scanInFlight) {
      scanInFlight = deps
        .scanOsProcesses()
        .then((snapshot) => {
          onSnapshotRefreshed(snapshot, now());
        })
        .catch((err) => {
          // 扫描失败降级为「本轮无 agent 条目」,Chromium 部分照常。缓存时间戳
          // 也推进,避免每个快 tick 都重试昂贵的失败扫描。
          onSnapshotRefreshed({ rows: [], childrenByParent: new Map() }, now());
          deps.log.warn('process monitor os scan failed', {
            error: err instanceof Error ? err.message : String(err),
          });
        })
        .finally(() => {
          scanInFlight = null;
        });
    }
    await scanInFlight;
  }

  /** 单进程 CPU%:POSIX 直接用 ps 值;Windows 用扫描粒度的差分(首个快照 0)。 */
  function rowCpuPercent(row: OsProcessRow): number {
    if (row.cpuPercent != null) return row.cpuPercent;
    return computedCpuPercentByPid.get(row.pid) ?? 0;
  }

  /** Windows 控制台宿主只是系统辅助进程，不应被用户误读成另一个 Agent 实例。 */
  function isOsHelperProcess(row: OsProcessRow): boolean {
    return /(?:^|[\\/])conhost\.exe(?:\s|$)/i.test(row.cmdLineLower);
  }

  function collectAgentEntries(): ProcessUsageEntry[] {
    const { rows, childrenByParent } = cachedSnapshot;
    const rowByPid = new Map(rows.map((r) => [r.pid, r]));
    const entries: ProcessUsageEntry[] = [];
    for (const row of rows) {
      if (row.ppid !== deps.selfPid) continue;
      const kind = deps.classify(row.cmdLineLower);
      if (!kind) continue;
      const registration = deps.resolveAgentProcessRegistration?.(row.pid) ?? null;
      const registrationMatchesKind = registration?.kind === kind;
      const registeredRole = registrationMatchesKind ? registration.role : null;
      const agentRole = kind === 'codex' ? registeredRole : null;
      let cpuPercent = 0;
      let memoryKb = 0;
      let processCount = 0;
      for (const pid of collectDescendantPids(row.pid, childrenByParent)) {
        const member = rowByPid.get(pid);
        if (!member) continue;
        cpuPercent += rowCpuPercent(member);
        memoryKb += member.memoryKb;
        if (!isOsHelperProcess(member)) processCount += 1;
      }
      const terminable =
        row.startIdentity != null && registrationMatchesKind && registeredRole === 'task-host';
      entries.push({
        pid: row.pid,
        kind: AGENT_KIND_TO_USAGE_KIND[kind],
        label: null,
        cpuPercent,
        memoryKb,
        processCount,
        // 终止授权使用每次实际 spawn 的随机 generation，而不是秒级 POSIX lstart。
        terminable,
        ...(terminable && registration ? { processInstanceId: registration.instanceId } : {}),
        ...(agentRole ? { agentRole } : {}),
      });
    }
    return entries;
  }

  function chromiumKind(type: string): ProcessUsageKind {
    switch (type) {
      case 'Browser':
        return 'main';
      case 'Tab':
        return 'renderer';
      case 'GPU':
        return 'gpu';
      default:
        return 'utility';
    }
  }

  function collectChromiumEntries(agentPids: Set<number>): ProcessUsageEntry[] {
    const entries: ProcessUsageEntry[] = [];
    for (const metric of deps.getMetrics()) {
      // 理论上 Chromium 进程不会出现在 agent 子树里;真撞了以 agent 聚合为准,
      // 避免同一进程被计两遍。
      if (agentPids.has(metric.pid)) continue;
      const kind = chromiumKind(metric.type);
      let label: string | null = null;
      if (kind === 'renderer') {
        label = deps.describeRendererProcess(metric.pid);
      } else if (kind === 'utility') {
        label = metric.serviceName || metric.name || null;
      }
      entries.push({
        pid: metric.pid,
        kind,
        label,
        cpuPercent: metric.cpu?.percentCPUUsage ?? 0,
        memoryKb: metric.memory?.workingSetSize ?? 0,
        processCount: 1,
        terminable: false,
      });
    }
    return entries;
  }

  return {
    async sample(): Promise<ProcessMonitorSample> {
      const refresh = refreshSnapshotIfStale();
      if (deps.deferOsScan) void refresh;
      else await refresh;
      const atMs = now();
      const agentEntries = collectAgentEntries();
      const agentPids = new Set<number>();
      for (const entry of agentEntries) {
        for (const pid of collectDescendantPids(entry.pid, cachedSnapshot.childrenByParent)) {
          agentPids.add(pid);
        }
      }
      return {
        capturedAtMs: atMs,
        entries: [...collectChromiumEntries(agentPids), ...agentEntries],
      };
    },
  };
}
