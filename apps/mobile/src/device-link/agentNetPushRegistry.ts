/** Lightweight boundary for the existing push workflow; no RN/native/account imports. */
interface Backend {
  selected(): boolean;
  mutate(method: 'PUT' | 'DELETE', body?: unknown): Promise<void>;
  clear(): void;
  scope(): string | null;
  refreshPreferences(): Promise<void>;
}
let backend: Backend | null = null;
const listeners = new Set<() => void>();
export function installMobileAgentNetPush(value: Backend): void { backend = value; }
export function mobileAgentNetPushSelected(): boolean { return backend?.selected() ?? false; }
export function clearMobileAgentNetPush(): void { backend?.clear(); }
export async function refreshMobileAgentNetPushPreferences(): Promise<void> { await backend?.refreshPreferences(); }
export function mobileAgentNetPushScope(): string | null { return backend?.scope() ?? null; }
export function publishMobileAgentNetPushScope(): void { for (const listener of listeners) listener(); }
export function subscribeMobileAgentNetPushScope(listener: () => void): () => void {
  listeners.add(listener); return () => { listeners.delete(listener); };
}
export async function mutateMobileAgentNetPush(method: 'PUT' | 'DELETE', body?: unknown): Promise<boolean> {
  if (!backend?.selected()) return false;
  await backend.mutate(method, body); return true;
}
