import { AsyncLocalStorage } from 'node:async_hooks';
export { isAgentNetMediaReference } from '@cindy/agent-net-protocol';

type Options = { signal?: AbortSignal; onProgress?(bytes: number): void; assertCurrent?(): void };
export interface AgentNetMediaBackend {
  guard(): () => void;
  assertLegacyAllowed?(): void;
  available(): boolean;
  cacheScope(): string;
  upload(size: number, contentType: string, read: (offset: number, length: number) => Promise<Uint8Array>, options: Options): Promise<{ key: string; size: number; contentType: string; sha256: string } | null>;
  open(key: string, range?: string, signal?: AbortSignal): Promise<Response>;
  remove(key: string): Promise<void>;
}
let backend: AgentNetMediaBackend | null = null;
const destination = new AsyncLocalStorage<{ peer: string; check?: () => void }>();
/** Main installs the implementation; legacy media readers don't load network keys or the V2 runtime. */
export function installAgentNetMediaBackend(value: AgentNetMediaBackend | null) { backend = value; }
export function captureAgentNetMediaGuard(caller?: () => void): () => void {
  const guard = backend?.guard();
  return () => { guard?.(); caller?.(); };
}
export function assertLegacyMediaAllowed(): void { backend?.assertLegacyAllowed?.(); }
export function withAgentNetMediaTarget<T>(peer: string, operation: () => T): T {
  return destination.run({ peer, check: backend?.guard() }, operation);
}
export function agentNetMediaDestination(): string | undefined { const value = destination.getStore(); value?.check?.(); return value?.peer; }
export function hasAgentNetMediaTarget(): boolean { return backend?.available() === true; }
export function agentNetMediaCacheScope(): string { return backend?.cacheScope() ?? ''; }
export function uploadThroughAgentNet(size: number, contentType: string, read: (offset: number, length: number) => Promise<Uint8Array>, options: Options = {}) {
  return backend ? backend.upload(size, contentType, read, options) : Promise.resolve(null);
}
export function openThroughAgentNet(key: string, range?: string, signal?: AbortSignal) {
  if (!backend) throw new Error('AGENT_NET_MEDIA_SOURCE_UNAVAILABLE'); return backend.open(key, range, signal);
}
export function removeThroughAgentNet(key: string) {
  if (!backend) throw new Error('AGENT_NET_MEDIA_SOURCE_UNAVAILABLE'); return backend.remove(key);
}
