/** Which computer runs each companion (cloud-companions.md §3), fed by chatServer register(). */
import {
  EMPTY_COMPANION_CLOUD_SNAPSHOT,
  type CompanionCloudActor,
  type CompanionCloudSnapshot,
} from './contract.js';
import { chatRejection, errorCode, type CompanionApi, type CompanionLog } from './types.js';

export type CompanionHomeListener = (snapshot: CompanionCloudSnapshot) => void;

export function createCompanionHomeRegistry() {
  let live = EMPTY_COMPANION_CLOUD_SNAPSHOT;
  // Shadowed ids persisted per owner: demotion holds even before the first successful
  // /me + /actors, while the server is unreachable, or when the feature is off.
  let persisted: readonly string[] = [];
  let snapshot = EMPTY_COMPANION_CLOUD_SNAPSHOT;
  const listeners = new Set<CompanionHomeListener>();
  // Owner scoping: reads after an account / data-owner switch never see the previous owner's
  // homes; the new owner's persisted shadows apply at once, before its Chat Server instance runs.
  let ownerBinding: { owner: () => string; loadPersisted: () => readonly string[] } | null = null;
  let boundOwner: string | null = null;
  const sync = () => {
    if (!ownerBinding) return;
    const owner = ownerBinding.owner();
    if (owner === boundOwner) return;
    boundOwner = owner;
    live = EMPTY_COMPANION_CLOUD_SNAPSHOT;
    try { persisted = [...new Set(ownerBinding.loadPersisted())].sort(); } catch { persisted = []; }
    emit();
  };
  const current = () => { sync(); return snapshot; };
  const actorOf = (botId: string) => current().actors.find(actor => actor.externalId === botId);
  const emit = () => {
    const demotedBotIds = [...new Set([...live.demotedBotIds, ...persisted])].sort();
    const next = { ...live, actors: live.actors.map(actor => ({ ...actor })), demotedBotIds };
    if (JSON.stringify(next) === JSON.stringify(snapshot)) return;
    snapshot = next;
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* one listener never blocks the others */ }
    }
  };
  const registry = {
    /** Live state plus persisted shadows (demotedBotIds is their union). */
    snapshot: current,
    update(next: CompanionCloudSnapshot) { sync(); live = next; emit(); },
    /** Replace the persisted shadow set (loaded at owner start, rewritten when demotion changes). */
    setPersistedShadows(ids: readonly string[]) { sync(); persisted = [...new Set(ids)].sort(); emit(); },
    persistedShadows: () => { sync(); return persisted; },
    reset() { live = EMPTY_COMPANION_CLOUD_SNAPSHOT; persisted = []; emit(); },
    /** Scope the registry to the active data owner (process-wide instance). */
    bindOwner(owner: () => string, loadPersisted: () => readonly string[]) {
      ownerBinding = { owner, loadPersisted };
      boundOwner = owner();
    },
    isEnabled: () => current().enabled,
    /** Home device of a registered companion; undefined when this account has no actor for it. */
    homeOf: (botId: string): string | null | undefined => actorOf(botId)?.homeDeviceId,
    /** True when the feature is off, the companion has no home yet, or this computer is its home. */
    isHomeHere(botId: string): boolean {
      const view = current();
      if (!view.enabled) return true;
      const home = actorOf(botId)?.homeDeviceId;
      return !home || home === view.selfDeviceId;
    },
    actorIdFor: (botId: string): string | null => actorOf(botId)?.id ?? null,
    /** The local copy of a companion that runs elsewhere (or in another install): hidden, never runs here. */
    isShadowed: (botId: string): boolean => current().demotedBotIds.includes(botId),
    onChange(listener: CompanionHomeListener): () => void {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  return registry;
}

export type CompanionHomeRegistry = ReturnType<typeof createCompanionHomeRegistry>;

/** Process-wide registry; chatServer resets it when its account/endpoint instance ends. */
export const companionHomes = createCompanionHomeRegistry();

/** True while this computer's copy of the companion is demoted (its home is elsewhere). */
export function isCompanionShadowed(botId: string): boolean {
  return companionHomes.isShadowed(botId);
}

interface HomeActor { id: string; kind: string; externalId: string; homeDeviceId?: string | null; disabled?: boolean }

/**
 * First registration only: claim companions whose home is still empty for this
 * computer (compare-and-set against null). A conflict means another computer won;
 * adopt its answer. Mutates `actors` with the resulting homes.
 */
export async function registerCompanionHomes(input: {
  api: CompanionApi;
  selfDeviceId: string;
  actors: HomeActor[];
  botIds: string[];
  isDemoted: (botId: string) => boolean;
  log?: CompanionLog;
}): Promise<void> {
  for (const botId of input.botIds) {
    const actor = input.actors.find(a => a.kind === 'bot' && a.externalId === botId);
    if (!actor || actor.disabled || actor.homeDeviceId != null || input.isDemoted(botId)) continue;
    try {
      const result = await input.api<{ homeDeviceId?: string | null }>(`/actors/${actor.id}`, 'PATCH',
        { homeDeviceId: input.selfDeviceId, expectedHomeDeviceId: null });
      actor.homeDeviceId = result?.homeDeviceId ?? input.selfDeviceId;
    } catch (error) {
      const conflict = chatRejection(error, 409, 'HOME_DEVICE_CONFLICT');
      if (conflict) actor.homeDeviceId = typeof conflict.homeDeviceId === 'string' ? conflict.homeDeviceId : null;
      else input.log?.warn('Companion home registration will retry', { actorId: actor.id, code: errorCode(error) });
    }
  }
}

export function companionSnapshot(input: {
  enabled: boolean;
  selfDeviceId: string | null;
  humanActorId: string | null;
  actors: Array<HomeActor & { name: string; avatar?: string | null }>;
  demotedBotIds?: string[];
}): CompanionCloudSnapshot {
  // Retired actors (deleted on their home) are not companions any more.
  const actors: CompanionCloudActor[] = input.actors.filter(a => a.kind === 'bot' && !a.disabled).map(a => ({
    id: a.id, externalId: a.externalId, name: a.name, avatar: a.avatar ?? null, homeDeviceId: a.homeDeviceId ?? null,
  }));
  return { enabled: input.enabled, selfDeviceId: input.selfDeviceId, humanActorId: input.humanActorId, actors,
    demotedBotIds: [...(input.demotedBotIds ?? [])].sort() };
}
