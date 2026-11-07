/**
 * The `/` palette's Skill roster snapshot, shared by every window and every IPC
 * caller.
 *
 * Main owns the invalidation: SkillHub activation, Ghost install/toggle/remove and
 * Pi package changes each clear it where they announce the change, because those
 * announcements cannot reach a renderer whose composer is unmounted — the user is on
 * `/skillhub` or `/plugins` while the change happens. Renderer listeners still force
 * a reload so an open palette refreshes at once.
 *
 * Entries are scoped to the active data owner so a switch never serves one owner's
 * plugin Skills to the next.
 */
import type { AgentSkillCommand } from '@cindy/maker-core';

import { activeOwnerScopeKey } from '../appSessionState.js';
import { createPaletteDiscoveryReuse } from './paletteDiscoveryReuse.js';

export type PaletteSkillListing = { success: true; skills: AgentSkillCommand[] };

export const paletteSkillListReuse = createPaletteDiscoveryReuse<PaletteSkillListing>({
  ttlMs: 30_000,
  scope: activeOwnerScopeKey,
});

/** What the read that just assembled a roster learned about its own completeness. */
export interface PaletteSkillListCacheFacts {
  /** Project-link and global-asset preparation reported a warning or a failure. */
  preparationClean: boolean;
  /** The scan itself reported an unreadable root. */
  scanClean: boolean;
  /** The active data owner is still the one the read started under. */
  ownerStable: boolean;
  /** An owner transition is still pending. */
  boundaryPending: boolean;
  /** A read-only Device Link caller scanned us instead of a local palette. */
  readOnlyRemote: boolean;
}

/**
 * Only a roster whose every step reported success may be reused.
 *
 * Each input here is a way a listing can come back looking complete while missing
 * Skills, and a cached partial roster hides them for the whole window:
 * - preparation warnings (a Skill that could not be linked into the scanned root),
 * - scan errors (an unreadable root),
 * - an owner switch mid-read, or one still pending (`activeOwnerScopeKey()` reports
 *   the outgoing owner until it settles),
 * - a read-only Device Link scan, which skips local project-link preparation, so its
 *   listing can lack the Skills the next local open would have linked — and that local
 *   open would hit this entry instead of preparing.
 */
export function shouldCachePaletteSkillListing(facts: PaletteSkillListCacheFacts): boolean {
  return (
    facts.preparationClean
    && facts.scanClean
    && facts.ownerStable
    && !facts.boundaryPending
    && !facts.readOnlyRemote
  );
}
