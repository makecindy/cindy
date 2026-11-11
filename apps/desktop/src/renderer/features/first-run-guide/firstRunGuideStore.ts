/**
 * Window-local state of the get-started guide (docs/product-rules/first-run-guide.md).
 *
 * The guide is one window that leads through only the steps that apply to this person.
 * A step that is finished on another page (connecting a model, importing a teammate) parks
 * the guide: the window hides, a small bar offers the way back, and the step it was on is
 * kept. Nothing here is persisted; "shown once" is Main's decision.
 */
import { useSyncExternalStore } from 'react';

export interface FirstRunGuideContext {
  /** Opened from Settings: every step is offered, whatever was detected. */
  manual: boolean;
  /** Another computer of this account holds something worth copying here. */
  migration: boolean;
  /** Data of an earlier app version was brought over during this sign-in. */
  legacyMigrated: boolean;
}

export interface FirstRunGuideState extends FirstRunGuideContext {
  open: boolean;
  /** Hidden while the person finishes the current step on another page. */
  parked: boolean;
  /** Bumps on every open so the guide restarts from a clean state. */
  session: number;
}

let state: FirstRunGuideState = {
  open: false,
  parked: false,
  session: 0,
  manual: false,
  migration: false,
  legacyMigrated: false,
};
const listeners = new Set<() => void>();

function emit(next: FirstRunGuideState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function openFirstRunGuide(context: FirstRunGuideContext): void {
  emit({ ...context, open: true, parked: false, session: state.session + 1 });
}

export function closeFirstRunGuide(): void {
  if (state.open) emit({ ...state, open: false, parked: false });
}

export function parkFirstRunGuide(): void {
  if (state.open && !state.parked) emit({ ...state, parked: true });
}

export function resumeFirstRunGuide(): void {
  if (state.open && state.parked) emit({ ...state, parked: false });
}

export function getFirstRunGuideState(): FirstRunGuideState {
  return state;
}

export function useFirstRunGuide(): FirstRunGuideState {
  return useSyncExternalStore((listener) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, getFirstRunGuideState);
}

export type FirstRunGuideStepId = 'legacy' | 'intro' | 'migration' | 'models' | 'import' | 'finish';

export interface FirstRunGuideFacts {
  /** Signed in to an account (the Migration Assistant needs one). */
  cloud: boolean;
  /** A model was already usable when the guide opened. */
  hadModel: boolean;
  /** Tasks of other AI tools or importable agents were found on this computer. */
  hasLocalContent: boolean;
}

/**
 * The steps this person sees, in order. A returning user (another computer to migrate from,
 * or earlier-version data) is not introduced to the product again; a step with nothing to do
 * is left out instead of shown empty. Opened by hand, the guide offers everything.
 */
export function firstRunGuideSteps(
  context: FirstRunGuideContext,
  facts: FirstRunGuideFacts,
): FirstRunGuideStepId[] {
  const returning = context.migration || context.legacyMigrated;
  const steps: FirstRunGuideStepId[] = [];
  if (context.legacyMigrated) steps.push('legacy');
  if (context.manual || !returning) steps.push('intro');
  if (facts.cloud && (context.manual || context.migration)) steps.push('migration');
  // A new user always sees how models work here (official service and their own plans); a
  // returning user who already has a model does not.
  if (context.manual || !returning || !facts.hadModel) steps.push('models');
  if (context.manual || facts.hasLocalContent) steps.push('import');
  steps.push('finish');
  return steps;
}
