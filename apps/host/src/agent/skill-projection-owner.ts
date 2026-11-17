/**
 * Who publishes the Skill projection owner on a Host profile (release table row 25, 25b; reviewer
 * decision (a)).
 *
 * Under option A the window commits the owner and the Host joins it. A Host on its own profile has
 * no window, so `cindy-host login` commits there, as the desktop's sign-in does, and the resident
 * process (serve) never does: serve injects a refusal before it loads anything that reads the
 * boundary (guarded, so the injection cannot go missing), login injects the allowance.
 *
 * The owner transition's disk part is the desktop's: before a different owner becomes visible, the
 * Ghost Skill links of every owner projection root are revoked (desktop suspendAllGhosts:
 * removeGhostSkillLinksForRoots over listGhostOwnerProjectionRoots, with the shared-roots lock), and
 * a blocker aborts. The runtime part of the desktop's teardown has no counterpart: login requires
 * that no account runtime of another owner is running (login-cli.mjs), and Pi durable Subagent
 * runners end with the Host (release table, m1-cp18c2).
 */
import path from 'node:path';

import {
  configureProjectionBoundaryOwnerCommit,
  isGhostSkillProjectionBoundaryStableForOwner,
  withSharedSkillRootsLock,
  withStableOwnerBoundaryMutation,
} from '../../../desktop/src/main/authBoundaryQuarantine.ts';
import { ghostSkillPluginRoot, removeGhostSkillLinksForRoots } from '../../../desktop/src/main/cindy-brain/skillSlot.ts';
import { ownerScopedPath } from '../../../desktop/src/main/dataOwnerPath.ts';
import { listLegacyOwnerProjectionRoots } from '../../../desktop/src/main/ownerProjectionRoots.ts';

/** serve: this process never publishes the projection owner. */
export function refuseSkillProjectionOwnerCommit(): void {
  configureProjectionBoundaryOwnerCommit(() => false);
}

/** `cindy-host login`: the one party that publishes the owner of a Host's own profile. */
export function allowSkillProjectionOwnerCommit(): void {
  configureProjectionBoundaryOwnerCommit(() => true);
}

/**
 * The desktop's listGhostOwnerProjectionRoots (cindy-brain/index.ts) for an explicit owner: that
 * owner's brain, cindy-brain and ghost-install-state, plus every legacy and per-owner root.
 */
export function ghostOwnerProjectionRoots(userDataDir: string, ownerId: string | null): string[] {
  return [...new Set([
    ...(ownerId ? ['brain', 'cindy-brain', 'ghost-install-state'].map(part => ownerScopedPath(userDataDir, ownerId, part)) : []),
    ...listLegacyOwnerProjectionRoots(userDataDir),
  ])];
}

/**
 * Revoke the Ghost Skill links of an outgoing owner, as the desktop's suspendAllGhosts does.
 * Throws when a link could not be inspected or removed (the account boundary must not proceed).
 */
export async function revokeOwnerSkillProjections(userDataDir: string, ownerId: string | null): Promise<{ warnings: string[] }> {
  const roots = ghostOwnerProjectionRoots(userDataDir, ownerId);
  const cleanup = await removeGhostSkillLinksForRoots(roots, undefined,
    roots.map(root => path.join(ghostSkillPluginRoot(root), 'skills')),
    withSharedSkillRootsLock);
  if (cleanup.blockers.length > 0) throw new Error(`ghost owner skill cleanup incomplete (${cleanup.blockers.length})`);
  return { warnings: cleanup.warnings };
}

export type LogoutSkillSweep = 'revoked' | 'skipped-profile-held' | 'skipped-not-stable' | 'failed';

/**
 * serve's logout (reviewer decision (ii)): the desktop clears an outgoing owner's projections when it
 * signs out; serve cannot commit, so it runs the same disk sweep inside a stable-owner mutation
 * instead, and the boundary stays stable(owner) until the next `cindy-host login` transitions it.
 *
 * - A desktop that opens this profile's database is running (the input queue's hold): the shared
 *   projections are that desktop's; nothing is swept and the logout itself still succeeds.
 * - The boundary is no longer stable for this owner: in client mode the window signed out first and
 *   its own transition already swept, so serve does nothing (each side acts only on stable(owner),
 *   under the same owner lock; a second sweep finds nothing to remove).
 * Never throws: logout must not be refused by this step.
 */
export async function sweepOwnerSkillProjectionsAtLogout(input: {
  userDataDir: string;
  ownerId: string;
  isProfileHeld(): boolean;
  warn(message: string, fields: { outcome: LogoutSkillSweep }): void;
}): Promise<LogoutSkillSweep> {
  if (input.isProfileHeld()) {
    input.warn('skill projection sweep skipped at logout: a desktop is using this profile', { outcome: 'skipped-profile-held' });
    return 'skipped-profile-held';
  }
  if (!isGhostSkillProjectionBoundaryStableForOwner(input.ownerId)) {
    input.warn('skill projection sweep skipped at logout: the boundary is no longer this owner\'s', { outcome: 'skipped-not-stable' });
    return 'skipped-not-stable';
  }
  try {
    await withStableOwnerBoundaryMutation(input.ownerId, () => revokeOwnerSkillProjections(input.userDataDir, input.ownerId));
    return 'revoked';
  } catch {
    // Includes the boundary changing between the check above and the locked re-check.
    input.warn('skill projection sweep at logout did not run to completion', { outcome: 'failed' });
    return 'failed';
  }
}

/**
 * `cindy-host login`'s session save and owner commit, in the desktop's order (authManager
 * completeLogin → commitDesktopLoginSessions): under the account vault's cross-process lock, save the
 * session, then publish the owner through the boundary's transition; if the commit fails, put the
 * previous session record back (or remove the new one) before the lock is released.
 *
 * The transition's teardown is the disk part of the desktop's (revokeOwnerSkillProjections for the
 * outgoing owner); the boundary module writes quarantine and pending first and keeps them on failure.
 * previousOwnerId is the owner the boundary last published, else the profile's single account
 * database, else none; a wrong guess still forces a transition (the boundary compares it).
 */
export async function commitLoginSessionAndOwner(input: {
  userDataDir: string;
  record: string;
  nextOwnerId: string;
  store: { read(key: string): string | null; write(key: string, value: string): void; remove(key: string): void };
  sessionKey: string;
  previousOwnerId: string | null;
  withVaultLock<T>(task: () => Promise<T>): Promise<T>;
  commitOwner(options: {
    previousOwnerId: string | null;
    nextOwnerId: string;
    prepareTransition(context: { ownerChanged: boolean }): Promise<void>;
    commit(): void;
  }): Promise<void>;
}): Promise<void> {
  await input.withVaultLock(async () => {
    const previousRecord = input.store.read(input.sessionKey);
    input.store.write(input.sessionKey, input.record);
    try {
      await input.commitOwner({
        previousOwnerId: input.previousOwnerId,
        nextOwnerId: input.nextOwnerId,
        // Revoke every owner projection root's Ghost Skill links, outgoing owner included, as the
        // desktop's suspendAllGhosts at an account boundary (also on a same-owner repair).
        prepareTransition: async () => { await revokeOwnerSkillProjections(input.userDataDir, input.previousOwnerId); },
        commit: () => undefined,
      });
    } catch (error) {
      if (previousRecord === null) input.store.remove(input.sessionKey);
      else input.store.write(input.sessionKey, previousRecord);
      throw error;
    }
  });
}
