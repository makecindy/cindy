import { useEffect, useRef } from 'react';
import { getMobileAuthOwner, isMobileAuthOwnerCurrent } from '@/auth/authOwnerGeneration';
import type { NewSessionCreationTask } from './newSessionCreation';
import { returnNewSessionToEdit } from './returnNewSessionToEdit';

type RecoveryOptions = Parameters<typeof returnNewSessionToEdit>[0];

/** A failed creation has one next step: restore its draft in the new-task form. */
export function useFailedCreationReturnToEdit({ task, focused, sending = false, connectionEpoch, getToken, stashDraft, beforeNavigate, onReady, onError }: {
  task: NewSessionCreationTask | null;
  focused: boolean;
  /** A send already retaining/writing its bytes must settle before recovery reads the outbox. */
  sending?: boolean;
  connectionEpoch: number;
  getToken?: RecoveryOptions['getToken'];
  stashDraft: RecoveryOptions['stashDraft'];
  beforeNavigate?: () => Promise<void>;
  onReady: RecoveryOptions['onReady'];
  onError: (error: unknown) => void;
}) {
  const callbacks = useRef({ getToken, stashDraft, beforeNavigate, onReady, onError });
  callbacks.current = { getToken, stashDraft, beforeNavigate, onReady, onError };
  const navigated = useRef<string | null>(null);
  const sessionId = task?.sessionId;
  const deviceId = task?.deviceId;
  const failed = task?.status === 'create-failed';
  const startedAt = task?.startedAt;
  const readyForEdit = task?.readyForEdit;
  const current = useRef({ sessionId, deviceId, startedAt, focused });
  current.current = { sessionId, deviceId, startedAt, focused };
  const mounted = useRef(false);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (!failed || !focused || sending || !sessionId || !deviceId) return;
    const identity = JSON.stringify([deviceId, sessionId, startedAt]);
    if (navigated.current === identity) return;
    const owner = getMobileAuthOwner();
    const isCurrent = () => mounted.current && current.current.focused
      && current.current.sessionId === sessionId && current.current.deviceId === deviceId
      && current.current.startedAt === startedAt && isMobileAuthOwnerCurrent(owner);
    void returnNewSessionToEdit({
      sessionId, deviceId, isCurrent, getToken: callbacks.current.getToken,
      stashDraft: callbacks.current.stashDraft,
      onReady: async params => {
        if (!isCurrent() || navigated.current === identity) return;
        navigated.current = identity;
        try {
          await callbacks.current.beforeNavigate?.();
          if (isCurrent()) await callbacks.current.onReady(params);
          else if (navigated.current === identity) navigated.current = null;
        } catch (error) {
          if (navigated.current === identity) navigated.current = null;
          throw error;
        }
      },
    }).catch(error => {
      if (isCurrent()) callbacks.current.onError(error);
    });
    // Recovery itself continues after leaving. Re-entry (or restored connection)
    // can resume the existing recovery; ordinary store updates never retry it.
  }, [sessionId, deviceId, failed, startedAt, focused, sending, connectionEpoch, readyForEdit]);
}
