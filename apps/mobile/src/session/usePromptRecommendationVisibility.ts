import { useCallback, useState } from 'react';

/** Presentation only: editing never consumes the host's recommendation. */
export function usePromptRecommendationVisibility(scope: string, draft: string, active: boolean) {
  const [state, setState] = useState({ scope, draft, active, hidden: active || draft.length > 0 });
  if (state.scope !== scope || state.draft !== draft || state.active !== active) {
    // Reconcile before committing children: no one-frame flash on focus/typing.
    // A collapse restores even a nonempty draft; deleting the final character
    // restores while focused. A fresh focus/expand always hides first.
    const hidden = state.scope !== scope ? active || draft.length > 0
      : state.active !== active ? active
        : draft.length > 0;
    setState({ scope, draft, active, hidden });
  }
  const hide = useCallback(() => setState((current) => ({ ...current, hidden: true })), []);
  return { visible: !state.hidden, hide };
}
