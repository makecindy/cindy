import {
  isNonLocalModelFavoriteSource,
  parseModelFavoriteMutation,
  type ModelFavoriteMutation,
  type RemoteModelFavorite,
} from '@cindy/device-link';
import { ghostDeclaresModelPreferences, type GhostModelPreferencesResult, type InstalledGhost } from '../../shared/ghost.js';
import type { RecentModelHostItem } from '../../shared/modelFavoritesSync.js';
import type { GhostModelPreferencesProvider } from './runtime/ghostPageHandler.js';

/** Mutation bodies are a few hundred bytes; anything larger is not a favorite operation. */
const MAX_MUTATION_BODY = 8192;

export interface GhostModelPreferencesDeps {
  getGhost(instanceId: string): InstalledGhost | null | undefined;
  /** Current data owner scope; results are dropped if it changes while the bridge answers. */
  ownerKey(): string;
  /** Existing owner-fenced renderer bridge (`maker-ipc/modelFavoritesSync`). */
  read(): Promise<{ favorites: RemoteModelFavorite[]; recents: RecentModelHostItem[] }>;
  apply(mutation: ModelFavoriteMutation): Promise<RemoteModelFavorite[]>;
}

const unavailable = (message = 'Model preferences unavailable'): GhostModelPreferencesResult =>
  ({ ok: false, errorCode: 'NOT_AVAILABLE', message });
const invalid = (message: string): GhostModelPreferencesResult =>
  ({ ok: false, errorCode: 'INVALID_REQUEST', message });
const isLocal = (item: { providerId: string }) => !isNonLocalModelFavoriteSource(item.providerId);

/**
 * `GET /model-preferences` and `POST /model-preferences/favorites` for plugins that declared
 * `agent.modelPreferences` and were installed/updated through the normal consent (the
 * approved install receipt pins that manifest). No separate grant is stored, like hiddenTasks.
 * Only this computer's favorites and recents are exposed; other computers' and shared
 * sources stay hidden and cannot be written. Recents are read-only.
 */
export function createGhostModelPreferencesProvider(deps: GhostModelPreferencesDeps): GhostModelPreferencesProvider {
  const gate = (instanceId: string): GhostModelPreferencesResult | null => {
    const ghost = deps.getGhost(instanceId);
    if (!ghost?.enabled) return unavailable('Plugin unavailable');
    if (ghost.approval?.state !== 'approved' || !ghostDeclaresModelPreferences(ghost.manifest))
      return { ok: false, errorCode: 'PERMISSION_DENIED', message: 'Model preferences require agent.modelPreferences in ghost.json' };
    return null;
  };
  return {
    async read(instanceId) {
      const denied = gate(instanceId);
      if (denied) return denied;
      const owner = deps.ownerKey();
      let preferences;
      try {
        preferences = await deps.read();
      } catch {
        return unavailable();
      }
      if (owner !== deps.ownerKey()) return unavailable();
      const after = gate(instanceId);
      if (after) return after;
      return {
        ok: true,
        favorites: preferences.favorites.filter(isLocal),
        recents: preferences.recents.filter(isLocal),
      };
    },
    async applyFavorite(instanceId, body) {
      const denied = gate(instanceId);
      if (denied) return denied;
      let mutation: ModelFavoriteMutation;
      try {
        if (body.length > MAX_MUTATION_BODY) throw new Error('too large');
        mutation = parseModelFavoriteMutation(JSON.parse(body));
      } catch {
        return invalid('Expected {kind:"add",item} | {kind:"update",expected,item} | {kind:"remove",expected}');
      }
      const sources = mutation.kind === 'add' ? [mutation.item] : mutation.kind === 'remove'
        ? [mutation.expected] : [mutation.expected, mutation.item];
      if (!sources.every(isLocal)) return invalid('Only models on this computer can be changed');
      const owner = deps.ownerKey();
      let favorites;
      try {
        favorites = await deps.apply(mutation);
      } catch (error) {
        // The renderer store rejected the operation (favorite changed, limit, owner not ready):
        // nothing was written; the plugin should read again before retrying.
        if (owner === deps.ownerKey() && (error as { code?: unknown } | null)?.code === 'PRECONDITION_FAILED')
          return { ok: false, errorCode: 'CONFLICT', message: 'Favorites changed; read them again before retrying' };
        return unavailable();
      }
      if (owner !== deps.ownerKey()) return unavailable();
      const after = gate(instanceId);
      if (after) return after;
      return { ok: true, favorites: favorites.filter(isLocal) };
    },
  };
}
