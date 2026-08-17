/**
 * Window-level controller for the "update all plugins" batch flow.
 *
 * Inputs: the market update snapshot plus user approve/skip actions.
 * Outputs: a subscribable batch snapshot for the Plugin page and the
 * serial install IPC calls.
 *
 * 为什么在组件外:批次可以在用户关掉弹窗、离开 /plugins 后继续跑
 * (「后台继续」语义),待确认的扩权项也必须在回到插件页后仍然保留
 * 批准/跳过入口——状态生命周期必须长于页面组件,所以照
 * useInstalledGhosts 的先例做成模块级单例 store。真实包复核返回期间若
 * 已装权限基线漂移,保留目标 release 并退回可恢复的重新审阅状态。
 *
 * 来源隔离(#2043):批次只原位更新 `update-available` 的市场包;conflict /
 * 其它来源状态不在这里静默替换来源,install 一律 `allowSourceReplacement: false`。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 */

import { i18n } from '@/i18n';
import { toast } from '@/lib/toast';
import { extractIpcError } from '@/utils/ipcError';
import { readInstalledGhostsSnapshot } from '@/cindy-brain/useInstalledGhosts';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
  type DataOwnerGeneration,
} from '@/contexts/dataOwnerGeneration';
import {
  diffInstalledGhostPermissionItems,
  ghostInstallApprovalToken,
  ghostPermissionBaselineKey,
  type GhostManifest,
  type InstalledGhost,
} from '../../../../shared/ghost';
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
  /** null = 从未启动过批次;数组引用随每次行迁移变化(快照语义)。 */
  rows: UpdateAllRow[] | null;
  running: boolean;
}

interface UpdateAllBatchHooks {
  /** 批次推进后的市场快照刷新;页面卸载期间缺席,重新进页会全量刷新。 */
  refreshMarket?: () => Promise<void>;
}

let state: UpdateAllBatchState = { rows: null, running: false };
let finishToastShown = false;
let hooks: UpdateAllBatchHooks = {};
/** 批次启动时的账号世代:身份切换后旧批次整体作废,绝不跨账号安装。 */
let batchOwner: DataOwnerGeneration | null = null;
/**
 * 批次代际。每次启动新批次或作废旧批次都自增,异步流程在启动时捕获它,
 * 之后每个写入点都先核对——**光靠账号世代不够**:同一账号内旧批次被作废、
 * 新批次接管时账号没变,旧 runner 的迟到写入照样会污染新批次(把上一批的
 * 失败写进新批次、继续消费新批次的 pending 行、提前清掉新批次的 running)。
 * 代际失效的 runner 只能停下,不得改写、不得收尾、不得触发任何副作用。
 */
let batchGeneration = 0;
/**
 * 在途批准的串行队列,**按代际隔离**。
 *
 * 同一代际内必须排队而非并发:并发安装同一批次的多个 release 会互相踩市场
 * 刷新与已装清单快照,收尾也会被任一单项提前释放。
 *
 * 但队列不能全局共用一条链:账号/模式切换后新批次的批准会排在旧代际那个
 * 慢 install() 后面干等——代际校验只能在轮到执行时把旧项丢掉,解不掉前面的
 * 等待。各代际各排各的,新身份点批准立即开始;旧代际的项轮到时照样因代际
 * 失效而不执行安装。条目在该代际无在途时回收(见 releaseApproval)。
 */
const approvalQueueByGeneration = new Map<number, Promise<unknown>>();
/**
 * 在途批准计数**按代际分桶**。全局单计数不够:旧代际的在途项会把新批次的
 * 收尾计数拖住(减到 0 时代际已不匹配、跳过收尾,新批次就永远不释放 running)。
 * 每个代际只对自己的桶负责。
 */
const inflightByGeneration = new Map<number, number>();
const listeners = new Set<() => void>();

function retainApproval(generation: number): void {
  inflightByGeneration.set(generation, (inflightByGeneration.get(generation) ?? 0) + 1);
}

