/**
 * Map the shared auxiliary-model chain onto BYOK voice-refiner transports.
 *
 * Claude Messages / Haiku catalog pins have no voice-refiner transport and are
 * skipped. An empty result means "do not refine".
 */

import { parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import {
  getVoiceInputRefinerProfile,
  voiceInputRefinerProviderKindForCatalogRoute,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';

export function mapAuxiliaryRefToVoiceRefiner(ref: string): VoiceInputRefinerProviderKind | null {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'profile') {
    return parsed.id;
  }
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
