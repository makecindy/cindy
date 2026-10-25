import type { PluginAuthorizationRequest, PluginAuthorizationResult } from '@cindy/device-link';
import type { GhostNodeNeeds } from './nodeProtocol.js';

/** The shared broker only sees the exact installed snapshot supplied by its
 * Host. Installation identity, approval receipts and namespace remain Host-owned. */
export interface NodeRuntimeManifest {
  id: string;
  name: string;
  node?: GhostNodeNeeds;
  network?: { secrets?: Array<{ key: string; source?: string; oauth?: unknown }> };
}
export interface NodeRuntimeInstallation {
  manifest: NodeRuntimeManifest;
  dir: string;
  enabled: boolean;
  namespace?: string | null;
  namespaceState?: 'confirmed' | 'unconfirmed' | 'pending';
  instanceKey?: string;
}
export type NodeRuntimeEvent =
  | { type: 'event'; name: 'node-status'; state: 'starting' | 'running' | 'stopped' | 'crashed'; message?: string; entry?: string; ts: number }
  | { type: 'event'; name: 'node-notification'; method: string; params?: unknown; ts: number };
export interface NodeSecretSetupInput {
  ghostId: string; entry: string; method: string; sessionId: string;
  signal: AbortSignal; force: boolean; assertCurrent(): void;
}
export interface DeviceAuthorizationHandle { opened: Promise<void>; finish(ok: boolean): void; dispose(): void }
export interface DeviceAuthorizationInput {
  ghost: { id: string; name: string }; sessionId: string; url: string;
  userCode?: string; signal: AbortSignal; assertCurrent(): void; cancel(): void;
}
export interface PluginAuthorizationHandle extends DeviceAuthorizationHandle { result: Promise<PluginAuthorizationResult> }
export interface PluginAuthorizationInput extends Omit<DeviceAuthorizationInput, 'url' | 'userCode'> { request: PluginAuthorizationRequest }
