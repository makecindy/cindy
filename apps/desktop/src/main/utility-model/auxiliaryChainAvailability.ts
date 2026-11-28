/**
 * Static usability of each auxiliary-chain candidate, with the reason a user can act on.
 *
 * Uses the same predicates as the Settings picker (buildTextOneshotPinOptions and the
 * profile checks in auxiliary-model-settings.ts), so "unavailable" here means the
 * request path would skip the candidate before reaching a model. Credentials are
 * probed, never read or returned.
 */

import { isModelDisabled, isProviderDisabled, type Catalog, type ModelDisableOverrides } from '@cindy/model-providers';

import { parseAuxiliaryModelRef } from '../../shared/auxiliaryModelChain.js';
import type { AuxiliaryModelHealthCandidate, AuxiliaryModelIssue } from '../../shared/auxiliaryModelHealth.js';
import { getUtilityModelProfile } from '../../shared/utilityModelProfiles.js';
import { buildTextOneshotPinOptions, type OneshotCredentialProbe } from './textOneshotPinOptions.js';

/** `issue: null` = usable now. */
export type AuxiliaryChainCandidateStatus =
  Omit<AuxiliaryModelHealthCandidate, 'issue'> & { issue: AuxiliaryModelIssue | null };

export interface AuxiliaryChainAvailabilityInput {
  refs: readonly string[];
  catalog: Catalog;
  overrides: ModelDisableOverrides | undefined;
  providerOrder?: readonly string[];
  hasCredential: OneshotCredentialProbe;
  /** Cindy AI entitlement gate for one model on one agent. */
  isCindyAiPaymentRequired: (model: string, agentKind: 'codex' | 'claude-code' | 'pi') => boolean;
  /** Display name of the Cindy AI provider in the current locale. */
  cindyAiName: string;
}

/** Local candidates in chain order; routes pinned to another computer are not run by this chain. */
export function evaluateAuxiliaryChainAvailability(input: AuxiliaryChainAvailabilityInput): AuxiliaryChainCandidateStatus[] {
  const usable = new Set(buildTextOneshotPinOptions(
    input.catalog, input.overrides, input.providerOrder, input.hasCredential, 'auxiliary',
  ).map((option) => option.id));
  const routable = new Map(buildTextOneshotPinOptions(
    input.catalog, input.overrides, input.providerOrder, undefined, 'auxiliary',
  ).map((option) => [option.id, option]));
  const providerName = (providerId: string): string => providerId === 'xd'
    ? input.cindyAiName
    : input.catalog.providers.find((provider) => provider.id === providerId)?.name ?? providerId;

  const out: AuxiliaryChainCandidateStatus[] = [];
  for (const ref of input.refs) {
    const parsed = parseAuxiliaryModelRef(ref);
    if (!parsed) continue;
    if (parsed.kind === 'profile') {
      const profile = getUtilityModelProfile(parsed.id);
      const providerId = profile.transport === 'codex-responses' ? 'openai' : 'xd';
      const provider = input.catalog.providers.find((item) => item.id === providerId);
      const label = `${profile.model} · ${providerName(providerId)}`;
      let issue: AuxiliaryModelIssue | null = null;
      if (isProviderDisabled(input.overrides, providerId)) issue = 'provider_disabled';
      else if (isModelDisabled(input.overrides, providerId, profile.model)) issue = 'model_disabled';
      else if (!provider || !input.hasCredential(provider, 'codex')) issue = providerId === 'xd' ? 'signed_out' : 'no_credential';
      else if (profile.transport === 'litellm-chat-completions' && input.isCindyAiPaymentRequired(profile.model, 'codex')) issue = 'payment_required';
      out.push({ ref, label, issue });
      continue;
    }
    const { route } = parsed;
    if (route.agentDeviceId) continue;
    const known = routable.get(ref);
    const label = `${known?.modelName ?? route.model} · ${providerName(route.providerId)}`;
    let issue: AuxiliaryModelIssue | null = null;
    if (isProviderDisabled(input.overrides, route.providerId)) issue = 'provider_disabled';
    else if (isModelDisabled(input.overrides, route.providerId, route.model)) issue = 'model_disabled';
    else if (!input.catalog.providers.some((provider) => provider.id === route.providerId)) {
      issue = route.providerId === 'xd' ? 'signed_out' : 'unavailable';
    } else if (!known) issue = 'unavailable';
    else if (!usable.has(ref)) issue = route.providerId === 'xd' ? 'signed_out' : 'no_credential';
    else if (route.providerId === 'xd' && input.isCindyAiPaymentRequired(route.model, route.agentKind)) issue = 'payment_required';
    out.push({ ref, label, issue });
  }
  return out;
}
