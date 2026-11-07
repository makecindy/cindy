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
