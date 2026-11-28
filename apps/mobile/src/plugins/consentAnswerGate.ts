import { useRef } from "react";

/**
 * How Allow answers in a consent sheet's current layout: `regular` answers once the measured layout confirms it (Android
 * regular), `review` only after this consent was reviewed in the sheet (iOS always; Android compact).
 */
export type ConsentAnswerMode = "regular" | "review";
/** What an Allow press may do now: answer, check the measured regular layout first, or nothing. */
export type ConsentAllowVerdict = "answer" | "regular" | "none";

interface GateState {
  requestId: string | null;
  mode: ConsentAnswerMode;
  layoutKey: string | null;
  allowBlocked: boolean;
  generation: number;
  reviewedFor: string | null;
}

/**
 * The one place both confirmation sheets decide whether a press may write an answer (maintainer review 07:30). Presses
 * never trust what their callback captured (layout mode, reviewed, sizes): every press is judged against the sheet's
 * current state, read when it is pressed. Each render's callbacks carry the generation they were made in; another
 * consent, another layout mode or another layout (window size, text size) moves the generation on, and so does leaving
 * the regular layout from an Allow press (at once, before the render it causes), so a callback made before any of these
 * answers nothing however late it runs.
 */
export function useConsentAnswerGate(now: { requestId: string | null; mode: ConsentAnswerMode; layoutKey: string | null; allowBlocked: boolean }) {
  const ref = useRef<GateState>({ requestId: null, mode: "regular", layoutKey: null, allowBlocked: false, generation: 0, reviewedFor: null });
  const state = ref.current;
  if (state.requestId !== now.requestId || state.mode !== now.mode || state.layoutKey !== now.layoutKey) {
    state.generation += 1;
    state.requestId = now.requestId;
    state.mode = now.mode;
    state.layoutKey = now.layoutKey;
  }
  state.allowBlocked = now.allowBlocked;
  const issued = state.generation;
  const live = () => ref.current.requestId !== null && ref.current.generation === issued;
  return {
    /** Review pressed (from this render): marks the current consent reviewed; false if it is stale or already reviewed. */
    review(): boolean {
      const current = ref.current;
      if (!live() || current.reviewedFor === current.requestId) return false;
      current.reviewedFor = current.requestId;
      return true;
    },
    /** Allow pressed (from this render): what it may do, from the state now. */
    allow(): ConsentAllowVerdict {
      const current = ref.current;
      if (!live() || current.allowBlocked) return "none";
      if (current.mode === "review") return current.reviewedFor === current.requestId ? "answer" : "none";
      return "regular";
    },
    /** Leaving the regular layout (an Allow press it could not confirm): every earlier callback stops answering now. */
    leaveRegular(): void {
      ref.current.generation += 1;
    },
  };
}
