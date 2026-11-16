import type { ProviderView } from './registry.js';
import type { AgentKind, CatalogModel } from './types.js';

type VisibleModel = (providerId: string, model: CatalogModel, agent: AgentKind) => boolean;

/** A matching model id does not imply matching controls on another connection. */
function selectableCapabilitiesCoveredBy(source: CatalogModel, target: CatalogModel): boolean {
  return (source.efforts ?? []).every(effort => target.efforts?.includes(effort))
    && (source.reasoningEfforts ?? []).every(effort => target.reasoningEfforts?.includes(effort))
    && source.effortsUnknown === target.effortsUnknown
    && source.thinkingToggle === target.thinkingToggle
    && (!source.supportsFastMode || !!target.supportsFastMode)
    && (!source.supportsUltrafastMode || !!target.supportsUltrafastMode)
    && source.fastModelId === target.fastModelId;
}

/** Browsing may collapse a source only when no selectable capability is lost. */
export function subscriptionModelsCoveredBy(source: ProviderView, target: ProviderView, isVisible?: VisibleModel, targetVisible = isVisible): boolean {
  return source.subscriptionFastPolicy?.allowFast === target.subscriptionFastPolicy?.allowFast
    && source.subscriptionFastPolicy?.groupAllowsFast === target.subscriptionFastPolicy?.groupAllowsFast
    && source.agents.every(agent => (source.models[agent] ?? []).filter(model => !model.disabled && (!isVisible || isVisible(source.id, model, agent))).every(model =>
      target.models[agent]?.some(candidate => candidate.id === model.id && !candidate.disabled
        && selectableCapabilitiesCoveredBy(model, candidate)
        && (!targetVisible || targetVisible(target.id, candidate, agent)))))
    && (['imageModels', 'videoModels', 'audioModels', 'embeddingModels'] as const).every(kind =>
      (source[kind] ?? []).filter(model => !model.disabled).every(model => target[kind]?.some(candidate => candidate.id === model.id && !candidate.disabled)));
}

/** Verified identity equality, never a grant or permission to move a task. */
export function sameSubscriptionAccounts(a: ProviderView, b: ProviderView): boolean {
  const left = a.subscriptionAccountKeys;
  const right = b.subscriptionAccountKeys;
  return Array.isArray(left) && Array.isArray(right) && left.length > 0 && left.length === right.length
    && left.every(key => typeof key === 'string' && key.length > 0)
    && right.every(key => typeof key === 'string' && key.length > 0)
    && new Set(left).size === left.length && new Set(right).size === right.length
    && left.every(key => right.includes(key));
}

/** Match an owner's provider across computers. Unknown built-in logins may still be borrowed;
 * known different subscriptions are never folded just because both are called OpenAI.
 */
export function sameRunLocationProvider(local: ProviderView, remote: ProviderView): boolean {
  if (local.subscriptionAccountKeys?.length && remote.subscriptionAccountKeys?.length)
    return sameSubscriptionAccounts(local, remote);
  if (!local.connected && local.id === remote.id) return true;
  const localIdentity = local.openAiAccount?.identity ?? local.subscriptionAccount?.identity;
  const remoteIdentity = remote.openAiAccount?.identity ?? remote.subscriptionAccount?.identity;
  // An older peer may only advertise an email, which is not a workspace identity.
  if (local.subscriptionAccountKeys?.length || remote.subscriptionAccountKeys?.length) return false;
  if ((local.auth?.native === 'codex' || remote.auth?.native === 'codex' || local.id === 'openai') && (localIdentity || remoteIdentity)) return false;
  if (localIdentity && remoteIdentity && localIdentity.trim().toLowerCase() !== remoteIdentity.trim().toLowerCase()) return false;
  return local.id === remote.id;
}

/** Collapse equal single-account sources in a browse list, without merging credentials or routes.
 * Groups, suspended sources and sources with additional capabilities retain their own entry.
 */
export function duplicateSubscriptionProviders(providers: readonly ProviderView[], isVisible?: VisibleModel): Map<string, string> {
  const duplicates = new Map<string, string>();
  const representatives: ProviderView[] = [];
  for (const provider of providers) {
    if (!provider.connected || provider.suspended || provider.removed || provider.subscriptionPoolAlias
      || provider.subscriptionAccountKeys?.length !== 1 || (provider as { group?: unknown }).group) continue;
    const representative = representatives.find(other => sameSubscriptionAccounts(provider, other)
      && subscriptionModelsCoveredBy(provider, other, isVisible));
    if (representative) duplicates.set(provider.id, representative.id);
    else representatives.push(provider);
  }
  return duplicates;
}
