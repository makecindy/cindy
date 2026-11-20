/**
 * Pure state model for the "update all plugins" batch flow.
 *
 * Inputs: market items and installed versions keyed by market pluginId, plus the
 * GitHub Release updates found for local plugins that declare `githubRelease`.
 * Outputs: serially consumable rows whose transitions the dialog renders;
 * no IPC here so the batch policy stays unit-testable.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { deliveryNamespaceFields } from '../../../../shared/pluginIdentity';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import type { GithubReleaseUpdate } from './githubReleaseUpdates';

/** A GitHub Release update as the banner and batch show it. */
export type NamedGithubReleaseUpdate = GithubReleaseUpdate & { name: string };

/** Row and progress identity of a GitHub Release update; never collides with a market pluginId. */
export function githubUpdateKey(instanceId: string): string {
  return `github:${instanceId}`;
}

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
  /** 行身份与进度键：市场行是市场 pluginId；GitHub 行是 `githubUpdateKey(instanceId)`。 */
  pluginId: string;
  ghostId: string;
  /** Present when the market row carried a known namespace; omitted stays legacy. */
  namespace?: string | null;
  name: string;
  fromVersion: string;
  toVersion: string;
  status: UpdateAllRowStatus;
  /** status 为 failed 时的用户可读错误(已经过 i18n 映射)。 */
  errorText?: string;
  /** 更新来源；缺省为插件市场。GitHub 行带已装实例与检查到的附件。 */
  source?: 'github';
  instanceId?: string;
  assetId?: number;
}

/**
 * 从市场快照与 GitHub 检查结果萃取可更新行;顺序即执行顺序:市场行按列表快照顺序在前,
 * GitHub 行随后(两者都稳定)。
 */
export function buildUpdateAllRows(
  marketItems: readonly PluginMarketItem[],
  installedVersionByPluginId: ReadonlyMap<string, string>,
  githubUpdates: readonly NamedGithubReleaseUpdate[] = [],
): UpdateAllRow[] {
  const marketRows = marketItems
    .filter((item) => item.installState === 'update-available')
    .map((item) => ({
      pluginId: item.pluginId,
      ghostId: item.ghostId,
      ...deliveryNamespaceFields(item),
      name: item.name,
      fromVersion: installedVersionByPluginId.get(item.pluginId) ?? '',
      toVersion: item.version,
      status: 'pending' as const,
    }));
  const githubRows = githubUpdates.map((update) => ({
    pluginId: githubUpdateKey(update.instanceId),
    ghostId: update.ghostId,
    name: update.name,
    fromVersion: update.fromVersion,
    toVersion: update.version,
    status: 'pending' as const,
    source: 'github' as const,
    instanceId: update.instanceId,
    assetId: update.assetId,
  }));
  return [...marketRows, ...githubRows];
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
 * 没有 GitHub 更新时键与只含市场时完全相同，已保存的「忽略本轮」继续有效。
 */
export function updateRoundKey(
  marketItems: readonly PluginMarketItem[],
  githubUpdates: readonly Pick<GithubReleaseUpdate, 'instanceId' | 'version'>[] = [],
): string {
  return [
    ...marketItems
      .filter((item) => item.installState === 'update-available')
      .map((item) => `${item.pluginId}@${item.version}`),
    ...githubUpdates.map((update) => `${githubUpdateKey(update.instanceId)}@${update.version}`),
  ]
    .sort()
    .join('|');
}
