import { useRef } from "react";

interface GateState {
  requestId: string | null;
  allowBlocked: boolean;
  generation: number;
  reviewedFor: string | null;
}

/**
 * The one place both confirmation sheets decide whether a press may write Allow (maintainer reviews 07:30, 08:37). Both
 * sheets are review first: Allow answers only once the current consent was reviewed in the sheet. Presses never trust
 * what their callback captured: every press is judged against the sheet's current state, read when it is pressed. Each
 * render's callbacks carry the generation they were made in, and another consent moves it on, so a callback made for an
 * earlier consent does nothing however late it runs. No layout reading takes part.
 */
export function useConsentAnswerGate(now: { requestId: string | null; allowBlocked: boolean }) {
  const ref = useRef<GateState>({ requestId: null, allowBlocked: false, generation: 0, reviewedFor: null });
  const state = ref.current;
  if (state.requestId !== now.requestId) {
    state.generation += 1;
    state.requestId = now.requestId;
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
    /** Allow pressed (from this render): true only if the current consent was reviewed and can be allowed. */
    allow(): boolean {
      const current = ref.current;
      return live() && !current.allowBlocked && current.reviewedFor === current.requestId;
    },
  };
}
