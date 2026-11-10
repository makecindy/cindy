import fs from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { createHash, createPrivateKey, randomBytes } from 'node:crypto';
import WebSocket from 'ws';
import { identityFromSeed, publicBytes, verifyCertificate, type Identity } from '@cindy/agent-net-relay';
import { AgentNetClient, acceptEnrollment, createEnrollmentRequest } from '@cindy/agent-net-relay/client';
import { activeOwnerScopeKey, isAppSessionBoundaryPending } from '../appSessionState.js';
import { getClientEndpoint } from '../clientEndpointsService.js';
import { getActiveAuthRealm, getCurrentUserId, getDeviceId } from '../authManager.js';
import { serverApiFetch } from '../serverApiClient.desktop.js';
import { outboundFetch, createOutboundHttpAgent } from '../maker-host/outbound-fetch.desktop.js';
import { readRelaySecrets, writeRelaySecrets, relayDataPath, type RelaySecrets } from './selfHostedRelayConfig.js';
import { activeSelfHostedRelay } from './selfHostedRelayRouting.js';
import { withCrossProcessLock } from './crossProcessLock.js';
import { isTemporaryProviderMetadataFailure } from './providerMetadataContinuity.js';

const renewalMargin = 24 * 60 * 60_000;
const inflight = new Map<string, Promise<AgentNetClient>>();
export function officialAgentNetBase(): string { return getClientEndpoint('agentNetApiBaseUrl').replace(/\/+$/, ''); }
/** A stable namespace inside the existing account-scoped encrypted credential store. */
export function officialAgentNetSlot(base = officialAgentNetBase()): string {
  const bytes = createHash('sha256').update(JSON.stringify(['cindy-agent-net/official-vault/2', getActiveAuthRealm(), base])).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 15) | 0x40; bytes[8] = (bytes[8] & 63) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
function identity(slot: string, secrets: RelaySecrets): Identity {
  const stored = secrets.agentNet;
  if (!stored) return identityFromSeed(slot, secrets.seed, getDeviceId());
  const signingPrivateKey = createPrivateKey(stored.signingPrivateKey), transportPrivateKey = createPrivateKey(stored.transportPrivateKey);
  const c = stored.certificate;
  if (stored.version !== 2 || signingPrivateKey.asymmetricKeyType !== 'ed25519' || transportPrivateKey.asymmetricKeyType !== 'x25519'
    || !verifyCertificate(stored.rootPublicKey, c, c.issuedAt) || !c.networkId.startsWith('account:')
    || c.subject !== getCurrentUserId() || c.deviceId !== getDeviceId()
    || c.signingKey !== publicBytes(signingPrivateKey) || c.transportKey !== publicBytes(transportPrivateKey)) throw new Error('AGENT_NET_IDENTITY_MISMATCH');
  return { deviceId: c.deviceId, signingPrivateKey, transportPrivateKey, signingKey: c.signingKey, transportKey: c.transportKey };
}
function client(base: string, secrets: RelaySecrets): AgentNetClient | null {
  const keys = identity(officialAgentNetSlot(base), secrets), stored = secrets.agentNet;
  if (!stored || stored.certificate.expiresAt <= Date.now()) return null;
  return new AgentNetClient(base, keys, stored.certificate, stored.rootPublicKey, undefined, {
    fetch: outboundFetch, createWebSocket: async (url, options) => new WebSocket(url, { ...options, agent: await createOutboundHttpAgent(url) }),
  });
}
export function currentOfficialAgentNetClient(): AgentNetClient | null {
  if (!getCurrentUserId() || isAppSessionBoundaryPending() || activeSelfHostedRelay()) return null;
  const base = officialAgentNetBase(); if (!base) return null;
  const stored = readRelaySecrets(officialAgentNetSlot(base)); return stored ? client(base, stored) : null;
}
/** Enrollment uses the existing token-refreshing account client. Member traffic never carries its token. */
export function ensureOfficialAgentNetClient(name: string): Promise<AgentNetClient> {
  const base = officialAgentNetBase(), scope = activeOwnerScopeKey(), subject = getCurrentUserId(), slot = officialAgentNetSlot(base);
  const assertCurrent = () => {
    if (!base || !subject || activeOwnerScopeKey() !== scope || getCurrentUserId() !== subject || isAppSessionBoundaryPending()
      || activeSelfHostedRelay() || officialAgentNetBase() !== base) throw new Error('AGENT_NET_OWNER_CHANGED');
  };
  assertCurrent();
  const url = new URL(base);
  if (url.username || url.password || url.search || url.hash || (url.protocol !== 'https:'
    && !(url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)))) throw new Error('SECURE_AGENT_NET_URL_REQUIRED');
  const key = scope + '\0' + base;
  const existing = inflight.get(key); if (existing) return existing;
  const locked = async <T>(operation: () => Promise<T> | T): Promise<T> => {
    const lock = relayDataPath('secrets', slot + '.initialize.lock');
    await fs.mkdir(path.dirname(lock), { recursive: true, mode: 0o700 }); assertCurrent();
    return withCrossProcessLock(lock, { label: 'agent-net-identity', waitMs: 3000 }, async (status) => {
      assertCurrent(); if (!status.held) throw new Error('AGENT_NET_IDENTITY_BUSY'); return operation();
    });
  };
  const work = (async () => {
    const secrets = await locked(() => {
      let value = readRelaySecrets(slot, { fresh: true });
      if (!value && existsSync(relayDataPath('secrets', slot + '.enc'))) throw new Error('AGENT_NET_IDENTITY_UNREADABLE');
      if (!value) { value = { credential: 'agent-net-only', seed: randomBytes(32).toString('base64url') }; writeRelaySecrets(slot, value); }
      identity(slot, value); return value;
    });
    const ready = client(base, secrets);
    if (ready && ready.certificate.expiresAt - Date.now() > renewalMargin) return ready;
    const keys = identity(slot, secrets);
    let response: unknown;
    try { response = await serverApiFetch('/api/agent-net/enroll', {
      baseUrl: () => { assertCurrent(); return base; }, method: 'POST', body: createEnrollmentRequest(keys, name.trim().slice(0, 64) || 'Cindy'),
      timeoutMs: 10_000, cache: 'no-store', logLabel: '/api/agent-net/enroll', redactErrorDetails: true,
      allowedRedactedErrorCodes: ['DEVICE_REENROLLMENT_REQUIRES_APPROVAL', 'ACCOUNT_AUTH_INVALID', 'ENROLLMENT_PROOF_INVALID'],
    }); } catch (error) {
      assertCurrent();
      // Early renewal is optional while the original identity is still valid.
      // The socket's existing renewal timer retries without extending expiry.
      if (ready && ready.certificate.expiresAt > Date.now() && isTemporaryProviderMetadataFailure(error)) return ready;
      throw error;
    }
    assertCurrent();
    const enrolled = acceptEnrollment(keys, response, subject!, secrets.agentNet?.rootPublicKey);
    return locked(() => {
      const latest = readRelaySecrets(slot, { fresh: true });
      if (!latest || latest.seed !== secrets.seed) throw new Error('AGENT_NET_IDENTITY_CHANGED');
      const next = { ...latest, agentNet: { version: 2 as const, ...enrolled,
        signingPrivateKey: String(keys.signingPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
        transportPrivateKey: String(keys.transportPrivateKey.export({ type: 'pkcs8', format: 'pem' })),
      } };
      writeRelaySecrets(slot, next); return client(base, next)!;
    });
  })();
  inflight.set(key, work);
  void work.finally(() => { if (inflight.get(key) === work) inflight.delete(key); }).catch(() => undefined);
  return work;
}
