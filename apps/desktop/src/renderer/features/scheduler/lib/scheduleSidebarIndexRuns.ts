import type { Schedule, ScheduleRun } from '@cindy/maker-scheduler';

/** Sidebar 聚合索引用的轻量 run wire 形态，由 main 侧 SQLite 查询直接返回。 */
export interface ScheduleSidebarIndexRun {
  runId: string;
  scheduleId: string;
  scheduleName: string;
  scheduleStatus: Schedule['status'];
  scheduleSource?: Schedule['source'];
  nextFireAt?: number;
  workingDir?: string;
  projectConfigId?: string;
  sessionId?: string;
  status: ScheduleRun['status'];
  readAt?: number;
  firedAt?: number;
}

/**
 * 一次 invoke 返回的侧栏索引快照。
 *
 * `inflightRunIds` 是引擎内存里的权威 in-flight 集合,和 `runs` 取自同一次调用、天然
 * 一致。通知抑制标记的对账必须靠它区分「`runs` 里查不到某条 run」的两种含义:已结束并
 * 被清理,还是自删除场景下 run 行已随 schedule 级联删除、run 却仍在跑
 * (见 `scheduler.listInflightRunIds` 的注释)。
 */
export interface ScheduleSidebarIndexSnapshot {
  runs: ScheduleSidebarIndexRun[];
  inflightRunIds: string[];
}

export async function loadScheduleSidebarIndexSnapshot(): Promise<ScheduleSidebarIndexSnapshot> {
  // main 与 renderer 同包发布,不存在版本 skew,所以这里不做跨形态兼容 —— 形态不符就是
  // bug,应该暴露出来而不是静默降级成「没有 in-flight 信息」(那会让对账去误清仍在跑的
  // 自删除 run)。`?? []` 只兜 undefined。
  const raw = (await window.electronAPI.maker.schedule.listSidebarIndexRuns()) as
    | ScheduleSidebarIndexSnapshot
    | undefined;
  return { runs: raw?.runs ?? [], inflightRunIds: raw?.inflightRunIds ?? [] };
}

/** 只要 run 列表的调用方(侧栏卡片、未读计数等)继续用这个。 */
export async function loadScheduleSidebarIndexRuns(): Promise<ScheduleSidebarIndexRun[]> {
  return (await loadScheduleSidebarIndexSnapshot()).runs;
}
