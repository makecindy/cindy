/**
 * Consume a forge-pack integrity ticket at inspect / install.
 *
 * Pack tickets are one-shot: the first inspect attempt consumes them.
 * A matching hash + manifest.id issues an install continuation; mismatch
 * deletes staging immediately. Renderer only ever sees the continuation
 * token — never origin. No ticket ⇒ receipt origin is `manual`.
 *
 * `operationKind` on the pack ticket is a hint, not a reject condition.
 * Real install-vs-update classification happens after the install lock.
 */
import type { ActiveAppSession } from '../appSessionState.js';
import type { ForgePackIntegrityTicket, ForgePackStagingController } from './forgePackStaging.js';

export type ForgePackInspectConsume =
  | { kind: 'not-forge' }
  | { kind: 'accepted'; packTicket: string }
  | { kind: 'rejected'; reason: string };

export type ForgePackInstallConsume =
  | { kind: 'manual' }
  | { kind: 'agent-forge'; ticket: ForgePackIntegrityTicket }
  | { kind: 'rejected'; reason: string };

function sameOwner(a: ActiveAppSession, b: ActiveAppSession): boolean {
  return a.mode === b.mode && a.dataOwnerId === b.dataOwnerId && a.generation === b.generation;
}

export function consumeForgePackAtInspect(
  controller: ForgePackStagingController,
  input: {
    filePath: string;
    packageSha256: string;
    manifestId: string;
    currentOwner: ActiveAppSession;
    boundaryPending: boolean;
  },
): ForgePackInspectConsume {
  if (input.boundaryPending) {
    // Short account-switch window: do not consume the pack ticket. The user
    // can retry inspect on the same staging file after the owner is stable.
    const existing = controller.peekMatchingStagingPath(input.filePath);
    if (!existing && !controller.wasStagingPathConsumed(input.filePath)) {
      return { kind: 'not-forge' };
    }
    return { kind: 'rejected', reason: 'session-boundary-pending' };
  }
  if (controller.wasStagingPathConsumed(input.filePath)) {
    return { kind: 'rejected', reason: 'ticket-replay' };
  }
  const ticket = controller.consumeMatchingStagingPath(input.filePath);
  if (!ticket) return { kind: 'not-forge' };
  if (!sameOwner(ticket.owner, input.currentOwner)) {
    controller.releaseStaging(ticket.stagingPath);
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  if (ticket.packageSha256 !== input.packageSha256 || ticket.manifestId !== input.manifestId) {
    controller.releaseStaging(ticket.stagingPath);
    return { kind: 'rejected', reason: 'ticket-binding-mismatch' };
  }
  const packTicket = controller.issueInstallContinuation(ticket);
  if (!packTicket) {
    return { kind: 'rejected', reason: 'ticket-expired' };
  }
  return { kind: 'accepted', packTicket };
}

export function consumeForgePackAtInstall(
  controller: ForgePackStagingController,
  input: {
    packTicket: string | undefined;
    packageSha256: string;
    manifestId: string;
    currentOwner: ActiveAppSession;
    boundaryPending: boolean;
  },
): ForgePackInstallConsume {
  if (!input.packTicket) return { kind: 'manual' };
  if (input.boundaryPending) {
    // Caller should only reach here without a stable mutation lease. Do not
    // consume the continuation — the same owner can retry after the window.
    return { kind: 'rejected', reason: 'session-boundary-pending' };
  }
  const ticket = controller.consumeInstallContinuation(input.packTicket);
  if (!ticket) return { kind: 'rejected', reason: 'ticket-replay' };
  if (!sameOwner(ticket.owner, input.currentOwner)) {
    controller.releaseStaging(ticket.stagingPath);
    return { kind: 'rejected', reason: 'owner-mismatch' };
  }
  if (ticket.packageSha256 !== input.packageSha256 || ticket.manifestId !== input.manifestId) {
    controller.releaseStaging(ticket.stagingPath);
    return { kind: 'rejected', reason: 'ticket-binding-mismatch' };
  }
  return { kind: 'agent-forge', ticket };
}

export function abandonForgePackInstall(
  controller: ForgePackStagingController,
  packTicket: string,
): void {
  const ticket = controller.consumeInstallContinuation(packTicket);
  if (ticket) controller.releaseStaging(ticket.stagingPath);
}
