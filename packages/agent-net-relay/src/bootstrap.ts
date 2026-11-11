import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { generateIdentity, issueCertificate, publicBytes, type Identity } from './identity.js';
import type { Bootstrap } from './server.js';

/** Runs on the owner's device; only bootstrap (public data) is sent to a relay. */
export function createPrivateNetwork(name: string, identity: Identity = generateIdentity()) {
  const root = generateKeyPairSync('ed25519').privateKey;
  const networkId = 'private:' + randomUUID();
  const certificate = issueCertificate(root, { networkId, subject: 'owner:' + randomUUID(), identity, role: 'owner' });
  const bootstrap: Bootstrap = { networkId, name, rootPublicKey: publicBytes(root), ownerCertificate: certificate };
  return { root, identity, bootstrap };
}
