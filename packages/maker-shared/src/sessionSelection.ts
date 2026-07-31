import type { RemoteSessionListSessionLike, RemoteSessionSection } from './sessionList.js';

type RemoteSession = RemoteSessionListSessionLike;

export type MobileSessionBulkAction = 'archive' | 'delete' | 'pin' | 'restore' | 'unpin';
export type MobileSessionWritableStatus = 'active' | 'archived' | 'deleted';
export type MobileSessionBulkPatch = Partial<{
  pinnedAt: string | null;
  status: MobileSessionWritableStatus;
}>;

export interface MobileSessionBulkSummary<TSession extends RemoteSession = RemoteSession> {
  action: MobileSessionBulkAction;
  candidates: TSession[];
  skippedCount: number;
  title: string;
  description: string;
  confirmText: string;
}

export interface MobileSessionBulkActionLayout {
  primary: MobileSessionBulkAction[];
  destructive: MobileSessionBulkAction[];
}

export function toggleSessionSelection(
  selectedIds: readonly string[],
  sessionId: string,
): string[] {
  if (!sessionId) return [...selectedIds];
  return selectedIds.includes(sessionId)
    ? selectedIds.filter((id) => id !== sessionId)
    : [...selectedIds, sessionId];
}

export function pruneSessionSelection(
  selectedIds: readonly string[],
  visibleIds: readonly string[],
): string[] {
  const visible = new Set(visibleIds);
  return selectedIds.filter((id) => visible.has(id));
}

export function visibleSessionIdsFromSections(
  sections: readonly RemoteSessionSection[],
): string[] {
  return sections.flatMap((section) =>
    section.data.flatMap((item) => item.automationGroup?.sessionIds ?? [item.session.id]));
}

export function sessionIdsForListItem(
  item: RemoteSessionSection['data'][number],
): string[] {
  return item.automationGroup?.sessionIds ?? [item.session.id];
}

export function summarizeMobileSessionBulkAction<TSession extends RemoteSession>(
  sessions: readonly TSession[],
  action: MobileSessionBulkAction,
): MobileSessionBulkSummary<TSession>;
export function summarizeMobileSessionBulkAction<TSession extends RemoteSession>(
  sessions: readonly TSession[],
  action: MobileSessionBulkAction,
): MobileSessionBulkSummary<TSession> {
  const candidates = sessions.filter((session) => isBulkActionCandidate(session, action));
  const skippedCount = sessions.length - candidates.length;
  const actionLabel = bulkActionLabel(action);
  const skipped = skippedCount > 0 ? `，将跳过 ${skippedCount} 个不适用的任务` : '';
  return {
    action,
    candidates,
    skippedCount,
    title: `${actionLabel} ${candidates.length} 个任务`,
    description: `将对当前选中的 ${candidates.length} 个任务执行${actionLabel}${skipped}。`,
    confirmText: actionLabel,
  };
}

export function mobileSessionBulkPatch(
  action: MobileSessionBulkAction,
  now = Date.now(),
): MobileSessionBulkPatch {
  if (action === 'archive') return { status: 'archived', pinnedAt: null };
  if (action === 'pin') return { pinnedAt: new Date(now).toISOString() };
  if (action === 'restore') return { status: 'active' };
  if (action === 'unpin') return { pinnedAt: null };
  return { status: 'deleted' };
}

export function isMobileSessionBulkActionAvailable(summary: Pick<MobileSessionBulkSummary, 'candidates'>): boolean {
  return summary.candidates.length > 0;
}

export function mobileSessionBulkActionButtonLabel(
  summary: Pick<MobileSessionBulkSummary, 'candidates' | 'confirmText'>,
): string {
  return summary.candidates.length > 0
    ? `${summary.confirmText} ${summary.candidates.length}`
    : summary.confirmText;
}

export function visibleMobileSessionBulkActions(
  summaries: Record<MobileSessionBulkAction, Pick<MobileSessionBulkSummary, 'candidates'>>,
): MobileSessionBulkActionLayout {
  const primaryOrder: MobileSessionBulkAction[] = ['pin', 'unpin', 'archive', 'restore'];
  const primary = primaryOrder.filter((action) => summaries[action].candidates.length > 0);
  const destructive: MobileSessionBulkAction[] = summaries.delete.candidates.length > 0 ? ['delete'] : [];
  return { primary, destructive };
}

function isBulkActionCandidate(
  session: Pick<RemoteSession, 'pinnedAt' | 'status'>,
  action: MobileSessionBulkAction,
): boolean {
  if (action === 'archive') return session.status === 'active';
  if (action === 'pin') return session.status === 'active' && !session.pinnedAt;
  if (action === 'restore') return session.status === 'archived';
  if (action === 'unpin') return session.status !== 'deleted' && !!session.pinnedAt;
  return session.status !== 'deleted';
}

function bulkActionLabel(action: MobileSessionBulkAction): string {
  if (action === 'archive') return '归档';
  if (action === 'pin') return '置顶';
  if (action === 'restore') return '恢复';
  if (action === 'unpin') return '取消置顶';
  return '删除';
}
