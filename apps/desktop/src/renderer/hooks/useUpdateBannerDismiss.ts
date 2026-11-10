import { useSyncExternalStore } from 'react';

/**
 * useUpdateBannerDismiss — 侧栏自动更新提示框(UpdateBanner)的临时隐藏态。
 *
 * 场景:更新就绪(status='ready')时 banner 自动出现,用户想暂时不看可以点 X 关掉。
 * 关掉后头像行的 Flame 按钮涂黑,点击可以把 banner 再唤回来。
 *
 * 另外一条自动路径:banner **即将自动弹出**时若有任务在跑(与「立即重启」二次确认同一
 * 条 anyActivityBlockingRelaunch 探针),先不占侧栏,只走火焰按钮这份最小化提醒;
 * 任务全部停下后再弹出。这条记 reason='busy',和用户点 X 的 reason='user' 必须分开:
 * 任务停了只恢复 busy 让路,绝不把用户关掉的 banner 再塞回来。
 *
 * 语义:
 * - **仅本次进程内存**:重启后回到 false(update 是关键状态,不能永久隐藏)。
 * - **新更新到达自动 reset**:dismiss 时会记录当时的 (status, version) 快照;
 *   消费方通过 isNewUpdateAfterDismiss(status, version) 判断是否有新更新到达
 *   (对比快照),只在真的发生变化时 restore()——这样 UpdateBanner 在
 *   /settings 往返后 remount、useUpdateStatus() 经历 idle→ready 的初始水合
 *   时,不会因为「版本和之前 dismiss 时一样」而误 restore。
 * - **decidedVersion**:已经对某个待装版本做过「弹出 / 让路」决定。用来避免
 *   remount 时再闪一次探针空窗。系统自己弹出的横幅,后来又 busy 时仍会收回去。
 * - **pinnedByUser**:用户点火焰把横幅唤回来。只对 decidedVersion 那一版生效:
 *   这是明确要看,busy 探针不要再藏。待装版本变了就把钉住作废,重新探针。
 * - 模块级 singleton store(useSyncExternalStore),让 UpdateBanner 与
 *   UserInfoSection 无需 context / prop-drill 就能共享同一状态。
 */

export type UpdateBannerDismissReason = 'user' | 'busy';

interface DismissState {
  revealRequested: boolean;
  /** 每次手动检查递增；让同一请求只绑定一次，用户随后关闭不会被重新弹出。 */
  revealSeq: number;
  /** 已绑定过的请求（seq+状态+版本）；放在 store 里，切页面重挂载组件也不会重复展开。 */
  revealBoundKey: string | null;
  dismissed: boolean;
  reason: UpdateBannerDismissReason | null;
  dismissedStatus: string | null;
  dismissedVersion: string | null;
  decidedVersion: string | null;
  pinnedByUser: boolean;
}

const UNVERSIONED = '<none>';

export function updateBannerDecisionVersion(version: string | null): string {
  return version ?? UNVERSIONED;
}

const INITIAL_STATE: DismissState = {
  revealRequested: false,
  revealSeq: 0,
  revealBoundKey: null,
  dismissed: false,
  reason: null,
  dismissedStatus: null,
  dismissedVersion: null,
  decidedVersion: null,
  pinnedByUser: false,
};

let state: DismissState = { ...INITIAL_STATE };
const listeners = new Set<() => void>();