/** 归还一个在途名额;返回该代际是否已无在途(= 轮到收尾)。 */
function releaseApproval(generation: number): boolean {
  const next = (inflightByGeneration.get(generation) ?? 1) - 1;
  if (next <= 0) {
    inflightByGeneration.delete(generation);
    // 该代际不再有批准在途,它的队列链也没人接了——一并清掉,免得
    // 长会话里每换一次账号/批次都留下一条永不回收的 promise 链。
    approvalQueueByGeneration.delete(generation);
    return true;
  }
  inflightByGeneration.set(generation, next);
  return false;
}

function emit(next: UpdateAllBatchState): void {
  state = next;
  listeners.forEach((listener) => listener());
}

/** 开启新代际(旧代际的异步流程随即失效),返回新代际号。 */
function beginGeneration(): number {
  batchGeneration += 1;
  return batchGeneration;
}

/** 该代际是否仍是当前批次(代际未被接管 + 账号未切换)。 */
function isGenerationCurrent(generation: number): boolean {
  return (
    batchGeneration === generation &&
    batchOwner !== null &&
    isDataOwnerGenerationCurrent(batchOwner)
  );
}

function patchRow(generation: number, pluginId: string, patch: Partial<UpdateAllRow>): void {
  // 代际已失效(批次被作废或被新批次接管)时,迟到的行迁移直接丢弃。
  if (!isGenerationCurrent(generation) || state.rows === null) return;
  emit({ ...state, rows: updateRow(state.rows, pluginId, patch) });
}

function batchOwnerCurrent(): boolean {
  return batchOwner !== null && isDataOwnerGenerationCurrent(batchOwner);
}

/**
 * 把一行退回「待重新审阅」——前置条件变化的统一收敛(runner 与批准共用)。
 *
 * 清掉旧的 permissionDiff 并打 staleReview:弹窗据此显示「权限差异已过期 /
 * 重新审阅」,用户点一下就走 approve 按当前事实重取详情、重算差异,
 * 无扩权直接装、仍扩权则逐项审。可恢复,不必关弹窗重启整批。
 */
function holdRowForReReview(
  generation: number,
  pluginId: string,
  patch: Partial<UpdateAllRow> = {},
): void {
  const releaseId = patch.releaseId ?? state.rows?.find((r) => r.pluginId === pluginId)?.releaseId;
  if (!releaseId) {
    // 没有目标 release 就没有可重审的对象:approveUpdateExpansion 的入口守卫
    // 要求 row.releaseId 存在,少了它这行会变成点「重新审阅」也没反应的死行。
    // 与其静默卡住,不如如实落失败(errorText 留空 = 弹窗显示通用失败文案)。
    patchRow(generation, pluginId, { status: 'failed' });
    return;
  }
  patchRow(generation, pluginId, {
    status: 'needs-confirm',
    staleReview: true,
    permissionDiff: undefined,
    reviewedApproval: undefined,
    ...patch,
    releaseId,
  });
}

