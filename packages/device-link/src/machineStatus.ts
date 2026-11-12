/**
 * 一台电脑此刻的资源情况（docs/product-rules/cindy-machines.md）。只读探测：控制端在 list_machines 时问一次，
 * 不定时上报、不经 relay 持久化。老版本没有该 channel → CHANNEL_NOT_ALLOWED，控制端显示「需要更新」。
 * 这里只陈述事实，不判断「够不够用」：怎么用这些资源由 Agent 决定。
 */
export const MACHINE_STATUS_CHANNEL = 'maker:machine:status';

export interface MachineStatus {
  capturedAt: string;
  cpu: {
    logicalCores: number;
    /** 全部核心的忙碌比例；这次没采到为 null。 */
    busyPercent: number | null;
    /** Windows 没有 load average，为 null。 */
    loadAverage1m: number | null;
  };
  memory: {
    totalBytes: number;
    /** 不挤占其他程序还能用的内存（含可回收缓存）；读不到为 null，不用「空闲页」冒充。 */
    availableBytes: number | null;
  };
  /** 用户目录所在磁盘；读不到为 null。 */
  disk: { freeBytes: number; totalBytes: number } | null;
  /** 距离上次键鼠操作的秒数，用来判断有没有人正在用；读不到为 null。 */
  idleSeconds: number | null;
  onBattery: boolean | null;
  /** 这台电脑上正在运行一轮的任务数。 */
  runningTasks: number | null;
}

const count = (value: unknown): number | null =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
const record = (value: unknown): Record<string, unknown> | null =>
  value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;

/** 按字段容错：新版本多报的字段忽略，缺的字段是 null；必需的 CPU 与内存总量缺失才算无效。 */
export function parseMachineStatus(value: unknown): MachineStatus | null {
  const root = record(value);
  const cpu = record(root?.cpu);
  const memory = record(root?.memory);
  const logicalCores = count(cpu?.logicalCores);
  const totalBytes = count(memory?.totalBytes);
  if (!root || typeof root.capturedAt !== 'string' || !logicalCores || !totalBytes) return null;
  const disk = record(root.disk);
  const freeBytes = count(disk?.freeBytes);
  const diskTotal = count(disk?.totalBytes);
  return {
    capturedAt: root.capturedAt,
    cpu: { logicalCores, busyPercent: count(cpu?.busyPercent), loadAverage1m: count(cpu?.loadAverage1m) },
    memory: { totalBytes, availableBytes: count(memory?.availableBytes) },
    disk: freeBytes !== null && diskTotal !== null ? { freeBytes, totalBytes: diskTotal } : null,
    idleSeconds: count(root.idleSeconds),
    onBattery: typeof root.onBattery === 'boolean' ? root.onBattery : null,
    runningTasks: count(root.runningTasks),
  };
}
