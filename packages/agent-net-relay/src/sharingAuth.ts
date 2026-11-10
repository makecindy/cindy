import { createHash } from 'node:crypto';
import { createRemoteJWKSet, customFetch, decodeJwt, jwtVerify, errors as joseErrors, type JWTVerifyGetKey } from 'jose';
import { ID_PATTERN, KEY_PATTERN, sharingIdentityPayload, stripTrailingSlashes } from '@cindy/agent-net-protocol';
import { createIdentityCardVerifier } from '@cindy/device-link-sharing/identity-card';
import { AppError } from '@cindy/device-link-sharing/errors';
import type { AgentNetSharingOptions } from './sharing.js';
import { verifyRequestProof } from './identity.js';

export interface SharingAuthConfig { issuer: string; jwksUrl?: string | URL; fetch?: typeof fetch; region?: 'cn' | 'global';
  peers?: { issuer: string; region: 'cn' | 'global'; jwksUrl?: string | URL }[]; }

/** Shared by the standalone service and embedded desktop relay. These are
 * five-minute, network/key-bound identity cards, never account access tokens. */
export function createAgentNetSharingAuth(config: SharingAuthConfig, testKeys?: JWTVerifyGetKey): AgentNetSharingOptions {
  if (config.region !== undefined && config.region !== 'cn' && config.region !== 'global'
    || config.peers?.length && (!config.region || config.peers.length > 1 || config.peers.some(p => p.region === config.region))) throw new Error('INVALID_SHARING_AUTH_REGION');
  const issuer = stripTrailingSlashes(config.issuer);
  const safe = (value: string) => {
    const url = new URL(value);
    if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
      && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname))))
      throw new Error('INVALID_SHARING_AUTH_URL');
    return url;
  };
  safe(issuer); if (config.jwksUrl) safe(String(config.jwksUrl));
  const keys = testKeys ?? createRemoteJWKSet(new URL(config.jwksUrl ?? issuer + '/.well-known/jwks.json'), {
    cacheMaxAge: 300_000, ...(config.fetch ? { [customFetch]: config.fetch } : {}),
  });
  const trusted = [{ issuer, region: config.region, keys,
    cards: createIdentityCardVerifier({ issuer, keys: testKeys ?? config.jwksUrl ?? issuer + '/.well-known/jwks.json', region: config.region, fetch: config.fetch }), peer: false },
    ...(config.peers ?? []).map(peer => {
      const issuer = stripTrailingSlashes(peer.issuer); safe(issuer); if (peer.jwksUrl) safe(String(peer.jwksUrl));
      if (peer.region !== 'cn' && peer.region !== 'global') throw new Error('INVALID_SHARING_AUTH_REGION');
      return { issuer, region: peer.region,
        keys: createRemoteJWKSet(new URL(peer.jwksUrl ?? issuer + '/.well-known/jwks.json'), { cacheMaxAge: 300_000, ...(config.fetch ? { [customFetch]: config.fetch } : {}) }),
        cards: createIdentityCardVerifier({ issuer, keys: peer.jwksUrl ?? issuer + '/.well-known/jwks.json', region: peer.region, fetch: config.fetch }), peer: true };
    })];
  if (trusted.length > 3 || new Set(trusted.map(t => t.issuer)).size !== trusted.length) throw new Error('INVALID_SHARING_AUTH_ISSUERS');
  const forCard = (card: string) => {
    // Decode only to choose from the configured allowlist. Claims are never
    // trusted until that issuer's JWKS, audience and region have verified.
    const candidate = trusted.find(t => t.issuer === decodeJwt(card).iss);
    if (!candidate) throw new Error('UNTRUSTED_SHARING_AUTH_ISSUER'); return candidate;
  };
  return {
    async authenticate(req, bytes, context) {
      const header = req.headers.authorization;
      if (!header?.startsWith('AgentNetIdentity ') || header.length > 16_384) throw new AppError('AUTH_REQUIRED', 401, 'Scoped account identity required');
      try {
        const value = JSON.parse(Buffer.from(header.slice('AgentNetIdentity '.length), 'base64url').toString('utf8'));
        const { networkId, deviceId, signingKey, card, proof } = value;
        if (typeof networkId !== 'string' || !ID_PATTERN.test(networkId) || typeof deviceId !== 'string' || !ID_PATTERN.test(deviceId)
          || typeof signingKey !== 'string' || !KEY_PATTERN.test(signingKey) || typeof card !== 'string' || card.length > 8192)
          throw new Error('Invalid identity envelope');
        const root = context.rootPublicKey(networkId);
        const expected = createHash('sha256').update(sharingIdentityPayload(networkId, root, deviceId, signingKey)).digest('hex');
        const authority = forCard(card);
        const { payload } = await jwtVerify(card, authority.keys, { issuer: authority.issuer, audience: 'cindy-agent-net-sharing', algorithms: ['RS256'],
          clockTolerance: 5, maxTokenAge: 300, requiredClaims: ['sub', 'iat', 'exp'] });
        if (payload.typ !== 'identity-card' || payload.purpose !== 'network-session' || payload.nonce !== expected
          || payload.device !== deviceId || typeof payload.sub !== 'string' || !ID_PATTERN.test(payload.sub)
          || typeof payload.iat !== 'number' || typeof payload.exp !== 'number' || payload.exp - payload.iat > 300
          || (payload.region !== 'cn' && payload.region !== 'global')
          || authority.region !== undefined && authority.region !== payload.region
          || !verifyRequestProof(signingKey, proof, req.method ?? 'GET', req.url ?? '/', bytes, Date.now()))
          throw new Error('Invalid scoped account proof');
        context.remember('identity:' + payload.sub, deviceId, proof.nonce);
        return { accountId: authority.peer ? 'x:' + authority.region + ':' + payload.sub : payload.sub, deviceId, networkId };
      } catch (error) {
        if (error instanceof AppError) throw error;
        if (error instanceof joseErrors.JWKSTimeout || error instanceof joseErrors.JWKSInvalid)
          throw new AppError('SERVICE_UNAVAILABLE', 503, 'Account identity keys unavailable');
        throw new AppError('ACCOUNT_AUTH_INVALID', 401, 'Scoped account identity could not be verified');
      }
    },
    providers: { hostCapability: 'provider-share-v1', identityCards: {
      async verify(card, expected) {
        let authority; try { authority = forCard(card); } catch { throw new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Identity card is invalid'); }
        const value = await authority.cards.inspect(card, expected);
        const subject = authority.peer ? 'x:' + authority.region + ':' + value.subject : value.subject;
        if (subject !== expected.subject) throw new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Identity card subject mismatch');
        return value.person;
      },
      async inspect(card, expected) {
        let authority; try { authority = forCard(card); } catch { throw new AppError('PROVIDER_SHARE_IDENTITY_INVALID', 400, 'Identity card is invalid'); }
        const value = await authority.cards.inspect(card, expected);
        return { ...value, subject: authority.peer ? 'x:' + authority.region + ':' + value.subject : value.subject };
      },
    } },
  };
}
