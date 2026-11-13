import { useCallback, useEffect, useRef } from 'react';

import { getDraftPresence, subscribeDraftContent } from '@/lib/composerDraftStore';
import { discardProvisionalDraftTask, provisionalDraftTaskId } from '../provisionalDraftTask';

/** Voice previews are not editor content yet; an empty saved draft is not a deletion intent. */
export function useProvisionalDraftEmptyCleanup(draftKey: string, refreshTitle: () => void) {
  const voiceBusy = useRef(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const cancel = useCallback(() => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  }, []);
  const isEmpty = useCallback(() => !voiceBusy.current && !getDraftPresence(draftKey), [draftKey]);
  const discardIfEmpty = useCallback(() => {
    const id = provisionalDraftTaskId();
    if (id) void discardProvisionalDraftTask(() => provisionalDraftTaskId() === id && isEmpty());
  }, [isEmpty]);
  const armEmptyCheck = useCallback(
    (delayMs: number) => {
      cancel();
      if (!isEmpty()) return;
      timer.current = setTimeout(() => {
        timer.current = null;
        discardIfEmpty();
      }, delayMs);
    },
    [cancel, discardIfEmpty, isEmpty],
  );
  const onVoiceBusyChange = useCallback(
    (busy: boolean) => {
      voiceBusy.current = busy;
      cancel();
      if (!busy && provisionalDraftTaskId()) armEmptyCheck(1_000);
    },
    [armEmptyCheck, cancel],
  );
  const onVoiceDetached = useCallback(() => {
    const id = provisionalDraftTaskId();
    if (!id) return undefined;
    // The component will be gone when ASR settles. Bind cleanup to its source
    // task, then recheck after the existing detached-persist path has finished.
    return () => {
      if (provisionalDraftTaskId() !== id) return;
      refreshTitle();
      void discardProvisionalDraftTask(
        () => provisionalDraftTaskId() === id && !getDraftPresence(draftKey),
      );
    };
  }, [draftKey, refreshTitle]);

  useEffect(() => {
    const unsubscribe = subscribeDraftContent(draftKey, () => {
      if (!provisionalDraftTaskId()) return;
      refreshTitle();
      if (isEmpty()) armEmptyCheck(1_000);
      else cancel();
    });
    return () => {
      unsubscribe();
      const pending = timer.current !== null;
      cancel();
      // A recording may settle into the source draft after navigation. Let that
      // existing persistence path finish instead of deleting its task on unmount.
      if (pending) discardIfEmpty();
    };
  }, [armEmptyCheck, cancel, discardIfEmpty, draftKey, isEmpty, refreshTitle]);

  return { armEmptyCheck, onVoiceBusyChange, onVoiceDetached };
}
