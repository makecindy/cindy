/**
 * Remaining quota on the macOS Agent Island, taken from the menu bar quota overview.
 *
 * The island shows what the menu bar panel shows, in the same order and with the same
 * visibility and privacy masking, so it reuses the overview's built view instead of reading
 * usage again. It holds the overview only while the island is switched on.
 */

import { CINDY_MARK_PATH, CINDY_MARK_TRANSFORM } from '@cindy/model-providers/branding';

import { getAgentIslandQuotaChipWidth, type AgentIslandQuotaItem } from '../../shared/agentIsland.js';
import type { MenubarView } from '../../shared/menubarQuota.js';
import { MENUBAR_CINDY_LOGO } from '../menubar/logos.js';
import type { QuotaOverviewService } from '../quota-overview/service.js';
import type { AgentIslandService } from './service.js';

/** The menu bar helper draws the Cindy mark from a sentinel; the island gets the real SVG. */
const CINDY_LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24"><path fill="#000" fill-rule="evenodd" transform="${CINDY_MARK_TRANSFORM}" d="${CINDY_MARK_PATH}"/></svg>`;

/** Sources with a level to show, as the iPhone widgets pick them; pay-as-you-go and unread ones have none. */
export function buildAgentIslandQuota(view: MenubarView | null): AgentIslandQuotaItem[] {
  if (!view || view.gate) return [];
  const items: AgentIslandQuotaItem[] = [];
  for (const cell of view.sources) {
    if (cell.kind === 'payg' || cell.fill === null) continue;
    const text = cell.value !== null ? `${cell.value}${cell.valueUnit ?? ''}` : (cell.valueLabel ?? '');
    if (!text) continue;
    items.push({
      id: cell.id,
      logoSvg: cell.logoSvg === MENUBAR_CINDY_LOGO ? CINDY_LOGO_SVG : cell.logoSvg,
      text,
      level: cell.level,
      stale: cell.stale === true,
      accessibilityLabel: cell.accessibilityLabel,
      width: getAgentIslandQuotaChipWidth(text),
    });
  }
  return items;
}

/** Feeds the island from the overview while the island is on; returns the stop function. */
export function startAgentIslandQuota(island: AgentIslandService, overview: QuotaOverviewService): () => void {
  let release: (() => void) | null = null;
  let unsubscribe: (() => void) | null = null;
  const sync = (enabled: boolean) => {
    if (enabled && !release) {
      // Subscribed first, so the first build after acquiring reaches the island.
      unsubscribe = overview.subscribe((build) => island.setQuota(buildAgentIslandQuota(build.view)));
      release = overview.acquire();
      island.setQuota(buildAgentIslandQuota(overview.latest()?.view ?? null));
    } else if (!enabled && release) {
      release();
      unsubscribe?.();
      release = null;
      unsubscribe = null;
      island.setQuota([]);
    }
  };
  const offEnabled = island.subscribeEnabled(sync);
  sync(island.isEnabled());
  return () => {
    offEnabled();
    sync(false);
  };
}
