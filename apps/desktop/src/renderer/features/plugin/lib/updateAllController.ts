/**
 * Window-level controller for the "update all plugins" batch flow.
 *
 * The controller owns only batch progress and serial execution. Main validates
 * every downloaded package against its market manifest (or, for GitHub Release
 * rows, the release asset digest of its own fresh check) before atomic placement.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import type { PluginMarketItem } from '../../../../shared/pluginMarket';
import { ghostInstallApprovalToken } from '../../../../shared/ghost';
import type { GithubPluginReleaseResult } from '../../../../shared/githubPluginRelease';
import { extractIpcError } from '@/utils/ipcError';
import { deliveryNamespaceFields, findInstalledGhostByInstanceId } from '../../../../shared/pluginIdentity';
import { githubReleaseTarget, runGithubReleaseUpdate } from './githubReleaseUpdates';
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import { findInstalledGhostForMarketItem } from './pluginMarketPresentation';
import {
  beginPluginInstallProgress,
  endPluginInstallProgress,
  failPluginInstallProgress,
  succeedPluginInstallProgress,
} from './pluginInstallProgress';
import {
  batchSummary,
  buildUpdateAllRows,
  isBatchFinished,
  updateRow,
  type NamedGithubReleaseUpdate,
  type UpdateAllRow,
} from './updateAllModel';

export interface UpdateAllBatchState {
  rows: UpdateAllRow[] | null;
  running: boolean;
}

interface UpdateAllBatchHooks {
  /** 页面存在时刷新市场；页面卸载期间缺席，重新进入会全量刷新。 */
  refreshMarket?: () => Promise<void>;
}

let state: UpdateAllBatchState = { rows: null, running: false };
let finishToastShown = false;
let hooks: UpdateAllBatchHooks = {};
let batchOwner: DataOwnerGeneration | null = null;
let batchGeneration = 0;
const listeners = new Set<() => void>();

