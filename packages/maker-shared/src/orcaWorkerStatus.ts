/**
 * main / renderer 共用的 worker 状态枚举与"占用槽位"判定。
 *
 * renderer 与 main 创建前检查共用这里的判定，不再各自手写状态集合。
 * 数据库原子预留另以 `sessions.status = 'active'` 判断是否占槽，确保终态 Worker
 * 归档前仍计数；若未来新增不占槽状态，需要同时更新此处与两份预留 SQL。
 *
 * 必须保持 renderer-safe: 不允许 import 任何 electron / drizzle / better-sqlite3,
 * 否则 renderer bundle 会把它们拖进来。
 */

export type OrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error';

/** 当前所有合法 Worker 状态在 session 归档前都占用软/硬上限槽位。 */
export const ACTIVE_WORKER_STATUSES = [
  'idle',
  'running',
  'done',
  'error',
] as const satisfies readonly OrcaWorkerStatus[];

/** UI 展示层的"运行中"计数——只有正在干活的 worker 才算。 */
export function isRunningWorkerStatus(status: OrcaWorkerStatus): boolean {
  return status === 'running';
}

/** 是否占槽位；这里的 active 指 team/session 未归档，不等同于正在运行。 */
export function isActiveWorkerStatus(status: OrcaWorkerStatus): boolean {
  return (ACTIVE_WORKER_STATUSES as readonly OrcaWorkerStatus[]).includes(status);
}
