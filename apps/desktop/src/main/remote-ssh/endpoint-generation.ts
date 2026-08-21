/**
 * Stable HostRefs survive endpoint edits, while facts such as installed
 * binaries, daemon versions and proxy tunnels do not. This monotonic token
 * lets async work prove it still belongs to the current resolved endpoint
 * before publishing cache or UI state.
 */
const generations = new Map<string, number>();

export function currentRemoteEndpointGeneration(hostId: string): number {
  return generations.get(hostId) ?? 0;
}

export function advanceRemoteEndpointGeneration(hostId: string): number {
  const next = currentRemoteEndpointGeneration(hostId) + 1;
  generations.set(hostId, next);
  return next;
}

export function isCurrentRemoteEndpointGeneration(hostId: string, generation: number): boolean {
  return currentRemoteEndpointGeneration(hostId) === generation;
}

export function remoteEndpointScopedKey(hostId: string, generation: number): string {
  return `${hostId}::endpoint-generation:${generation}`;
}

export class StaleRemoteEndpointError extends Error {
  readonly code = 'SSH_NOT_CONNECTED';

  constructor(hostId: string) {
    super(`remote endpoint changed while work was in flight: ${hostId}`);
    this.name = 'StaleRemoteEndpointError';
  }
}

export function assertCurrentRemoteEndpointGeneration(
  hostId: string,
  generation: number,
): void {
  if (!isCurrentRemoteEndpointGeneration(hostId, generation)) {
    throw new StaleRemoteEndpointError(hostId);
  }
}
