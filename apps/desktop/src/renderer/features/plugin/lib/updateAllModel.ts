/**
 * Pure state model for the "update all plugins" batch flow.
 *
 * Inputs: market items and installed Ghost manifests.
 * Outputs: serially consumable rows whose transitions the dialog renders;
 * no IPC here so the batch policy stays unit-testable.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { PluginMarketItem } from '../../../../shared/pluginMarket';

/**
 * 批量更新只维护执行进度。真实包由统一安装事务校验并落位，
 * 本模型不再保存目录 manifest、能力基线或另一套更新状态。
 */
export type UpdateAllRowStatus =
  | 'pending'
  | 'installing'
  | 'done'
  | 'skipped'
  | 'failed';

export interface UpdateAllRow {
  pluginId: string;
  ghostId: string;
  name: string;
  fromVersion: string;
  toVersion: string;
  status: UpdateAllRowStatus;
  /** status 为 failed 时的用户可读错误(已经过 i18n 映射)。 */
  errorText?: string;
}

/** 从市场快照萃取可更新行;顺序即执行顺序(与列表快照顺序一致,稳定)。 */
export function buildUpdateAllRows(
  marketItems: readonly PluginMarketItem[],
  installedVersionById: ReadonlyMap<string, string>,
): UpdateAllRow[] {
  return marketItems
    .filter((item) => item.installState === 'update-available')
    .map((item) => ({
      pluginId: item.pluginId,
      ghostId: item.ghostId,
      name: item.name,
      fromVersion: installedVersionById.get(item.ghostId) ?? '',
      toVersion: item.version,
      status: 'pending' as const,
    }));
}

/** 单行状态迁移(不可变更新,供 React state 直接消费)。 */
export function updateRow(
  rows: readonly UpdateAllRow[],
  pluginId: string,
  patch: Partial<UpdateAllRow>,
): UpdateAllRow[] {
  return rows.map((row) => (row.pluginId === pluginId ? { ...row, ...patch } : row));
}

/** 批次是否已收敛:没有任何行还会自行推进(pending/installing)。 */
export function isBatchSettled(rows: readonly UpdateAllRow[]): boolean {
  return rows.every((row) => row.status !== 'pending' && row.status !== 'installing');
}

/** 批次是否完全结束。 */
export function isBatchFinished(rows: readonly UpdateAllRow[]): boolean {
  return isBatchSettled(rows);
}

/** 完成摘要:成功 / 跳过 / 失败计数,供收尾 toast 使用。 */
export function batchSummary(rows: readonly UpdateAllRow[]): {
  done: number;
  skipped: number;
  failed: number;
} {
  let done = 0;
  let skipped = 0;
  let failed = 0;
  for (const row of rows) {
    if (row.status === 'done') done += 1;
    else if (row.status === 'skipped') skipped += 1;
    else if (row.status === 'failed') failed += 1;
  }
  return { done, skipped, failed };
}

/**
 * 「忽略本轮更新」的 localStorage 键:按数据归属分桶(云账号各自一桶、
 * 本地模式一桶)。插件清单与可更新集合本就随账号/模式不同,共用一个键会让
 * 账号 A 的「忽略本轮」静默压掉账号 B 的更新横幅。
 */
export function ignoredRoundStorageKey(
  mode: 'signed-out' | 'local' | 'cloud',
  dataOwnerId: string | null,
): string {
  return `cindy.pluginUpdates.ignoredRound.${mode}.${dataOwnerId ?? 'anonymous'}`;
}

/**
 * 「忽略本轮」的身份键:同一批可更新集合(id@目标版本)只被忽略一次,
 * 任何插件出现更新的版本变化都会产生新键,横幅随之重新出现。
 */
export function updateRoundKey(marketItems: readonly PluginMarketItem[]): string {
  return marketItems
    .filter((item) => item.installState === 'update-available')
    .map((item) => `${item.ghostId}@${item.version}`)
    .sort()
    .join('|');
}
