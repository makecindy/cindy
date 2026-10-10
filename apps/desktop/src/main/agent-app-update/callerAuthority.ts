import type { SendOrigin } from '@cindy/maker-core';

import type { InteractionRoute } from '../maker-ipc/interactionRouter.js';

export interface AppUpdateCallerFacts {
  /** The calling task is executing the turn that issued this tool call. */
  turnRunning: boolean;
  /** maker-core product origin of that turn (null for ordinary Desktop input). */
  turnOrigin: SendOrigin | null;
  /** Live IM / hook route, if the turn came from a channel. */
  route: Pick<InteractionRoute, 'origin' | 'requesterAuthority'> | null;
  /** Coordinator evidence that the active Desktop/phone input was typed by the owner. */
  ownerAuthoredInput: () => boolean;
}

/**
 * Only a turn the account owner started may raise an app-update card. Positive
 * evidence is required from exactly one source; anything automated, delegated or
 * unproven is refused before the card exists:
 *
 * - scheduler / goal turns (maker-core origin) — never;
 * - IM / official-bot turns — the channel's owner check for the triggering
 *   message (`route.requesterAuthority`);
 * - Desktop / same-account phone turns — the coordinator's active input must be
 *   owner-typed text (not another task, Orca, plugin, shared-task guest or resume).
 */
export function isAppUpdateOwnerTurn(facts: AppUpdateCallerFacts): boolean {
  if (!facts.turnRunning) return false;
  const origin = facts.turnOrigin;
  if (origin && origin.kind !== 'user') return false;
  const route = facts.route;
  if (route) {
    if (route.origin.kind === 'im' || route.origin.kind === 'hook') {
      return route.requesterAuthority === 'owner';
    }
    if (route.origin.kind !== 'desktop') return false;
  } else if (origin?.surface === 'im') {
    // An IM turn always owns a route; without one its sender is unproven.
    return false;
  }
  return facts.ownerAuthoredInput();
}
