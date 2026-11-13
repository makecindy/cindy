import type { DelegationRequest } from '@cindy/agent-net-protocol';
import type { AgentNetClient } from '@cindy/agent-net-relay/client';

let policy: ((request: DelegationRequest) => Promise<boolean>) | null = null;
let prepare: ((client: AgentNetClient) => void) | null = null;
/** The device-link owner installs its existing business authority. A relay's
 * directory hint alone is never enough to make Main issue a transport grant. */
export function installAgentNetSharingPolicy(next: (request: DelegationRequest) => Promise<boolean>, onPrimary?: (client: AgentNetClient) => void): () => void {
  policy = next;
  prepare = onPrimary ?? null;
  return () => { if (policy === next) { policy = null; prepare = null; } };
}
export function prepareAgentNetSharingPrimary(client: AgentNetClient): void { prepare?.(client); }
export async function authorizeAgentNetSharingRequest(request: DelegationRequest): Promise<boolean> {
  return await policy?.(request) === true;
}
