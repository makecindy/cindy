/**
 * Decides when a Cindy window reopening should flash the keyboard.
 *
 * First show after create is just the window appearing — not a reopen.
 * After that, only a transition from hidden/minimized back to visible
 * counts. Focus changes while the window stays on screen do not.
 */
export interface WorkLouderCodexWindowRevealGate {
  hasBeenShown: boolean;
  wasHidden: boolean;
}

export function createWorkLouderCodexWindowRevealGate(): WorkLouderCodexWindowRevealGate {
  return { hasBeenShown: false, wasHidden: true };
}

/** True when the window just became visible after having been hidden. */
export function noteWorkLouderCodexWindowVisibility(
  gate: WorkLouderCodexWindowRevealGate,
  nowVisible: boolean,
): boolean {
  if (!nowVisible) {
    gate.wasHidden = true;
    return false;
  }
  const play = gate.hasBeenShown && gate.wasHidden;
  gate.hasBeenShown = true;
  gate.wasHidden = false;
  return play;
}
