/**
 * Map the shared auxiliary-model chain onto BYOK voice-refiner transports.
 *
 * Claude Messages / Haiku catalog pins have no voice-refiner transport and are
 * skipped. An empty result means "do not refine".
 */

import { isModelSelectableForNewRoute } from '@cindy/model-providers';

import { parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import {
  CATALOG_MODEL_PIN_PREFIX,
  decodeCatalogModelPin,
  type CatalogModelPinRoute,
} from '../../shared/catalogModelPin.js';
import { getActiveCatalog } from '../maker-host/active-catalog.js';
import {
  getVoiceInputRefinerProfile,
  voiceInputRefinerProviderKindForCatalogRoute,
  type VoiceInputRefinerProfile,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';

/**
 * Catalog pins are persisted across catalog refreshes, so membership must be
 * checked again before a voice route is admitted. This keeps voice refinement
 * fail-closed when a model is retired, disabled, or loses paid availability.
 */
function isActiveCatalogVoiceRoute(route: CatalogModelPinRoute): boolean {
  const provider = getActiveCatalog().providers.find((entry) => entry.id === route.providerId);
  const routing = provider?.routing[route.agentKind];
  if (
    !provider
    || !provider.agents.includes(route.agentKind)
    || !routing
    || routing.disabled
  ) return false;
  const model = provider.models[route.agentKind]?.find((entry) => entry.id === route.model);
  return Boolean(
    model
    && isModelSelectableForNewRoute(model, { userProvider: provider.source === 'user' }),
  );
}

/**
 * Re-check a retained catalog refiner profile against the live catalog. Voice
 * refinement can be dispatched long after the profile was first resolved.
 * Static utility profiles remain valid without a catalog lookup.
 */
export function isActiveCatalogVoiceRefinerProfile(
  profile: Pick<VoiceInputRefinerProfile, 'id'>,
): boolean {
  if (!profile.id.startsWith(CATALOG_MODEL_PIN_PREFIX)) return true;
  const route = decodeCatalogModelPin(profile.id);
  return Boolean(route && isActiveCatalogVoiceRoute(route));
}

export function mapAuxiliaryRefToVoiceRefiner(ref: string): VoiceInputRefinerProviderKind | null {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'profile') {
    return parsed.id;
  }
  if (!isActiveCatalogVoiceRoute(parsed.route)) return null;
  return voiceInputRefinerProviderKindForCatalogRoute(parsed.route);
}

export function mapAuxiliaryRefsToVoiceRefiners(
  refs: readonly string[],
): VoiceInputRefinerProviderKind[] {
  const out: VoiceInputRefinerProviderKind[] = [];
  for (const ref of refs) {
    const mapped = mapAuxiliaryRefToVoiceRefiner(ref);
    if (!mapped) continue;
    const mappedProfile = getVoiceInputRefinerProfile(mapped);
    const duplicate = out.some((existing) => {
      const existingProfile = getVoiceInputRefinerProfile(existing);
      return existingProfile.transport === mappedProfile.transport
        && existingProfile.model === mappedProfile.model;
    });
    if (!duplicate) out.push(mapped);
  }
  return out;
}
