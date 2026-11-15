import { getActiveCatalog } from './active-catalog.js';
import { shouldApplyExclusiveProviderReroute } from './model-route-guard.js';

/**
 * The exclusive-provider reroute decision against the live catalog. Kept apart from
 * model-route-guard-live.ts (which loads the desktop provider service and, through it, Electron) so
 * that sessionAgentSwitchHandler.ts loads in the Node Host; model-route-guard-live.ts re-exports it.
 */
export function shouldApplyExclusiveProviderRerouteLive(
  providerId: string | null | undefined,
): boolean {
  return shouldApplyExclusiveProviderReroute(providerId, getActiveCatalog().providers);
}
