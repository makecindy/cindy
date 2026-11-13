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

/**
 * Entry identity for one palette read.
 *
 * `runtimeGeneration` is the live Pi catalog generation the listing was merged from:
 * a fork or a `switch_session` replaces that catalog without changing the session id,
 * so without it a reopened palette would keep serving the pre-fork command — and a
 * still-`loaded` status also stops the dispatch retry from correcting it.
 */
export function paletteSkillListReuseKey(fields: {
  agentKind: string;
  workingDir?: string;
  sessionId?: string;
  remoteHostId?: string;
  runtimeGeneration?: number;
}): string {
  return JSON.stringify([
    fields.agentKind,
    fields.workingDir ?? null,
    fields.sessionId ?? null,
    fields.remoteHostId ?? null,
    fields.runtimeGeneration ?? null,
  ]);
}

/** Reuse window for one `/` palette Skill roster. */
export const PALETTE_SKILL_LIST_REUSE_MS = 30_000;

export const paletteSkillListReuse = createPaletteDiscoveryReuse<PaletteSkillListing>({
  ttlMs: PALETTE_SKILL_LIST_REUSE_MS,
  scope: activeOwnerScopeKey,
});

/** What the read that just assembled a roster learned about its own completeness. */
export interface PaletteSkillListCacheFacts {
  /** Project-link and global-asset preparation reported a warning or a failure. */
  preparationClean: boolean;
  /** The scan itself reported an unreadable root. */
  scanClean: boolean;
  /** The scan left out a source that can recover on retry (e.g. a package inspection over budget). */
  scanComplete: boolean;
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
 * - a scan that skipped a recoverable source without reporting it as an error,
 *   such as a managed Pi package whose inspection hit its budget — the package
 *   store retries that read, but this roster would keep serving the gap,
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
    && facts.scanComplete
    && facts.ownerStable
    && !facts.boundaryPending
    && !facts.readOnlyRemote
  );
}

/**
 * Whether this read may reuse a warm Pi package inspection.
 *
 * Only a plain preview read may: it renders an ephemeral catalog and keeps
 * nothing. A forced reload asks for fresh data — Bot Settings refreshes its
 * capability catalog that way and shows what the user then grants — so it must
 * re-inspect instead of inheriting a warm entry that predates a `pi install`.
 */
export function isPalettePreviewRead(forceReload: unknown): boolean {
  // Any truthy force request asks for fresh data, not just the boolean `true`.
  return !forceReload;
}

/**
 * Reuse window for one roster write, in ms.
 *
 * A roster whose package part was inspected fresh may keep its full window. One
 * that merged a *warm* inspection may not outlive that inspection's own reuse
 * window: that window is the only bound on an install made outside Cindy
 * (`pi install` in a terminal), and a fresh 30-second roster on top would
 * stretch the wait past it — a package installed just after the inspection was
 * computed could stay hidden for ~90 s instead of the promised ~60 s.
 *
 * Returns `undefined` when there is no warm inspection to honor (keep the
 * default window), and `0` when the inspection is already past its window
 * (skip the write — the next open rescans anyway).
 */
export function paletteRosterReuseTtlMs(facts: {
  inspectedAt?: number;
  /** The reuse window the warm inspection was served under, in ms. */
  inspectionReuseMs: number;
  now?: number;
}): number | undefined {
  if (facts.inspectedAt === undefined) return undefined;
  const remaining = facts.inspectedAt + facts.inspectionReuseMs - (facts.now ?? Date.now());
  return Math.max(0, Math.min(PALETTE_SKILL_LIST_REUSE_MS, remaining));
}
