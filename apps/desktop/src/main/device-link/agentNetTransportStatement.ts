/**
 * Whether to take a Device Link link's signed statement of the peer's Agent-Net mode ("on" or "off"), from a peer this node knows
 * on Agent-Net: its certificate is in this account's signed directory, so it was never revoked. Desktop (agentNetRuntime.ts) and
 * Node Host (agentNetNode.ts) both ask here. Not Electron-specific.
 *
 * - A certificate valid now: either statement.
 * - An expired one: only "off". A device renews its certificate only while its Agent-Net is on, so one turned off for longer than
 *   the certificate lasts (14 days) could no longer say so, and peers with Agent-Net on refused even its Device Link links: it
 *   could neither control them nor be controlled (since v0.1.133; 2026-11-17 the user chose to accept it, docs/product-rules/agent-net.md).
 *   The statement is still signed by that device's own key, for this request and this receiver within 90 seconds, and the certificate
 *   is checked against the network root at its issue time. Devices removed in Device Link are not accepted (`accepted`).
 *   "On" from an expired certificate stays refused: it would steer the traffic onto a path that certificate no longer vouches for.
 */
import { verifyCertificate, type DeviceCertificate } from '@cindy/agent-net-relay';
import { verifyTransportModeProof } from '@cindy/agent-net-relay/client';

/**
 * `offOnly`: the device is no longer in the signed directory (revoked on Agent-Net, e.g. after a Device Link deletion) and
 * `certificate` is the one it last had there. Its own "off" still lets its Device Link links through, as for any device not on
 * Agent-Net (it must be in the Device Link list, `accepted`); "on" is refused.
 */
export function acceptTransportStatement(rootPublicKey: string, certificate: DeviceCertificate | undefined, to: string,
  requestId: string, proof: unknown, accepted = true, options: { offOnly?: boolean } = {}): boolean {
  if (!certificate || !verifyTransportModeProof(certificate, to, requestId, proof)) return false;
  const issuedAt = certificate.issuedAt;
  if (!options.offOnly && verifyCertificate(rootPublicKey, certificate)) return true;
  return proof.enabled === false && accepted && verifyCertificate(rootPublicKey, certificate, issuedAt);
}
