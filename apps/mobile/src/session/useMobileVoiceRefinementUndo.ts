import { useCallback, useEffect, useRef, useState } from 'react';

import type { MobileVoiceDraftInsertion } from '@/session/mobileVoiceInput';

/** Auto-dismiss window for the lightweight post-refinement "restore original" action. */
export const MOBILE_VOICE_REFINEMENT_UNDO_MS = 6_000;

export type MobileVoiceRefinementUndoCandidate = {
  draft: string;
  rawTranscriptText: string;
  refinedText: string;
  start: number;
  end: number;
  revertHistoryToRaw?: () => void;
};

export type MobileVoiceRefinementUndoResult = {
  nextDraft: string;
  nextStart: number;
  nextEnd: number;
  replacement: MobileVoiceDraftInsertion;
};

/**
 * Pure range-verified replacement restoring raw ASR text in place of the
 * refined span. Returns null if the user already modified that range.
 */
export function applyMobileVoiceRefinementUndoToDraft(
  currentDraft: string,
  candidate: MobileVoiceRefinementUndoCandidate,
): MobileVoiceRefinementUndoResult | null {
  const raw = candidate.rawTranscriptText.trim();
  const refined = candidate.refinedText.trim();
  if (!raw || !refined || raw === refined) return null;
  if (
    candidate.start < 0
    || candidate.end < candidate.start
    || candidate.end > currentDraft.length
    || currentDraft.slice(candidate.start, candidate.end) !== candidate.refinedText
  ) {
    return null;
  }
  const nextDraft = `${currentDraft.slice(0, candidate.start)}${raw}${currentDraft.slice(candidate.end)}`;
  return {
    nextDraft,
    nextStart: candidate.start,
    nextEnd: candidate.start + raw.length,
    replacement: {
      start: candidate.start,
      end: candidate.end,
      text: raw,
    },
  };
}

/**
 * Manages the short-lived "Restore original" action offered after mobile voice
 * refinement completes. Automatically clears on timeout, manual draft edits,
 * new recording start, submission, or unmount.
 */
export function useMobileVoiceRefinementUndo(durationMs = MOBILE_VOICE_REFINEMENT_UNDO_MS): {
  candidate: MobileVoiceRefinementUndoCandidate | null;
  offer: (candidate: MobileVoiceRefinementUndoCandidate) => void;
  dismiss: () => void;
  inspectDraft: (currentDraft: string) => void;
} {
  const [candidate, setCandidate] = useState<MobileVoiceRefinementUndoCandidate | null>(null);
  const candidateRef = useRef<MobileVoiceRefinementUndoCandidate | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const dismiss = useCallback(() => {
    if (timerRef.current) {
      clearTimeout(timerRef.current);
      timerRef.current = null;
    }
    candidateRef.current = null;
    setCandidate(null);
  }, []);

  const offer = useCallback((next: MobileVoiceRefinementUndoCandidate) => {
    if (next.rawTranscriptText.trim() === next.refinedText.trim() || !next.rawTranscriptText.trim()) {
      dismiss();
      return;
    }
    if (timerRef.current) clearTimeout(timerRef.current);
    candidateRef.current = next;
    setCandidate(next);
    timerRef.current = setTimeout(() => {
      timerRef.current = null;
      candidateRef.current = null;
      setCandidate(null);
    }, durationMs);
  }, [dismiss, durationMs]);

  const inspectDraft = useCallback((currentDraft: string) => {
    const active = candidateRef.current;
    if (!active) return;
    if (currentDraft !== active.draft) {
      dismiss();
    }
  }, [dismiss]);

  useEffect(() => dismiss, [dismiss]);

  return { candidate, offer, dismiss, inspectDraft };
}
