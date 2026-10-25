import type { DeviceLinkStatus } from '@cindy/device-link';

/**
 * 会话消息区"空状态"(暂无消息)是否应被抑制的纯判定。判定为 true 时消息区渲染
 * 「正在同步」loading 占位(MessageRenderer 的 SyncingMessages)而非「暂无消息」。
 *
 * 背景:冷开会话时 currentSession 元信息从 sessions store 立即就有(hasSession=true),但消息还没
 * load 完(messageCount=0)。此刻 load effect 还没把 loading 翻 true、showSyncingShell 也不成立
 * (它要求 composerSlot==='missing-session',而 hasSession 时不是),于是"暂无消息"空状态会闪一帧,
 * 直到消息到达。修法:把"本次打开还没首次同步完成 + 0 条 + 非离线/被撤销"也纳入抑制 —— 真正的
 * "暂无消息"只在**同步完成过(hasSyncedThisOpen)且确实 0 条**时才显示。
 */

export interface MessageEmptyStateInput {
  /** 正在 load(同步进行中)。 */
  loading: boolean;
  /** 冷开同步壳(session 元信息还没回来但在同步)。 */
  showSyncingShell: boolean;
  /** 当前已加载的消息条数。 */
  messageCount: number;
  /** 当前消息历史是否已成功读取或恢复缓存，且尚未被新活动作废。 */
  hasSyncedThisOpen: boolean;
  /** 远端不可用(离线/被撤销)——允许显示历史未缓存说明，不进同步占位分支。 */
  remoteUnavailable: boolean;
}

export function shouldSuppressEmptyMessageState(input: MessageEmptyStateInput): boolean {
  if (input.loading || input.showSyncingShell) return true;
  // 冷开未同步窗口:还没首次同步完成、0 条、且不是离线/被撤销 → 渲染同步占位而非闪"暂无消息"。
  if (input.messageCount === 0 && !input.hasSyncedThisOpen && !input.remoteUnavailable) return true;
  return false;
}

/** 当前访问的历史结果：切换任务/设备时重置，通知或新活动作废旧结果，重连保留。 */
export type MessageHistoryRead = { key: string; synced: boolean };

export interface SessionMessageEmptyStateInput {
  loading: boolean;
  showSyncingShell: boolean;
  subscriptionIdentity: string;
  historyRead: MessageHistoryRead | null;
  historySnapshot: { ready: boolean; items: readonly unknown[] };
  messageCount: number;
  status: DeviceLinkStatus;
  targetAvailable: boolean | null;
  remoteUnavailableReason: string | null;
  historyNotCachedMessage: string;
}

/** 连接中且可用性未知时继续等待，不据此要求用户重新连接电脑。 */
export function shouldShowCachedHistoryNotice(status: DeviceLinkStatus, targetAvailable: boolean | null): boolean {
  return status !== 'connecting' && (status !== 'online' || targetAvailable === false);
}

/** 结合历史读取结果与连接状态，统一决定同步占位和未缓存文案。 */
export function resolveSessionMessageEmptyState(input: SessionMessageEmptyStateInput) {
  // 新活动作废的是本次访问的旧历史；连接代推进不能凭旧缓存撤销失效标记。
  const hasSyncedHistory = input.historyRead?.synced !== false
    && (input.historyRead?.key === input.subscriptionIdentity || input.historySnapshot.ready);
  const remoteUnavailable = !!input.remoteUnavailableReason
    || shouldShowCachedHistoryNotice(input.status, input.targetAvailable);
  return {
    syncingWhileEmpty: shouldSuppressEmptyMessageState({
      loading: input.loading,
      showSyncingShell: input.showSyncingShell,
      messageCount: input.historySnapshot.ready ? input.historySnapshot.items.length : input.messageCount,
      hasSyncedThisOpen: hasSyncedHistory,
      remoteUnavailable,
    }),
    emptyMessage: !hasSyncedHistory && remoteUnavailable ? input.historyNotCachedMessage : undefined,
  };
}

/**
 * 远端列表页(自动化列表 / 设备会话列表)"空状态插画"是否应被抑制的纯判定。
 *
 * 背景:这些页面的数据全部来自远端,mount 时列表初始为 [] 且 lastSyncedAt 为 null,首轮同步完成前
 * 渲染"暂无 XX"空状态是错误信息 —— 冷进(deep link)会先闪空状态再跳成真列表。首同步完成前渲染
 * 干净空白优于画错误的空状态;同步失败时 ConnectionBanner 已展示错误与重试入口,空状态同样保持
 * 抑制,不谎报"暂无"。
 */
export interface RemoteListEmptyStateInput {
  /** 当前列表可见条目数(有内容时空状态本就不渲染,判定恒为不抑制)。 */
  itemCount: number;
  /** 本次打开是否已完成过至少一次成功同步(lastSyncedAt != null)。 */
  hasSyncedThisOpen: boolean;
  /** 当前筛选或搜索仍在读取；上一次成功不能证明这次为空。 */
  loading?: boolean;
  /** 读取失败由连接提示负责展示，不同时声称列表为空。 */
  failed?: boolean;
}

export function shouldSuppressRemoteListEmptyState(input: RemoteListEmptyStateInput): boolean {
  return input.itemCount === 0 && (!input.hasSyncedThisOpen || input.loading === true || input.failed === true);
}
