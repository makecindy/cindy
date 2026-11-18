import { ID_PATTERN, KEY_PATTERN } from '@cindy/agent-net-protocol';
import { AppError } from '@cindy/device-link-sharing/errors';
import type { SharingStorage } from '@cindy/device-link-sharing/repositories';
import type { IncomingMessage } from 'node:http';
import { createAgentNetSharing, type SharingHost } from './sharing.js';
import { verifyRequestProof } from './identity.js';

/** A physically separate resource book. A local key never inherits an account service identity. */
export function createPrivateSharing(host: SharingHost, storage: SharingStorage) {
  const verified = new WeakMap<IncomingMessage, Awaited<ReturnType<SharingHost['member']>>>();
  const denied = () => new AppError('PRIVATE_IDENTITY_INVALID', 401, 'Private sharing identity required');
  return createAgentNetSharing({
    async authenticate(req, bytes, context) {
      if (req.headers['x-agent-net-authorization']) {
        const member = await host.member(req, bytes);
        verified.set(req, member);
        return { accountId: member.subject, networkId: member.networkId, deviceId: member.deviceId };
      }
      const header = req.headers.authorization;
      if (!header?.startsWith('AgentNetPrivate ') || header.length > 2048) throw denied();
      let envelope;
      try { envelope = JSON.parse(Buffer.from(header.slice(16), 'base64url').toString()); } catch { throw denied(); }
      const { networkId, signingKey, proof } = envelope ?? {};
      if (typeof networkId !== 'string' || !ID_PATTERN.test(networkId) || typeof signingKey !== 'string'
        || !KEY_PATTERN.test(signingKey) || Buffer.from(signingKey, 'base64url').toString('base64url') !== signingKey) throw denied();
      const root = context.rootPublicKey(networkId);
      const domain = JSON.stringify(['private-sharing/1', networkId, root, req.url]);
      if (!verifyRequestProof(signingKey, proof, req.method ?? 'GET', domain, bytes, host.now())) throw denied();
      const id = 'guest:' + signingKey;
      await context.remember(id, id, proof.nonce);
      return { accountId: id, networkId, deviceId: id };
    },
    providers: { hostCapability: 'provider-share-v1', identityCards: {
      // The signed request binds the complete action and body. Only a locally authenticated
      // principal reaches this service; display a key fingerprint, never an official user profile.
      async verify(value, expected) {
        if (value !== 'private-device') throw denied();
        return { displayName: expected.subject, avatarUrl: null, region: 'global' };
      },
      async inspect() { throw denied(); },
    } },
  }, { ...host, storage, member: async req => {
    const member = verified.get(req);
    if (!member) throw denied();
    return member;
  } });
}
