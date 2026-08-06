import {
  DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND,
  type VoiceInputRefinerProfile,
  type VoiceInputRefinerProviderKind,
  type VoiceInputRefinerTransport,
} from '../../shared/voiceInputRefinerProfiles.js';
import type { VoiceInputProviderChainSource } from './VoiceInputModelSelection.js';
import { orderVoiceInputProvidersByHealth } from './VoiceInputProviderHealth.js';

const CODEX_GPT_MINI: VoiceInputRefinerProviderKind = 'codex-gpt-5.4-mini';
const LITELLM_GPT_MINI: VoiceInputRefinerProviderKind = 'litellm-gpt-5.4-mini';
const LITELLM_KIMI: VoiceInputRefinerProviderKind = 'litellm-kimi-k2.6';
const LITELLM_DEEPSEEK: VoiceInputRefinerProviderKind = 'litellm-deepseek-v4-flash';

const DEFAULT_REFINER_ORDER_WITH_CODEX: readonly VoiceInputRefinerProviderKind[] = [
  CODEX_GPT_MINI,
  LITELLM_KIMI,
  LITELLM_GPT_MINI,
  LITELLM_DEEPSEEK,
];

const DEFAULT_REFINER_ORDER_WITHOUT_CODEX: readonly VoiceInputRefinerProviderKind[] = [
  LITELLM_GPT_MINI,
  LITELLM_KIMI,
  LITELLM_DEEPSEEK,
  CODEX_GPT_MINI,
];

// TODO(unified-model-catalog): voice refiner routing stays on the legacy profile until utility metadata lands.
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
 * Runtime policy for the built-in refiner pool:
 * - Codex ready: keep Codex first, use Kimi as the heterogeneous fallback.
 * - Codex unavailable: use LiteLLM GPT first, then Kimi.
 *
 * Explicit user/provider-chain choices keep their configured order. Cooldown is
 * applied after this policy so a recently failed provider still moves behind
 * healthy candidates.
 */
export function orderVoiceInputRefinerChainForRuntime(
  selection: VoiceInputRefinerRoutingSelection,
  readinessList: readonly VoiceInputRefinerRoutingReadiness[],
): VoiceInputRefinerProviderKind[] {
  const configured = [...selection.refinerProviderChain];
  const policyOrdered = isBuiltInDefaultRefinerSelection(selection)
    ? orderDefaultRefinerChainByReadiness(configured, readinessList)
    : configured;
  return orderVoiceInputProvidersByHealth('refiner', policyOrdered);
}

function orderDefaultRefinerChainByReadiness(
  configured: readonly VoiceInputRefinerProviderKind[],
  readinessList: readonly VoiceInputRefinerRoutingReadiness[],
): VoiceInputRefinerProviderKind[] {
  const codexReady = readinessList.some((readiness) =>
    readiness.provider === CODEX_GPT_MINI && readiness.ok,
  );
  const preferred = codexReady
    ? DEFAULT_REFINER_ORDER_WITH_CODEX
    : DEFAULT_REFINER_ORDER_WITHOUT_CODEX;
  const configuredSet = new Set(configured);
  const ordered = preferred.filter((provider) => configuredSet.has(provider));
  for (const provider of configured) {
    if (!ordered.includes(provider)) ordered.push(provider);
  }
  return ordered;
}

function isBuiltInDefaultRefinerSelection(selection: VoiceInputRefinerRoutingSelection): boolean {
  if (selection.refinerProvider !== DEFAULT_VOICE_INPUT_REFINER_PROVIDER_KIND) return false;
  return selection.refinerProviderChainSource === 'default';
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
