/**
 * Decides when a Cindy window becoming visible should flash the keyboard.
 *
 * Any transition from hidden/minimized to visible counts, including the
 * first appearance after create. Focus changes while the window stays on
 * screen do not.
 */
export interface WorkLouderCodexWindowRevealGate {
  wasHidden: boolean;
}

export function createWorkLouderCodexWindowRevealGate(): WorkLouderCodexWindowRevealGate {
  return { wasHidden: true };
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
  const play = gate.wasHidden;
  gate.wasHidden = false;
  return play;
}
