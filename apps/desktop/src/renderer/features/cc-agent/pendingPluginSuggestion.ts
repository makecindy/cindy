import type { HomeTaskSuggestion } from './pluginHomeSuggestions';
import { parsePluginInstanceId } from '../../../shared/pluginIdentity';

export interface PluginSuggestionRequest {
  suggestion: HomeTaskSuggestion;
  ownerId: string;
  targetKey: string;
  workingDir: string | null;
  /** Route to resume on after setup; omitted = the new-task draft. */
  returnTo?: string;
  /** Set when the request came from the `/` palette: resume by filling `/<skillName> `. */
  skillName?: string;
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
export const NEW_TASK_PLUGIN_SUGGESTION_RETURN = '/cc-agent/new';
export function pendingPluginSuggestionReturnPath(request: PluginSuggestionRequest): string {
  return request.returnTo ?? NEW_TASK_PLUGIN_SUGGESTION_RETURN;
}
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
/** Whether `ghostId` is the plugin this request is about (same namespace and id). */
export function pendingSuggestionIsForGhost(request: PluginSuggestionRequest, ghostId: string): boolean {
  const suggestionPluginId = request.suggestion.pluginId;
  const suggestionIdentity =
    typeof suggestionPluginId === 'string' ? parsePluginInstanceId(suggestionPluginId) : null;
  const installedIdentity = parsePluginInstanceId(ghostId);
  return (
    !!suggestionIdentity &&
    !!installedIdentity &&
    suggestionIdentity.namespace === installedIdentity.namespace &&
    suggestionIdentity.ghostId === installedIdentity.ghostId
  );
}
export function readyPendingPluginSuggestion(
  nonce: string | undefined,
  ownerId: string | null,
  ghostId: string,
): string | null {
  const suggestionPluginId = pending?.suggestion.pluginId;
  if (
    !pending ||
    pending.nonce !== nonce ||
    pending.ownerId !== ownerId ||
    typeof suggestionPluginId !== 'string' ||
    !pendingSuggestionIsForGhost(pending, ghostId) ||
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
