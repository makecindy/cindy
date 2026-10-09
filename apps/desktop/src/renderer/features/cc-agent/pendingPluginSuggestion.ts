import type { HomeTaskSuggestion } from './pluginHomeSuggestions';
import { parsePluginInstanceId } from '../../../shared/pluginIdentity';

export interface PluginSuggestionRequest {
  suggestion: HomeTaskSuggestion;
  ownerId: string;
  targetKey: string;
  workingDir: string | null;
}
export interface PendingPluginSuggestion extends PluginSuggestionRequest {
  nonce: string;
  phase: 'setup' | 'ready';
}
let pending: PendingPluginSuggestion | null = null;
const listeners = new Set<() => void>();
function publish(): void {
  listeners.forEach((fn) => fn());
}
export const subscribePendingPluginSuggestion = (fn: () => void) => {
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
};
export const getPendingPluginSuggestion = () => pending;
export function startPendingPluginSuggestion(request: PluginSuggestionRequest): string {
  pending = { ...request, nonce: crypto.randomUUID(), phase: 'setup' };
  publish();
  return pending.nonce;
}
export function cancelPendingPluginSuggestion(nonce?: string): void {
  if (pending && (!nonce || pending.nonce === nonce)) {
    pending = null;
    publish();
  }
}
export function readyPendingPluginSuggestion(
  nonce: string | undefined,
  ownerId: string | null,
  ghostId: string,
): string | null {
  const suggestionPluginId = pending?.suggestion.pluginId;
  const suggestionIdentity =
    typeof suggestionPluginId === 'string' ? parsePluginInstanceId(suggestionPluginId) : null;
  const installedIdentity = parsePluginInstanceId(ghostId);
  if (
    !pending ||
    pending.nonce !== nonce ||
    pending.ownerId !== ownerId ||
    typeof suggestionPluginId !== 'string' ||
    !suggestionIdentity ||
    !installedIdentity ||
    suggestionIdentity.namespace !== installedIdentity.namespace ||
    suggestionIdentity.ghostId !== installedIdentity.ghostId ||
    pending.phase !== 'setup'
  )
    return null;
  const pluginPrefix = `plugin:${suggestionPluginId}:`;
  const suggestion = {
    ...pending.suggestion,
    pluginId: ghostId,
    id: pending.suggestion.id.startsWith(pluginPrefix)
      ? `plugin:${ghostId}:${pending.suggestion.id.slice(pluginPrefix.length)}`
      : pending.suggestion.id,
  };
  pending = { ...pending, suggestion, phase: 'ready' };
  publish();
  return pending.nonce;
}
export function takePendingPluginSuggestion(
  nonce: string,
  ownerId: string | null,
  targetKey: string,
): PendingPluginSuggestion | null {
  const result = pending;
  if (!result || result.nonce !== nonce) return null;
  cancelPendingPluginSuggestion(nonce);
  return result.phase === 'ready' && result.ownerId === ownerId && result.targetKey === targetKey
    ? result
    : null;
}
