/**
 * Pure state model for the "update all plugins" batch flow.
 *
 * Inputs: market items and installed Ghost manifests.
 * Outputs: serially consumable rows whose transitions the dialog renders;
 * no IPC here so the batch policy stays unit-testable.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import type { GhostManifest, GhostPermissionDiff } from '../../../../shared/ghost';
import type {
  PluginMarketItem,
  PluginMarketPackageReview,
} from '../../../../shared/pluginMarket';

/**
 * 批量更新策略(设计定稿):权限无变化的自动串行完成;权限有扩张的
 * 停在 `needs-confirm`,由用户逐项同意或跳过,绝不自动放行扩权。
 */
export type UpdateAllRowStatus =
  | 'pending'
  | 'installing'
  | 'done'
  | 'needs-confirm'
  | 'skipped'
  | 'failed';

export interface UpdateAllRow {
  pluginId: string;
  ghostId: string;
  name: string;
  fromVersion: string;
  toVersion: string;
  status: UpdateAllRowStatus;
  /** 目标 release(needs-confirm 时由运行器填充,approve 用它做并发防护)。 */
  releaseId?: string;
  /** 扩权详情(status 为 needs-confirm 时由运行器填充)。 */
  permissionDiff?: GhostPermissionDiff;
  /**
   * 待确认期间插件被外部路径(从文件更新等)换掉了权限基线:审阅过的
   * 权限差异已不对应现实,弹窗提示"需要重新审阅",按钮点下去先重算再决定。
   */
  staleReview?: boolean;
  /**
   * 审阅所依据的**已装 manifest 权限指纹**(不是版本号)。
   * `ghosts.update()` 允许同版本整体替换 manifest,所以版本号不是可靠的
   * 审阅基线——同版本换入不同权限声明时,旧 diff 与它换来的
   * allowPermissionExpansion 会把未审阅的新权限一并放行。批准前必须拿
   * 当前已装 manifest 重算指纹比对,不一致即作废重审。
   */
  reviewedBaseline?: string;
  /**
   * 非 server 源在审阅时取得的 manifest:主进程对这类来源强制要求安装时
   * 传回同一份 reviewed manifest,approve 必须原样带上,否则 INVALID_PARAMS。
   */
  expectedManifest?: GhostManifest;
  /** 实际下载包等待用户确认的权限事实。 */
  packageReview?: PluginMarketPackageReview;
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

/** 批次是否完全结束:连待确认的扩权行都已被用户处理。 */
export function isBatchFinished(rows: readonly UpdateAllRow[]): boolean {
  return isBatchSettled(rows) && rows.every((row) => row.status !== 'needs-confirm');
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
