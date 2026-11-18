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
    // Partial snapshots from older peers may omit agents; then the listed model groups decide.
    && (source.agents ?? Object.keys(source.models ?? {}) as AgentKind[]).every(agent => (source.models?.[agent] ?? []).filter(model => !model.disabled && (!isVisible || isVisible(source.id, model, agent))).every(model =>
      target.models?.[agent]?.some(candidate => candidate.id === model.id && !candidate.disabled
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

/** Another own computer's sources, already limited to what that computer offers to the base. */
export interface ListedSourceComputer {
  deviceId: string;
  providers: readonly ProviderView[];
}

/** A listed entry: `deviceId` null is the base computer. */
export interface ListedSourceRef {
  deviceId: string | null;
  providerId: string;
}

export interface ListedSourcesInput {
  /** The computer the list is about: this computer in Settings, the task's computer in pickers. */
  base: readonly ProviderView[];
  /** Base sources that always keep their own entry (provider groups). Settings lists own shares separately. */
  baseExempt?: (providerId: string) => boolean;
  /** Other own computers, in display order. Provider groups keep their entry. */
  others?: readonly ListedSourceComputer[];
  /** The source the current task uses. It stays listed and stands in for the sources it covers. */
  current?: ListedSourceRef | null;
  /** Let the base provider's run-location choice decide which equal entry is listed (pickers). */
  honorRunLocation?: boolean;
}

export interface ListedSourceFolds {
  hiddenBase: Set<string>;
  /** deviceId → hidden provider ids on that computer. */
  hiddenOther: Map<string, Set<string>>;
  /**
   * Another computer's copy of a provider the base computer has but cannot use right now
   * (`deviceId\nproviderId` → base provider id). Pickers list it, and ask before using it:
   * the app never moves work to another computer on its own.
   */
  askBeforeUse: Map<string, string>;
}

/** Run location value for "this computer's own entry". */
export const RUN_LOCATION_LOCAL = 'local';

/**
 * Where a provider available on several own computers runs: the computer the user chose while it
 * still offers the provider, otherwise this computer. Never another computer on the app's own
 * initiative: a momentary disconnect must not move work elsewhere (2026-11-18 user decision).
 */
export function effectiveRunLocation(
  provider: { runLocation?: string },
  candidates: readonly { deviceId: string }[],
): string {
  const pinned = provider.runLocation;
  if (pinned && pinned !== RUN_LOCATION_LOCAL && candidates.some((candidate) => candidate.deviceId === pinned)) return pinned;
  return RUN_LOCATION_LOCAL;
}

/**
 * The single rule for "is this the same source listed twice". Settings, the desktop picker and the
 * phone picker all use it, so a source hidden in one is hidden in all.
 *
 * An entry folds only into an equal source (same verified login, or the same built-in route with no
 * conflicting identity) that offers every model and control it does. Model visibility preferences are
 * display choices and do not decide whether two sources are the same.
 */
export function listedSourceFolds(input: ListedSourcesInput): ListedSourceFolds {
  const { base, baseExempt = () => false, others = [], current = null, honorRunLocation = false } = input;
  const hiddenBase = new Set<string>();
  const hiddenOther = new Map<string, Set<string>>();
  const askBeforeUse = new Map<string, string>();
  const otherHidden = (deviceId: string, providerId: string) => hiddenOther.get(deviceId)?.has(providerId) ?? false;
  const hide = (ref: ListedSourceRef) => {
    if (ref.deviceId === null) { hiddenBase.add(ref.providerId); return; }
    const set = hiddenOther.get(ref.deviceId) ?? new Set<string>();
    set.add(ref.providerId);
    hiddenOther.set(ref.deviceId, set);
  };
  const unhide = (ref: ListedSourceRef) => ref.deviceId === null
    ? hiddenBase.delete(ref.providerId)
    : hiddenOther.get(ref.deviceId)?.delete(ref.providerId);
  const isCurrent = (ref: ListedSourceRef) => !!current && current.deviceId === ref.deviceId && current.providerId === ref.providerId;

  // 1. Equal logins within one computer.
  const foldWithin = (deviceId: string | null, providers: readonly ProviderView[]) => {
    const byId = new Map(providers.map(provider => [provider.id, provider]));
    for (const [id, representative] of duplicateSubscriptionProviders(providers)) {
      hide({ deviceId, providerId: id });
      // The task's own source stays; its representative steps aside when nothing is lost.
      if (isCurrent({ deviceId, providerId: id })) {
        unhide({ deviceId, providerId: id });
        if (subscriptionModelsCoveredBy(byId.get(representative)!, byId.get(id)!)) hide({ deviceId, providerId: representative });
      }
    }
  };
  foldWithin(null, base.filter(provider => !baseExempt(provider.id)));
  for (const computer of others) foldWithin(computer.deviceId, computer.providers);

  // 2. The same source on another computer folds into the base computer's entry, or into the
  //    computer its run location points to.
  const offered = (computer: ListedSourceComputer, provider: ProviderView) => provider.connected && !provider.suspended
    && !provider.removed && !(provider as { group?: unknown }).group && !otherHidden(computer.deviceId, provider.id);
  const matched = new Set<string>();
  for (const provider of base) {
    if (baseExempt(provider.id) || provider.suspended || provider.removed || provider.subscriptionPoolAlias || hiddenBase.has(provider.id)) continue;
    const candidates = others.flatMap(computer => computer.providers
      .filter(entry => offered(computer, entry) && sameRunLocationProvider(provider, entry))
      .map(entry => ({ deviceId: computer.deviceId, provider: entry })));
    if (!candidates.length) continue;
    // An explicit run-location choice decides; otherwise the entry the task uses; otherwise the default.
    const pinned = honorRunLocation ? (provider as { runLocation?: string }).runLocation : undefined;
    const pinnedListed = pinned === RUN_LOCATION_LOCAL || candidates.some(candidate => candidate.deviceId === pinned);
    const location = pinnedListed ? pinned!
      : candidates.find(candidate => isCurrent({ deviceId: candidate.deviceId, providerId: candidate.provider.id }))?.deviceId
        ?? (isCurrent({ deviceId: null, providerId: provider.id }) || !honorRunLocation ? RUN_LOCATION_LOCAL
          : effectiveRunLocation(provider as ProviderView & { runLocation?: string }, candidates));
    const preferred = candidates.find(candidate => candidate.deviceId === location);
    // This computer has the provider but cannot use it now: pickers keep the other computers' copies
    // listed and ask before using one, instead of quietly standing them in for this computer's entry.
    // This computer's entry stays listed too, even while the task still uses it, so it can recover.
    if (!preferred && honorRunLocation && !provider.connected) {
      for (const candidate of candidates) askBeforeUse.set(`${candidate.deviceId}\n${candidate.provider.id}`, provider.id);
      continue;
    }
    const representative = preferred?.provider ?? provider;
    // The entry the task uses never disappears, even while it is not the chosen location.
    for (const candidate of candidates) {
      const ref = { deviceId: candidate.deviceId, providerId: candidate.provider.id };
      if (candidate === preferred) matched.add(`${ref.deviceId}\n${ref.providerId}`);
      else if (!isCurrent(ref) && subscriptionModelsCoveredBy(candidate.provider, representative)) {
        hide(ref);
        matched.add(`${ref.deviceId}\n${ref.providerId}`);
      }
      // Entries with more than the representative stay listed and still fold among other computers.
    }
    if (preferred && !isCurrent({ deviceId: null, providerId: provider.id }) && subscriptionModelsCoveredBy(provider, representative))
      hiddenBase.add(provider.id);
  }

  // 3. Two other computers offering the same source that the base computer does not have.
  const listed: { deviceId: string; provider: ProviderView }[] = [];
  for (const computer of others) {
    for (const provider of computer.providers) {
      if (!offered(computer, provider) || matched.has(`${computer.deviceId}\n${provider.id}`)) continue;
      const ref = { deviceId: computer.deviceId, providerId: provider.id };
      const equal = listed.find(entry => sameRunLocationProvider(entry.provider, provider)
        && subscriptionModelsCoveredBy(provider, entry.provider));
      if (!equal) { listed.push({ deviceId: computer.deviceId, provider }); continue; }
      const equalRef = { deviceId: equal.deviceId, providerId: equal.provider.id };
      if (isCurrent(ref) && subscriptionModelsCoveredBy(equal.provider, provider)) {
        hide(equalRef);
        listed.splice(listed.indexOf(equal), 1, { deviceId: computer.deviceId, provider });
      } else if (!isCurrent(ref)) hide(ref);
    }
  }
  for (const key of askBeforeUse.keys()) {
    const [deviceId, providerId] = [key.slice(0, key.indexOf('\n')), key.slice(key.indexOf('\n') + 1)];
    if (otherHidden(deviceId, providerId)) askBeforeUse.delete(key);
  }
  return { hiddenBase, hiddenOther, askBeforeUse };
}
