import type { AttachedFile } from '@/lib/fileTypes';
import type { Effort, PermissionMode } from '@/lib/userPreferences.types';
import type { HomeTaskSuggestion } from './pluginHomeSuggestions';

export interface PluginSuggestionRequest {
  suggestion: HomeTaskSuggestion;
  ownerId: string;
  targetKey: string;
  workingDir: string | null;
  model: string;
  effort: Effort;
  permissionMode: PermissionMode;
  providerId?: string | null;
  files: AttachedFile[];
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
  if (
    !pending ||
    pending.nonce !== nonce ||
    pending.ownerId !== ownerId ||
    pending.suggestion.pluginId !== ghostId ||
    pending.phase !== 'setup'
  )
    return null;
  pending = { ...pending, phase: 'ready' };
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
