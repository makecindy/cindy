import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import { i18n } from '@/i18n';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import { mergeNewSessionEditFollowUps } from './mergeNewSessionEditFollowUps';
import {
  beginNewSessionReturnToEdit, markNewSessionDurableEditReady, getNewSessionCreationTask, prepareNewSessionCreationForEdit,
  stashNewSessionDraftForEdit, type NewSessionCreationTask,
} from './newSessionCreation';

/** Shared by both entry screens; finish recovery even if the initiating screen leaves. */
export async function returnNewSessionToEdit({ sessionId, deviceId, isCurrent, onReady, getToken, stashDraft = stashNewSessionDraftForEdit }: {
  sessionId: string;
  deviceId: string;
  getToken?: () => Promise<string | null>;
  isCurrent: () => boolean;
  onReady: (params: { deviceId: string; deviceName: string; recoverySessionId?: string; editSessionId?: string }) => void | Promise<void>;
  stashDraft?: (task: NewSessionCreationTask) => void;
}): Promise<void> {
  const owner = getMobileAuthOwner();
  const ownerCurrent = () => isMobileAuthOwnerCurrent(owner);
  const task = getNewSessionCreationTask(sessionId);
  if (!ownerCurrent() || !isCurrent() || task?.deviceId !== deviceId) return;
  if (task.readyForEdit && !task.returningToEdit) {
    if (task.readyForEdit === 'durable') await mergeNewSessionEditFollowUps(sessionId, deviceId, getToken);
    if (!ownerCurrent() || !isCurrent() || getNewSessionCreationTask(sessionId)?.deviceId !== deviceId) return;
    await onReady({ deviceId, deviceName: task.deviceName,
      ...(task.readyForEdit === 'durable' ? { recoverySessionId: sessionId } : { editSessionId: sessionId }) });
    return;
  }
  const release = beginNewSessionReturnToEdit(sessionId);
  if (!release) return;
  const taskCurrent = () => ownerCurrent() && getNewSessionCreationTask(sessionId) === task;
  try {
    const prepared = await prepareNewSessionCreationForEdit(sessionId);
    // Cleanup may already have deleted the worktree. Leaving only cancels navigation,
    // not draft recovery or task dismissal; account changes still fence all writes.
    if (!prepared || !taskCurrent()) return;
    const durableFirst = getCurrentMobileOutboxRecords().find((record) =>
      record.accountId === owner.accountKey && record.deviceId === deviceId
        && record.item.sessionId === sessionId && record.creation);
    if (durableFirst) {
      await mobileDurableOutbox.update(durableFirst, {
        suspended: true, state: 'failed',
        error: prepared.error || durableFirst.error || i18n.t('session.screen.firstMessageNotSent'),
        creation: { ...durableFirst.creation!, editReady: true },
      });
      await mergeNewSessionEditFollowUps(sessionId, deviceId, getToken);
      if (!taskCurrent()) return;
      markNewSessionDurableEditReady(sessionId, deviceId);
      if (isCurrent()) await onReady({ deviceId, deviceName: prepared.deviceName, recoverySessionId: sessionId });
      return;
    }
    stashDraft(prepared);
    // Keep the failed row reachable until the matching form takes ownership.
    if (isCurrent()) await onReady({ deviceId, deviceName: prepared.deviceName, editSessionId: sessionId });
  } finally {
    release();
  }
}