/** 账号/模式切换后作废整个批次(旧代际的 runner 在下一个检查点自行退出)。 */
function voidStaleBatch(): void {
  batchOwner = null;
  beginGeneration(); // 让在飞的 runner / approve 立即失效。
  finishToastShown = true; // 作废批次不再补发完成 toast。
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

/** 页面挂载期注册环境回调;返回的清理函数在卸载时注销。 */
export function setUpdateAllBatchHooks(next: UpdateAllBatchHooks): () => void {
  hooks = next;
  return () => {
    if (hooks === next) hooks = {};
  };
}

function installedGhostOf(ghostId: string): InstalledGhost | null {
  return readInstalledGhostsSnapshot().find((ghost) => ghost.manifest.id === ghostId) ?? null;
}

async function refreshMarketIfMounted(): Promise<void> {
  try {
    await hooks.refreshMarket?.();
  } catch {
    // 快照刷新失败不影响批次结果;下次进页会重新拉取。
  }
}

function maybeFinishToast(): void {
  const rows = state.rows;
  // 还有批准在途时不报完成:它们的行此刻是 installing,提前报会把"没装完"
  // 说成"已完成"。最后一个在途批准的收尾会再来一次。
  if ((inflightByGeneration.get(batchGeneration) ?? 0) > 0) return;
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

/** 启动新批次(运行中调用是 no-op;是否复用未完成批次由页面判断)。 */
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

/**
 * 批量 runner:串行走「取详情 → 权限 diff → 无扩权直接装 / 有扩权停待确认」。
 * 全程以启动时捕获的 `generation` 为准:任一 await 之后代际若已失效
 * (批次被作废或被新批次接管),立即停手——不写状态、不消费队列、不收尾。
 *
 * 来源隔离(#2043):非 `update-available` 的详情(conflict / 其它状态)不在
 * 批量里静默替换来源,按跳过收束;自动安装路径一律 `allowSourceReplacement: false`。
 */
async function runQueue(generation: number): Promise<void> {
  if (state.running || !isGenerationCurrent(generation)) return;
  emit({ ...state, running: true });
  try {
    for (;;) {
      if (batchGeneration !== generation) return; // 已被新批次接管:静默让位。
      if (!batchOwnerCurrent()) {
        voidStaleBatch();
        return;
      }
      const next = (state.rows ?? []).find((row) => row.status === 'pending');
      if (!next) break;
      patchRow(generation, next.pluginId, { status: 'installing' });
      // detail 提到 try 外:install 抛前置条件失败时,catch 要靠它把目标 release
      // 写回待重审行——runApprovalBody 的入口守卫要求 row.releaseId 存在,
      // 缺了它用户点「重新审阅」会直接 return,该项在本批次里静默卡死。
      let detail: Awaited<ReturnType<typeof window.electronAPI.pluginMarket.detail>> | null = null;
      try {
        detail = await window.electronAPI.pluginMarket.detail(next.pluginId);
        // detail 往返期间可能切换账号或换批次:install 会以当前账号执行,
        // 旧批次绝不能把上一轮的更新落到新账号/新批次上。
        if (batchGeneration !== generation) return;
        if (!batchOwnerCurrent()) {
          voidStaleBatch();
          return;
        }
        if (detail.installState === 'installed') {
          // 目标 release 已经落账——典型是用户在批次启动前后用卡片上的单项更新
          // 装了同一个 release,而本批次拿的是那之前的市场快照。直接收束,
          // 不重复下载安装同一份包。
          patchRow(generation, next.pluginId, { status: 'done' });
          continue;
        }
        // 来源隔离(#2043):批量更新只原位替换 update-available 的市场包;
        // conflict / 其它来源状态不在这里静默切换来源,按跳过收束。
        if (detail.installState !== 'update-available') {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const installedGhost = installedGhostOf(next.ghostId);
        if (!installedGhost) {
          // 批量期间插件已被卸载:绝不拿市场 manifest 兜底继续安装
          // (那会把用户刚卸载的插件重新装回来),该行按跳过收束。
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        const installedManifest = installedGhost.manifest;
        const reviewedApproval = ghostInstallApprovalToken(installedGhost.approval);
        const diff = diffInstalledGhostPermissionItems(installedGhost, detail.manifest);
        if (installedGhost.approval.state !== 'approved' || diff.added.length > 0) {
          // 扩权不自动放行；没有有效 receipt 时也不存在可沿用的批准基线，
          // 即使目标包没有权限项仍要停下来完成一次明确确认。
          patchRow(generation, next.pluginId, {
            status: 'needs-confirm',
            releaseId: detail.releaseId,
            permissionDiff: diff,
            // 审阅基线绑定权限指纹而非版本号:同版本换 manifest 也能识别。
            reviewedBaseline: ghostPermissionBaselineKey(installedManifest),
            reviewedApproval,
            expectedManifest: detail.manifest,
          });
          continue;
        }
        patchRow(generation, next.pluginId, {
          fromVersion: installedManifest.version,
          toVersion: detail.version,
        });
        const result = await window.electronAPI.pluginMarket.install(next.pluginId, {
          expectedReleaseId: detail.releaseId,
          expectedInstalledApproval: reviewedApproval,
          expectedManifest: detail.manifest,
          allowSourceReplacement: false,
        });
        if (result.cancelled) {
          patchRow(generation, next.pluginId, { status: 'skipped' });
          continue;
        }
        patchRow(generation, next.pluginId, { status: 'done' });
      } catch (error) {
        if (batchGeneration !== generation) return;
        // 前置条件变化(基线复核否决 / release 变了 / 自定义源换了 manifest)
        // 不是「更新失败」而是「事实已变,请重新审阅」。落成终态 failed 会让
        // 这一项彻底没有入口,用户只能关掉弹窗重启整批。改为可恢复的待重审:
        // 弹窗显示「权限差异已过期 / 重新审阅」,点一下就按当前事实重算。
        // detail 为 null 说明连详情都没取到,没有可写回的 release,此时重审也
        // 无从下手,按失败处理更诚实。
        if (extractIpcError(error)?.code === 'PRECONDITION_FAILED' && detail !== null) {
          holdRowForReReview(generation, next.pluginId, {
            releaseId: detail.releaseId,
            toVersion: detail.version,
          });
          continue;
        }
        // 失败也只写回自己的批次:代际失效时这条错误属于已作废的批次。
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

/**
 * 批次收尾(所有返回路径共用):刷新市场快照 → 放开 running → 补完成 toast。
 *
 * running 必须**撑到刷新结束**才落下:刷新期间市场快照还是旧的,若此时放开
 * running,页面拿旧快照就能启动第二批,而本 runner 的收尾还会写到新批次上。
 * 代际失效时整个收尾跳过——旧 runner 不得清掉当前批次的 running、也不得
 * 触发当前批次的完成提示。
 */
async function settleBatchTail(generation: number): Promise<void> {
  if (batchGeneration !== generation) return;
  await refreshMarketIfMounted();
  if (batchGeneration !== generation) return;
  if (state.running) emit({ ...state, running: false });
  maybeFinishToast();
}

/**
 * 用户在弹窗里同意某个扩权项后继续安装。
 *
 * 多个待确认项连点时**串行执行**:后一个排在前一个之后,不并发装。
 * running 由在途计数统一管理——第一个入队时点亮,最后一个结束时才收尾释放,
 * 中途任何单项都不许提前把闸门放开(否则页面拿旧快照可重复启动)。
 */
export function approveUpdateExpansion(pluginId: string): Promise<void> {
  // **入队时**捕获代际与账号归属:用户点的是"此刻这个批次里的这一项"。
  // 若等排到自己时才读当前批次,账号切换 / 新批次接管后,这次旧点击就会
  // 重新绑定到新批次里同 pluginId 的待确认项上——等于未经批准放行新账号
  // 或新 release 的扩权。代际不符一律丢弃,绝不改绑。
  const generation = batchGeneration;
  const owner = batchOwner;
  retainApproval(generation);
  // 队列**按代际隔离**:全局单链下,账号切换后新批次的批准会排在旧代际那个
  // 慢 install() 后面干等——代际校验只能在轮到执行时把旧项丢掉,解不掉前面的
  // 等待。各代际各排各的,新账号点批准立即开始;旧代际的项轮到时仍会因代际
  // 失效而不执行安装。
  const previous = approvalQueueByGeneration.get(generation) ?? Promise.resolve();
  const run = previous.then(() => runApproval(pluginId, generation, owner));
  // 队列本身吞掉失败,后续批准不因前一个抛错而卡死;错误仍由 runApproval
  // 内部落到对应行的 failed 状态。
  approvalQueueByGeneration.set(generation, run.catch(() => undefined));
  return run;
}

async function runApproval(
  pluginId: string,
  generation: number,
  owner: DataOwnerGeneration | null,
): Promise<void> {
  try {
    // 排队期间批次被作废/接管,或账号已切换 → 这次批准属于过去,直接作废。
    if (batchGeneration !== generation) return;
    if (owner === null || !isDataOwnerGenerationCurrent(owner)) {
      voidStaleBatch();
      return;
    }
    await runApprovalBody(pluginId, generation);
  } finally {
    // 只有**本代际**最后一个在途批准才收尾:刷新市场快照 → 释放 running →
    // 补完成提示。早于这一刻释放,后续排队中的批准就会在闸门已开的状态下继续装。
    // settleBatchTail 自己再校验一次代际,失效时不碰当前批次。
    if (releaseApproval(generation)) await settleBatchTail(generation);
  }
}

async function runApprovalBody(pluginId: string, generation: number): Promise<void> {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  if (batchGeneration !== generation) return;
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  // 排在前面的批准可能已经把本行推进过(重复点同一项),只处理仍待确认的。
  if (!row || row.status !== 'needs-confirm' || !row.releaseId) return;
  if (installedGhostOf(row.ghostId) === null) {
    // 待确认期间插件被卸载:同意也不重装,按跳过收束。
    patchRow(generation, pluginId, { status: 'skipped' });
    return;
  }
  // 批准也是批次在推进:running 从这里一直撑到**最后一个**在途批准收尾结束,
  // 期间页面拿的是旧的 update-available 快照,不能让它启动第二批重复安装。
  patchRow(generation, pluginId, { status: 'installing' });
  if (!state.running) emit({ ...state, running: true });
  try {
    // 一律重取详情。它同时给出三件事,缺一不可:
    //  1. installState —— **目标 release 是否真的落账**的权威判据。main 侧
    //     只有 record.releaseId === 目标 release 且所有权归本插件时才报
    //     'installed'(plugin-market/service.ts),所以「从文件装了同版本
    //     但不同 release」不会被误判成完成;版本号比对做不到这点。
    //  2. 最新 releaseId / manifest —— 并发防护与非 server 源的 reviewed manifest。
    //  3. 当前 manifest —— 与已装 manifest 重算权限差异。
    const detail = await window.electronAPI.pluginMarket.detail(pluginId);
    // detail 往返期间批次可能已被作废/接管:此后一律不再写状态、不再安装。
    // 与 runQueue 同一套**双重**校验:代际管「同账号内换批次」,owner 管
    // 「账号刚切走但页面的作废 effect 还没跑」那个窗口——只看代际的话,
    // 这段时间里旧批准会读到新账号的已装 manifest 并安装新账号的同 id 插件。
    if (batchGeneration !== generation) return;
    if (!batchOwnerCurrent()) {
      voidStaleBatch();
      return;
    }
    // **detail 之后重读已装 manifest**:这段往返里「从文件更新」等路径可能整体
    // 换掉它,拿 await 之前的快照判断 = 拿过期事实做安全决策。
    const installedGhost = installedGhostOf(row.ghostId);
    if (installedGhost === null) {
      patchRow(generation, pluginId, { status: 'skipped' });
      return;
    }
    const installed = installedGhost.manifest;
    if (detail.installState === 'installed') {
      // 目标 release 已由别的路径装上:直接收束,不重复下载安装。
      // (return 后仍走 finally 的统一收尾——刷新市场快照 + 完成 toast。)
      patchRow(generation, pluginId, { status: 'done', fromVersion: installed.version });
      return;
    }
    /** 相对**当前**事实回到逐项审阅(不是终态失败:用户还能重新决定)。 */
    const holdForReReview = (): void => {
      patchRow(generation, pluginId, {
        status: 'needs-confirm',
        fromVersion: installed.version,
        toVersion: detail.version,
        releaseId: detail.releaseId,
        permissionDiff: diffInstalledGhostPermissionItems(installedGhost, detail.manifest),
        staleReview: false,
        reviewedBaseline: ghostPermissionBaselineKey(installed),
        reviewedApproval: ghostInstallApprovalToken(installedGhost.approval),
        expectedManifest: detail.manifest,
      });
    };
    // 用户审阅的是「审阅当时的已装权限面 → 那一刻的目标 release」。三个前提
    // 任一变了,那份 diff 与它换来的 allowPermissionExpansion 就不再对应现实:
    //  - staleReview:reconcile 已发现基线被换掉;
    //  - 权限指纹变化(以刚重读的 installed 为准):ghosts.update() 允许**同版本
    //    整体替换 manifest**,同版本换入更宽的声明时版本比较完全看不出来;
    //  - 目标 release 变化:市场在等待期间发了新版,审的不是这一版。
    //  - 目标 manifest 变化:自定义市场源可以在**同一 releaseId 下**改 manifest,
    //    只比 releaseId 看不出来。
    // 所有来源都必须留有 expectedManifest 且与当前详情逐份一致才算有效:
    // 缺失不能短路成「有效」——那样下一次批准会不带 expectedManifest 去装,
    // 主进程对这类来源直接 INVALID_PARAMS,行落成 failed(前一轮把被拒的行
    // 清成 expectedManifest: undefined,正好会踩中)。
    const manifestStillMatches =
      row.expectedManifest !== undefined &&
      JSON.stringify(row.expectedManifest) === JSON.stringify(detail.manifest);
    const reviewedApproval = row.reviewedApproval;
    const reviewStillValid =
      row.staleReview !== true &&
      reviewedApproval !== undefined &&
      ghostPermissionBaselineKey(installed) === row.reviewedBaseline &&
      ghostInstallApprovalToken(installedGhost.approval) === reviewedApproval &&
      detail.releaseId === row.releaseId &&
      manifestStillMatches;
    /**
     * 安装并接住「前置条件失败」。Main 的 PRECONDITION_FAILED 覆盖一组
     * **并发事实变化**:安装锁内的基线复核否决、release 变了、自定义市场源
     * 在 detail() 之后以同版本改了 manifest(expectedManifest 对不上)。
     * 这些都是「事实已变,请重新审阅」而不是「更新失败」——终态 failed 会让
     * 用户彻底失去这一项的入口,只能重启整批。所以一律回到 needs-confirm。
     * 返回 true = 真的装上了;false = 已按重审/让位处理完,调用方直接收手。
     */
    const installOrHoldForReReview = async (
      options: Parameters<typeof window.electronAPI.pluginMarket.install>[1],
    ): Promise<boolean> => {
      try {
        const result = await window.electronAPI.pluginMarket.install(pluginId, options);
        if (result.cancelled) {
          patchRow(generation, pluginId, { status: 'skipped' });
          return false;
        }
        return true;
      } catch (error) {
        if (batchGeneration !== generation) return false;
        if (extractIpcError(error)?.code === 'PRECONDITION_FAILED') {
          // 注意**不能**用 holdForReReview():那会拿手里这份 detail 重算差异并
          // 把 staleReview 置 false。可安装被拒恰恰说明这份 detail 已经不对了
          // (典型是自定义源在同 releaseId 下换了 manifest),照它生成确认内容,
          // 下次批准还会提交同一份过期的 expectedManifest,陷入循环失败。
          // 丢掉旧差异、标记过期,等下次批准重新取详情。
          holdRowForReReview(generation, pluginId, {
            releaseId: detail.releaseId,
            toVersion: detail.version,
            fromVersion: installed.version,
            expectedManifest: undefined,
          });
          return false;
        }
        throw error;
      }
    };
    if (reviewStillValid && row.expectedManifest !== undefined) {
      const didInstall = await installOrHoldForReReview({
        expectedReleaseId: row.releaseId,
        expectedInstalledApproval: reviewedApproval,
        expectedManifest: row.expectedManifest,
        allowPermissionExpansion: true,
        allowSourceReplacement: false,
        // 审阅基线随批准回传:Main 在安装锁内用当时的已装 manifest 复核,
        // renderer 这边的检查挡不住 IPC 往返窗口内的替换。
        ...(row.reviewedBaseline !== undefined
          ? { reviewedBaseline: row.reviewedBaseline }
          : {}),
      });
      if (!didInstall) return;
      patchRow(generation, pluginId, { status: 'done' });
    } else if (
      installedGhost.approval.state !== 'approved' ||
      diffInstalledGhostPermissionItems(installedGhost, detail.manifest).added.length > 0
    ) {
      // 相对新事实仍是扩权，或当前已没有有效批准基线：回到完整审阅，
      // 绝不拿旧批准静默放行。
      holdForReReview();
      return;
    } else {
      // 重算后已无扩权,按普通更新装。这条同样要接住并发变化:自定义市场源
      // 在 detail() 返回后以同版本改 manifest 时,Main 会因 expectedManifest
      // 不匹配拒绝,不能把它落成终态失败。
      const ok = await installOrHoldForReReview({
        expectedReleaseId: detail.releaseId,
        expectedInstalledApproval: ghostInstallApprovalToken(installedGhost.approval),
        expectedManifest: detail.manifest,
        allowSourceReplacement: false,
      });
      if (!ok) return;
      patchRow(generation, pluginId, { status: 'done', fromVersion: installed.version });
    }
  } catch (error) {
    patchRow(generation, pluginId, {
      status: 'failed',
      errorText: i18n.t(pluginMarketErrorKey(error)),
    });
  }
  // 收尾统一由 runApproval 在**最后一个**在途批准结束时做(见那里的 finally):
  // 每项各自收尾会让前一项提前释放 running,后面排队的批准就在开着的闸门下跑。
}

/** 用户在弹窗里跳过某个扩权项。 */
export function skipUpdateExpansion(pluginId: string): void {
  if (!batchOwnerCurrent()) {
    voidStaleBatch();
    return;
  }
  const row = state.rows?.find((candidate) => candidate.pluginId === pluginId);
  if (!row || row.status !== 'needs-confirm') return;
  patchRow(batchGeneration, pluginId, { status: 'skipped' });
  maybeFinishToast();
}

/**
 * 与外部事实对账:账号切换 → 整批作废;待确认行或尚未开始的行被卸载 → 跳过、
 * **目标 release 已落账**(市场快照报 'installed')→ 记为完成、
 * 权限基线被换掉(含同版本替换 manifest)→ 旧 permissionDiff 已不对应
 * 现实,清掉并标记待重审(真正的重算在 approve 时做,那里能取详情)。
 *
 * `pending` 行按来源事实收束(来源隔离,#2043):市场快照不再报
 * `update-available`(conflict 等)→ 跳过,不再静默切换来源。
 *
 * 完成判据只认市场快照的 installState,不认版本号:同版本不同 release
 * (从文件装入)在版本比对下无法区分,会把没装上目标 release 的行误收成完成。
 * 页面在已装清单、市场快照或身份变化时调用,并把当前市场快照传进来。
 */
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
    if (row.status === 'pending') {
      const installed = installedById.get(row.ghostId);
      if (!installed) {
        rows = updateRow(rows, row.pluginId, { status: 'skipped' });
        changed = true;
      } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
        // 目标 release 已落账:无需再装。
        rows = updateRow(rows, row.pluginId, { status: 'done' });
        changed = true;
      } else if (
        installStateByPluginId.has(row.pluginId) &&
        installStateByPluginId.get(row.pluginId) !== 'update-available'
      ) {
        // 来源隔离:来源已变化(conflict 等),不静默替换,按跳过收束。
        rows = updateRow(rows, row.pluginId, { status: 'skipped' });
        changed = true;
      } else if (installed.version !== row.fromVersion) {
        rows = updateRow(rows, row.pluginId, { fromVersion: installed.version });
        changed = true;
      }
    } else if (row.status === 'needs-confirm') {
      const installedGhost = installedGhostOf(row.ghostId);
      if (installedGhost === null) {
        rows = updateRow(rows, row.pluginId, { status: 'skipped' });
        changed = true;
      } else if (installStateByPluginId.get(row.pluginId) === 'installed') {
        // 目标 release 已落账(main 侧 record.releaseId 对上):无需再装。
        rows = updateRow(rows, row.pluginId, { status: 'done' });
        changed = true;
      } else if (
        ghostPermissionBaselineKey(installedGhost.manifest) !== row.reviewedBaseline ||
        ghostInstallApprovalToken(installedGhost.approval) !== row.reviewedApproval
      ) {
        // 权限基线或批准态变了(含 approved receipt 失效):旧审阅作废。
        rows = updateRow(rows, row.pluginId, {
          fromVersion: installedGhost.manifest.version,
          permissionDiff: undefined,
          staleReview: true,
          reviewedApproval: undefined,
        });
        changed = true;
      } else if (installedGhost.manifest.version !== row.fromVersion) {
        // 权限面没变、只是版本号变了:审阅结论仍然成立,同步展示用版本即可。
        rows = updateRow(rows, row.pluginId, { fromVersion: installedGhost.manifest.version });
        changed = true;
      }
    }
  }
  if (changed) {
    emit({ ...state, rows });
    maybeFinishToast();
  }
}

/** 仅测试用:清空模块级批次状态与回调注册。 */
export function __resetUpdateAllBatchForTest(): void {
  state = { rows: null, running: false };
  finishToastShown = false;
  hooks = {};
  batchOwner = null;
  // 递增而非归零:上个用例遗留的在飞 runner 认的是旧代际,归零会让它复活。
  beginGeneration();
  approvalQueueByGeneration.clear();
  inflightByGeneration.clear();
  listeners.clear();
}