function emit(next: UpdateAllBatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

function beginGeneration(): number {
  batchGeneration += 1;
  return batchGeneration;
}

function batchOwnerCurrent(): boolean {
  return batchOwner !== null && isDataOwnerGenerationCurrent(batchOwner);
}

function isGenerationCurrent(generation: number): boolean {
  return generation === batchGeneration && batchOwnerCurrent();
}

function patchRow(generation: number, pluginId: string, patch: Partial<UpdateAllRow>): void {
  if (!isGenerationCurrent(generation) || state.rows === null) return;
  emit({ ...state, rows: updateRow(state.rows, pluginId, patch) });
}

function voidStaleBatch(): void {
  batchOwner = null;
  beginGeneration();
  finishToastShown = true;
  emit({ rows: null, running: false });
}

export function subscribeUpdateAllBatch(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getUpdateAllBatchState(): UpdateAllBatchState {
  return state;
}

export function setUpdateAllBatchHooks(next: UpdateAllBatchHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

async function refreshMarketIfMounted(): Promise<void> {
  try {
    await hooks.refreshMarket?.();
  } catch {
    // 批次结果不依赖刷新成功；重新进入页面会再取完整快照。
  }
}

function maybeFinishToast(): void {
  const rows = state.rows;
  if (!rows || rows.length === 0 || !isBatchFinished(rows) || finishToastShown) return;
  finishToastShown = true;
  const summary = batchSummary(rows);
  toast.success(
    i18n.t('settings.ghosts.updateAll.doneToast', {
      done: summary.done,
      rest: summary.skipped + summary.failed,
    }),
  );
}

export function startUpdateAllBatch(
  marketUpdates: readonly PluginMarketItem[],
  githubUpdates: readonly NamedGithubReleaseUpdate[] = [],
): void {
  if (state.running) return;
  const installed = readInstalledGhostsSnapshot();
  const installedVersionByPluginId = new Map(
    marketUpdates.map((item) => [
      item.pluginId,
      findInstalledGhostForMarketItem(installed, item)?.manifest.version ?? '',
    ]),
  );
  finishToastShown = false;
  batchOwner = getDataOwnerGeneration();
  const generation = beginGeneration();
  emit({
    rows: buildUpdateAllRows(marketUpdates, installedVersionByPluginId, githubUpdates),
    running: false,
  });
  void runQueue(generation);
}

/** Main 对 GitHub 更新的回答 → 行结果。done 时 `updated` 区分真的装了新包还是已是最新。 */
export function githubRowOutcome(
  reply: GithubPluginReleaseResult,
): { status: 'done'; updated: boolean; version?: string } | { status: 'failed'; errorText: string } {
  if (reply.status === 'updated') return { status: 'done', updated: true, version: reply.version };
  if (reply.status === 'current') return { status: 'done', updated: false };
  // A changed asset refreshes the offer. This batch did not install the version the user saw.
  const copy = reply.status === 'available' ? 'unavailable' : reply.status;
  return { status: 'failed', errorText: i18n.t(`settings.ghosts.detail.githubRelease.${copy}`) };
}

/** GitHub 行：按当前已装实例重新取目标，交给 Main 复核 release 后下载、校验并落位。 */
async function installGithubRow(row: UpdateAllRow): Promise<GithubPluginReleaseResult | 'gone'> {
  const installed = row.instanceId
    ? findInstalledGhostByInstanceId(readInstalledGhostsSnapshot(), row.instanceId)
    : undefined;
  const target = installed ? githubReleaseTarget(installed) : null;
  if (!target || row.assetId === undefined) return 'gone';
  return runGithubReleaseUpdate({ target, assetId: row.assetId, progressKey: row.pluginId });
}

/** 串行执行，每个 install() 自己在 Main 中下载、校验并提交同一真实包。 */
async function runQueue(generation: number): Promise<void> {
  if (state.running || !isGenerationCurrent(generation)) return;
  emit({ ...state, running: true });
  try {
    for (;;) {
      if (generation !== batchGeneration) return;
      if (!batchOwnerCurrent()) {
        voidStaleBatch();
        return;
      }
      const next = state.rows?.find((row) => row.status === 'pending');
      if (!next) break;
      patchRow(generation, next.pluginId, { status: 'installing' });
      beginPluginInstallProgress(next.pluginId);
      try {
        if (next.source === 'github') {
          const reply = await installGithubRow(next);
          if (generation !== batchGeneration) return;
          if (!batchOwnerCurrent()) {
            voidStaleBatch();
            return;
          }
          if (reply === 'gone') {
            patchRow(generation, next.pluginId, { status: 'skipped' });
            continue;
          }
          const outcome = githubRowOutcome(reply);
          if (outcome.status === 'failed') {
            failPluginInstallProgress(next.pluginId, outcome.errorText);
            patchRow(generation, next.pluginId, outcome);
            continue;
          }
          patchRow(generation, next.pluginId, {
            status: 'done',
            ...(outcome.version ? { toVersion: outcome.version } : {}),
          });
          if (outcome.updated) succeedPluginInstallProgress(next.pluginId);
          continue;
        }
        const detail = await window.electronAPI.pluginMarket.detail(next.pluginId);
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        if (detail.installState === 'installed') {
          patchRow(generation, next.pluginId, { status: 'done' });
          continue;
        }
        if (detail.installState !== 'update-available') {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const installed = findInstalledGhostForMarketItem(
          readInstalledGhostsSnapshot(),
          detail,
        );
        if (!installed) {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        patchRow(generation, next.pluginId, {
          fromVersion: installed.manifest.version,
          toVersion: detail.version,
        });
        await window.electronAPI.pluginMarket.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
          expectedManifest: detail.manifest,
          expectedInstalledApproval: ghostInstallApprovalToken(installed.approval),
          allowSourceReplacement: false,
        });
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        patchRow(generation, next.pluginId, { status: 'done' });
        succeedPluginInstallProgress(next.pluginId);
      } catch (error) {
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        // 新版本权限变多时 Main 会逐个弹确认；用户取消只跳过这一个插件。
        if (extractIpcError(error)?.code === 'MUTATION_CANCELLED') {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const errorText = i18n.t(pluginMarketErrorKey(error));
        failPluginInstallProgress(next.pluginId, errorText);
        patchRow(generation, next.pluginId, { status: 'failed', errorText });
      } finally {
        endPluginInstallProgress(next.pluginId);
      }
    }
  } finally {
    await settleBatchTail(generation);
  }
}

async function settleBatchTail(generation: number): Promise<void> {
  if (generation !== batchGeneration) return;
  await refreshMarketIfMounted();
  if (generation !== batchGeneration) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  if (state.running) emit({ ...state, running: false });
  maybeFinishToast();
}

/** 页面外的已装/市场事实变化只用于收束尚未开始的行。 */
export function reconcileUpdateAllBatch(marketItems: readonly PluginMarketItem[] = []): void {
  if (state.rows === null) return;
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const installStateByPluginId = new Map(
    marketItems.map((item) => [item.pluginId, item.installState]),
  );
  const marketByPluginId = new Map(marketItems.map((item) => [item.pluginId, item]));
  const installedGhosts = readInstalledGhostsSnapshot();
  let rows = state.rows;
  let changed = false;
  for (const row of state.rows) {
    if (row.status !== 'pending') continue;
    if (row.source === 'github') {
      // GitHub 行不在市场快照里：只按已装实例收束——没了就跳过，已到目标版本就算完成。
      const ghost = row.instanceId
        ? findInstalledGhostByInstanceId(installedGhosts, row.instanceId)
        : undefined;
      const target = ghost ? githubReleaseTarget(ghost) : null;
      if (!target) {
        rows = updateRow(rows, row.pluginId, { status: 'skipped' });
        changed = true;
      } else if (target.installedVersion === row.toVersion) {
        rows = updateRow(rows, row.pluginId, { status: 'done' });
        changed = true;
      } else if (target.installedVersion !== row.fromVersion) {
        rows = updateRow(rows, row.pluginId, { fromVersion: target.installedVersion });
        changed = true;
      }
      continue;
    }
    const installed = findInstalledGhostForMarketItem(
      installedGhosts,
      marketByPluginId.get(row.pluginId) ?? {
        ghostId: row.ghostId,
        ...deliveryNamespaceFields(row),
      },
    );
    if (!installed) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
      rows = updateRow(rows, row.pluginId, { status: 'done' });
      changed = true;
    } else if (
      installStateByPluginId.has(row.pluginId) &&
      installStateByPluginId.get(row.pluginId) !== 'update-available'
    ) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installed.manifest.version !== row.fromVersion) {
      rows = updateRow(rows, row.pluginId, { fromVersion: installed.manifest.version });
      changed = true;
    }
  }
  if (changed) emit({ ...state, rows });
}

/** 仅测试用：清空模块级批次状态。 */
export function __resetUpdateAllBatchForTest(): void {
  state = { rows: null, running: false };
  finishToastShown = false;
  hooks = {};
  batchOwner = null;
  beginGeneration();
  listeners.clear();
}
