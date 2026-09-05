import { useCallback, useLayoutEffect, useMemo, useRef } from 'react';
import { composerDocumentProjectedText, type ComposerDocument } from '@/session/composerDocument';

export interface ComposerDraftSnapshot {
  document: ComposerDocument;
  draft: string;
}

/**
 * One mounted task's editor value. Only input/palette components subscribe.
 * Persistence, queue-edit exceptions and send snapshots remain with their
 * existing owner; this source adds no disk cache or cross-task lifetime.
 */
export function createComposerDraftSource(document: ComposerDocument) {
  let snapshot: ComposerDraftSnapshot = { document, draft: composerDocumentProjectedText(document) };
  const listeners = new Set<() => void>();
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    setDocument: (next: ComposerDocument) => {
      if (snapshot.document === next) return;
      snapshot = { document: next, draft: composerDocumentProjectedText(next) };
      for (const listener of listeners) listener();
    },
  };
}

export type ComposerDraftSource = ReturnType<typeof createComposerDraftSource>;

/** A running voice controller follows source replacement within its task only. */
export function useComposerVoiceDraftWriter(sessionId: string, writeDraft: (draft: string) => void) {
  const owner = useMemo(() => ({ sessionId }), [sessionId]);
  const latest = useRef<{ owner: typeof owner; writeDraft: typeof writeDraft } | null>(null);
  latest.current = { owner, writeDraft };
  useLayoutEffect(() => {
    latest.current = { owner, writeDraft };
    return () => {
      if (latest.current?.owner === owner) latest.current = null;
    };
  }, [owner]);
  return useCallback((draft: string) => {
    const current = latest.current;
    if (current?.owner === owner) current.writeDraft(draft);
  }, [owner]);
}
