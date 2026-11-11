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
  let frame: number | null = null;
  return {
    getSnapshot: () => snapshot,
    subscribe: (listener: () => void) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && frame !== null) {
          cancelAnimationFrame(frame);
          frame = null;
        }
      };
    },
    setDocument: (next: ComposerDocument) => {
      if (snapshot.document === next) return;
      snapshot = { document: next, draft: composerDocumentProjectedText(next) };
      // Keep send/persistence snapshots synchronous, but publish at most once
      // per frame. Android's direct WebView emitter can deliver a burst of edits
      // before React finishes committing its external-store subscribers.
      if (frame !== null || listeners.size === 0) return;
      frame = requestAnimationFrame(() => {
        frame = null;
        // React may replace subscriptions during notification. New listeners
        // read the current snapshot on mount, not through this same iteration.
        for (const listener of [...listeners]) {
          if (listeners.has(listener)) listener();
        }
      });
    },
  };
}

export type ComposerDraftSource = ReturnType<typeof createComposerDraftSource>;

/** A running voice controller follows source replacement within its task only. */
export function useComposerVoiceDraftWriter<T>(sessionId: string, writeDraft: (draft: T) => void) {
  const owner = useMemo(() => ({ sessionId }), [sessionId]);
  const latest = useRef<{ owner: typeof owner; writeDraft: typeof writeDraft } | null>(null);
  latest.current = { owner, writeDraft };
  useLayoutEffect(() => {
    latest.current = { owner, writeDraft };
    return () => {
      if (latest.current?.owner === owner) latest.current = null;
    };
  }, [owner]);
  return useCallback((draft: T) => {
    const current = latest.current;
    if (current?.owner === owner) current.writeDraft(draft);
  }, [owner]);
}
