import type { RemoteUtilityTextClient } from './transport.js';

/**
 * The wired client, set once by the Desktop assembly.
 *
 * Callers that have no assembly (tests, Node Host) simply get "no remote route"
 * instead of a partially initialized Device Link.
 */
let client: RemoteUtilityTextClient | null = null;

export function setRemoteUtilityTextClient(next: RemoteUtilityTextClient | null): void {
  client = next;
}

export function getRemoteUtilityTextClient(): RemoteUtilityTextClient | null {
  return client;
}
