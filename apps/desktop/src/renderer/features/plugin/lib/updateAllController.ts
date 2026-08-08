/**
 * Window-level controller for the "update all plugins" batch flow.
 *
 * The controller owns only batch progress and serial execution. Permission
 * review belongs to the Main-owned real-package transaction; no catalog
 * manifest or parallel approval state is retained here.
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
import { pluginMarketErrorKey } from './pluginMarketErrorKey';
import {
  batchSummary,
  buildUpdateAllRows,
  isBatchFinished,
  updateRow,
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

export function startUpdateAllBatch(marketUpdates: readonly PluginMarketItem[]): void {
  if (state.running) return;
  const installedVersionById = new Map(
    readInstalledGhostsSnapshot().map((ghost) => [ghost.manifest.id, ghost.manifest.version]),
  );
  finishToastShown = false;
  batchOwner = getDataOwnerGeneration();
  const generation = beginGeneration();
  emit({ rows: buildUpdateAllRows(marketUpdates, installedVersionById), running: false });
  void runQueue(generation);
}

/** 串行执行，每个 install() 自己在 Main 中下载、确认并提交同一真实包。 */
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
      try {
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
        const installed = readInstalledGhostsSnapshot().find(
          (ghost) => ghost.manifest.id === next.ghostId,
        );
        if (!installed) {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        patchRow(generation, next.pluginId, {
          fromVersion: installed.manifest.version,
          toVersion: detail.version,
        });
        const result = await window.electronAPI.pluginMarket.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
        });
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        patchRow(generation, next.pluginId, {
          status: result.cancelled ? 'skipped' : 'done',
        });
      } catch (error) {
        if (generation !== batchGeneration) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        patchRow(generation, next.pluginId, {
          status: 'failed',
          errorText: i18n.t(pluginMarketErrorKey(error)),
        });
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
  const installedById = new Map(
    readInstalledGhostsSnapshot().map((ghost) => [ghost.manifest.id, ghost.manifest]),
  );
  let rows = state.rows;
  let changed = false;
  for (const row of state.rows) {
    if (row.status !== 'pending') continue;
    const installed = installedById.get(row.ghostId);
    if (!installed) {
      rows = updateRow(rows, row.pluginId, { status: 'skipped' });
      changed = true;
    } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
      rows = updateRow(rows, row.pluginId, { status: 'done' });
      changed = true;
    } else if (installed.version !== row.fromVersion) {
      rows = updateRow(rows, row.pluginId, { fromVersion: installed.version });
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
