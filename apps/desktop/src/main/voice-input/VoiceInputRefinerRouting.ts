import {
  type VoiceInputRefinerProfile,
  type VoiceInputRefinerProviderKind,
  type VoiceInputRefinerTransport,
} from '../../shared/voiceInputRefinerProfiles.js';
import type { VoiceInputProviderChainSource } from './VoiceInputModelSelection.js';
import { orderVoiceInputProvidersByHealth } from './VoiceInputProviderHealth.js';

export type VoiceInputRefinerRoutingSelection = {
  refinerProvider: VoiceInputRefinerProviderKind;
  refinerProviderChain: readonly VoiceInputRefinerProviderKind[];
  refinerProviderChainSource: VoiceInputProviderChainSource;
};

export type VoiceInputRefinerRoutingReadiness = {
  provider: VoiceInputRefinerProviderKind;
  ok: boolean;
};

/**
 * Keep the configured auxiliary-model order. Health cooldown may move a recently
 * failed provider behind healthy candidates. Do not reorder by Codex readiness.
 */
export function orderVoiceInputRefinerChainForRuntime(
  selection: VoiceInputRefinerRoutingSelection,
  _readinessList: readonly VoiceInputRefinerRoutingReadiness[],
): VoiceInputRefinerProviderKind[] {
  return orderVoiceInputProvidersByHealth('refiner', [...selection.refinerProviderChain]);
}

/**
 * Distinct transports to warm before a dictation, in chain order.
 *
 * Prewarming only the chain head leaves the fallback transport with a cold
 * connection pool: when the head fails at request time, the rescue attempt
 * pays TLS setup inside the per-attempt idle watchdog and can time out on
 * networks where the handshake alone is slow. Warming every transport that
 * appears in the chain (two today: codex-responses, litellm-chat-completions)
 * keeps the rescue path as warm as the primary at the cost of at most one
 * extra HEAD request per prewarm.
 */
export function collectRefinerPrewarmTransports(
  profiles: readonly VoiceInputRefinerProfile[],
): VoiceInputRefinerTransport[] {
  const transports: VoiceInputRefinerTransport[] = [];
  for (const profile of profiles) {
    if (!transports.includes(profile.transport)) transports.push(profile.transport);
  }
  return transports;
}
