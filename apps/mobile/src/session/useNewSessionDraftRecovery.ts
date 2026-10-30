import { useCallback, useEffect, useRef } from 'react';
import { isMobileAuthOwnerCurrent, type MobileAuthOwnerGeneration } from '@/auth/authOwnerGeneration';
import { isDurableCreationDraft, type DurableOutboxRecord } from './durableOutbox';
import { getCurrentMobileOutboxRecords, mobileDurableOutbox } from './mobileDurableOutbox';
import { completeNewSessionDurableEdit, findNewSessionEditDraft, subscribeNewSessionCreationTasks } from './newSessionCreation';
import { mergeNewSessionEditFollowUps } from './mergeNewSessionEditFollowUps';
import { persistNewSessionDraftEdit, type NewSessionDraftEdit } from './persistNewSessionCreationDraft';

type CreationRecord = DurableOutboxRecord & { creation: NonNullable<DurableOutboxRecord['creation']> };

/** The form owns one edit claim until its recovery route changes or unmounts. */
export function useNewSessionDurableEdit({ sessionId, deviceId, owner, getToken, hasInput, leaveForeignRecovery, onRestore, onEdited, onError }: {
  sessionId: string;
  deviceId: string;
  owner: MobileAuthOwnerGeneration;
  getToken?: () => Promise<string | null>;
  hasInput: () => boolean;
  leaveForeignRecovery: () => boolean;
  onRestore: (record: CreationRecord) => void;
  onEdited?: (record: DurableOutboxRecord | null) => void;
  onError?: (error: unknown) => void;
}) {
  const callbacks = useRef({ getToken, hasInput, leaveForeignRecovery, onRestore, onEdited, onError });
  callbacks.current = { getToken, hasInput, leaveForeignRecovery, onRestore, onEdited, onError };
  const editingRecord = useRef<DurableOutboxRecord | null>(null);
  const pendingEdit = useRef<Promise<unknown>>(Promise.resolve());
  const edit = useCallback((change: NewSessionDraftEdit) => {
    const record = editingRecord.current;
    if (!record || record.item.sessionId !== sessionId || record.deviceId !== deviceId || !isMobileAuthOwnerCurrent(owner)) return;
    const pending: Promise<void> = persistNewSessionDraftEdit(record, change).then(saved => {
      if (pendingEdit.current !== pending || !isMobileAuthOwnerCurrent(owner) || editingRecord.current?.item.sessionId !== sessionId) return;
      editingRecord.current = saved;
      callbacks.current.onEdited?.(saved);
    });
    pendingEdit.current = pending;
    void pending.catch(error => {
      if (pendingEdit.current === pending && isMobileAuthOwnerCurrent(owner) && editingRecord.current?.item.sessionId === sessionId) callbacks.current.onError?.(error);
    });
  }, [sessionId, deviceId, owner]);
  const flush = useCallback(() => pendingEdit.current, []);
  useEffect(() => {
    if (callbacks.current.leaveForeignRecovery() || !sessionId) return;
    let active = true;
    let restorationHandled = false;
    let merging = false;
    let releaseEditClaim: (() => void) | undefined;
    const restore = () => {
      if (!active || restorationHandled || merging || !isMobileAuthOwnerCurrent(owner)) return;
      if (callbacks.current.hasInput()) { restorationHandled = true; return; }
      const record = getCurrentMobileOutboxRecords().find(r => r.item.sessionId === sessionId && r.creation
        && r.accountId === owner.accountKey && r.deviceId === deviceId);
      if (!record?.creation || record.prepared) return;
      merging = true;
      void mergeNewSessionEditFollowUps(sessionId, deviceId, callbacks.current.getToken).then(saved => {
        if (!active || !isMobileAuthOwnerCurrent(owner) || !saved?.creation || !isDurableCreationDraft(saved)
          || !getCurrentMobileOutboxRecords().includes(saved)) return;
        // Storage/attachment consolidation may outlive a user edit. Abandon
        // this attempt without claiming the saved draft or replacing the form.
        restorationHandled = true;
        if (callbacks.current.hasInput()) return;
        editingRecord.current = saved;
        callbacks.current.onRestore(saved as CreationRecord);
        releaseEditClaim = completeNewSessionDurableEdit(sessionId, deviceId);
      }).catch(error => {
        if (active && isMobileAuthOwnerCurrent(owner)) callbacks.current.onError?.(error);
      }).finally(() => { merging = false; });
    };
    const unsubscribe = mobileDurableOutbox.subscribe(restore);
    void mobileDurableOutbox.ready().then(restore);
    return () => {
      active = false;
      editingRecord.current = null;
      const pending = pendingEdit.current;
      pendingEdit.current = Promise.resolve();
      unsubscribe();
      // Keep the existing claim until the last serialized edit settles. A new
      // blank form must not restore a revision the user has just deleted.
      void pending.then(() => releaseEditClaim?.(), () => releaseEditClaim?.());
    };
  }, [sessionId, deviceId, owner]);
  return { edit, flush };
}

/** Resume only while this form is still blank when asynchronous storage becomes ready. */
export function useAutoResumeNewSessionDraft({ enabled, deviceId, workingDir, owner, hasInput, onResume }: {
  enabled: boolean;
  deviceId: string;
  workingDir: string | null;
  owner: MobileAuthOwnerGeneration;
  hasInput: () => boolean;
  onResume: (params: { recoverySessionId: string; deviceId: string }) => void;
}) {
  const callbacks = useRef({ hasInput, onResume });
  callbacks.current = { hasInput, onResume };
  useEffect(() => {
    if (!enabled || !deviceId) return;
    let active = true;
    const resume = () => {
      if (!active || !isMobileAuthOwnerCurrent(owner) || callbacks.current.hasInput()) return;
      const saved = findNewSessionEditDraft(deviceId, workingDir);
      if (!saved) return;
      active = false;
      callbacks.current.onResume({ recoverySessionId: saved.item.sessionId, deviceId: saved.deviceId });
    };
    const unsubscribe = subscribeNewSessionCreationTasks(resume);
    void mobileDurableOutbox.ready().then(resume);
    return () => { active = false; unsubscribe(); };
  }, [enabled, deviceId, workingDir, owner]);
}
