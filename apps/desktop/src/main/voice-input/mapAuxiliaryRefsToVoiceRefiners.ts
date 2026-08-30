/**
 * Map the shared auxiliary-model chain onto BYOK voice-refiner transports.
 *
 * Claude Messages / Haiku catalog pins have no voice-refiner transport and are
 * skipped. An empty result means "do not refine".
 */

import { parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import { UTILITY_MODEL_PROFILES } from '../../shared/utilityModelProfiles.js';
import {
  isVoiceInputRefinerProviderKind,
  type VoiceInputRefinerProviderKind,
} from '../../shared/voiceInputRefinerProfiles.js';

export function mapAuxiliaryRefToVoiceRefiner(ref: string): VoiceInputRefinerProviderKind | null {
  const parsed = parseAuxiliaryModelRef(ref);
  if (!parsed) return null;
  if (parsed.kind === 'profile') {
    return isVoiceInputRefinerProviderKind(parsed.id) ? parsed.id : null;
  }
  if (parsed.route.agentKind === 'claude-code' || parsed.route.providerId === 'anthropic') {
    return null;
  }
  if (parsed.route.providerId === 'openai') {
    for (const profile of Object.values(UTILITY_MODEL_PROFILES)) {
      if (profile.transport === 'codex-responses' && profile.model === parsed.route.model) {
        return isVoiceInputRefinerProviderKind(profile.id) ? profile.id : null;
      }
    }
    return null;
  }
  if (parsed.route.providerId === 'xd') {
    for (const profile of Object.values(UTILITY_MODEL_PROFILES)) {
      if (profile.transport === 'litellm-chat-completions' && profile.model === parsed.route.model) {
        return isVoiceInputRefinerProviderKind(profile.id) ? profile.id : null;
      }
    }
  }
  return null;
}

export function mapAuxiliaryRefsToVoiceRefiners(
  refs: readonly string[],
): VoiceInputRefinerProviderKind[] {
  const out: VoiceInputRefinerProviderKind[] = [];
  for (const ref of refs) {
    const mapped = mapAuxiliaryRefToVoiceRefiner(ref);
    if (mapped && !out.includes(mapped)) out.push(mapped);
  }
  return out;
}