function emit() {
  listeners.forEach((fn) => fn());
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function getSnapshot() {
  // 必须返回整份 state:markAutoShown 时常 dismissed 不变、只写 decidedVersion,
  // 只订阅布尔值会让「探针空窗」永远不结束。
  return state;
}

export function getUpdateBannerDismissState(): Readonly<DismissState> {
  return state;
}

function sameBusyDefer(status: string, version: string | null): boolean {
  return (
    state.dismissed
    && state.reason === 'busy'
    && state.dismissedStatus === status
    && state.dismissedVersion === version
    && state.decidedVersion === updateBannerDecisionVersion(version)
  );
}

export function dismissUpdateBanner(currentStatus: string, currentVersion: string | null) {
  if (state.dismissed && state.reason === 'user') return;
  state = {
    ...state,
    dismissed: true,
    reason: 'user',
    dismissedStatus: currentStatus,
    dismissedVersion: currentVersion,
    decidedVersion: state.decidedVersion,
    pinnedByUser: false,
  };
  emit();
}

/**
 * 有任务在跑:不要弹出完整 banner,只留火焰入口。已经是用户关掉的,或用户点火焰
 * 钉住要看的,不要覆盖。
 */
export function deferUpdateBannerBecauseBusy(currentStatus: string, currentVersion: string | null) {
  if (state.dismissed && state.reason === 'user') return;
  if (isUpdateBannerPinnedFor(currentVersion)) return;
  if (sameBusyDefer(currentStatus, currentVersion)) return;
  state = {
    ...state,
    dismissed: true,
    reason: 'busy',
    dismissedStatus: currentStatus,
    dismissedVersion: currentVersion,
    decidedVersion: updateBannerDecisionVersion(currentVersion),
    pinnedByUser: false,
  };
  emit();
}

export function markUpdateBannerAutoShown(currentVersion: string | null) {
  if (state.dismissed && state.reason === 'user') return;
  if (isUpdateBannerPinnedFor(currentVersion)) return;
  const decidedVersion = updateBannerDecisionVersion(currentVersion);
  if (
    !state.dismissed
    && state.reason === null
    && state.decidedVersion === decidedVersion
    && !state.pinnedByUser
  ) return;
  state = {
    ...state,
    dismissed: false,
    reason: null,
    dismissedStatus: null,
    dismissedVersion: null,
    decidedVersion,
    pinnedByUser: false,
  };
  emit();
}

export function restoreUpdateBanner(opts?: { pin?: boolean }) {
  if (!state.dismissed) return;
  state = {
    ...state,
    dismissed: false,
    reason: null,
    dismissedStatus: null,
    dismissedVersion: null,
    decidedVersion: state.decidedVersion,
    pinnedByUser: opts?.pin !== false,
  };
  emit();
}

/** 手动检查发现更新：即使下载未完成或横幅尚未挂载，也记住这次展示意图。 */
export function requestUpdateBannerReveal() {
  state = { ...state, revealRequested: true, revealSeq: state.revealSeq + 1 };
  emit();
}

/**
 * 绑定展示请求到实际版本，避免沿用上次关闭的版本或被忙碌探针再次隐藏。
 * superseding 携带的还是旧补丁版本，新版尚未就绪：先钉住让提醒可见，但保留请求，
 * 等新版 ready 时再绑定新版本；只有 ready 才消费请求。
 */
export function revealRequestedUpdateBanner(
  status: string,
  version: string | null,
  consume: boolean,
) {
  if (!state.revealRequested) return;
  const key = `${state.revealSeq}:${status}:${updateBannerDecisionVersion(version)}`;
  if (state.revealBoundKey === key) return;
  state = {
    ...INITIAL_STATE,
    revealSeq: state.revealSeq,
    revealRequested: !consume,
    revealBoundKey: consume ? null : key,
    decidedVersion: updateBannerDecisionVersion(version),
    pinnedByUser: true,
  };
  emit();
}

export function clearUpdateBannerAutoDecision() {
  if (state.decidedVersion === null) return;
  state = { ...state, decidedVersion: null };
  emit();
}

export function isUpdateBannerDecidedFor(currentVersion: string | null): boolean {
  return state.decidedVersion === updateBannerDecisionVersion(currentVersion);
}

/** 用户钉住的是当前这个待装版本,不是上一版留下的钉。 */
export function isUpdateBannerPinnedFor(currentVersion: string | null): boolean {
  return state.pinnedByUser && isUpdateBannerDecidedFor(currentVersion);
}

/**
 * Returns true if a genuinely new update has arrived since the user dismissed
 * the banner — i.e. the current (status, version) differs from the snapshot
 * captured at dismiss time. Returns false when not dismissed, so callers can
 * unconditionally gate on this without an extra dismissed check.
 *
 * Guards against transient 'idle': useUpdateStatus() starts at 'idle' before
 * getUpdateStatus() resolves on remount, so we must not treat idle/error as a
 * new-update signal — only 'ready' and 'superseding' represent active updates.
 */
export function isNewUpdateAfterDismiss(currentStatus: string, currentVersion: string | null): boolean {
  if (!state.dismissed) return false;
  if (currentStatus !== 'ready' && currentStatus !== 'superseding') return false;
  return currentStatus !== state.dismissedStatus || currentVersion !== state.dismissedVersion;
}

export function resetUpdateBannerDismissStoreForTests() {
  state = { ...INITIAL_STATE };
  emit();
}

export function useUpdateBannerDismiss() {
  const snap = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
  return {
    dismissed: snap.dismissed,
    revealRequested: snap.revealRequested,
    revealSeq: snap.revealSeq,
    reason: snap.reason,
    dismiss: dismissUpdateBanner,
    restore: restoreUpdateBanner,
    pinnedByUser: snap.pinnedByUser,
    deferBecauseBusy: deferUpdateBannerBecauseBusy,
    markAutoShown: markUpdateBannerAutoShown,
    clearAutoDecision: clearUpdateBannerAutoDecision,
    isDecidedFor: isUpdateBannerDecidedFor,
    isNewUpdateAfterDismiss,
  };
}
