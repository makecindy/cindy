/**
 * Loopback self-hosted relay for the transfer baseline.
 *
 * Same bootstrap as `packages/device-link-relay/scripts/run-interop.ts`: initialize a
 * relay in a temporary directory, start it on 127.0.0.1 with an OS-assigned port and
 * admit every controller through the real join flow (join code → pair request →
 * owner approval → credential). Credentials stay in process memory and are never printed.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  acceptRelayDeviceCert,
  buildRelayJoinLink,
  createRelayJoinIdentity,
  createRelayPairSecret,
  createRelaySigningKey,
  issueRelayDeviceCert,
  parseRelayJoinLink,
  submitRelayPairRequest,
  verifyRelayPairProof,
  waitForRelayApproval,
  type RelayFetch,
} from '@cindy/device-link';
import { nodeRelayAuthCrypto as crypto } from '@cindy/device-link/node-relay-crypto';
import { createDeviceCredential, initializeRelay, startRelayServer } from '@cindy/device-link-relay';

const OWNER_USER = 'transfer-baseline-account';

export interface BaselineRelayMember {
  deviceId: string;
  deviceName: string;
  platform: 'ios' | 'darwin';
}

export interface BaselineRelay {
  wsUrl: string;
  /** deviceId → CindyRelay credential (memory only). */
  credentials: Map<string, string>;
  close(): Promise<void>;
}

async function call(base: string, method: string, pathname: string, init: { credential?: string; body?: unknown } = {}) {
  const headers: Record<string, string> = {};
  if (init.credential) headers.authorization = `CindyRelay ${init.credential}`;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  if (!res.ok) throw new Error(`relay ${method} ${pathname} failed with ${res.status}`);
  return (await res.json()) as Record<string, unknown>;
}

export async function startBaselineRelay(hostDeviceId: string, members: readonly BaselineRelayMember[]): Promise<BaselineRelay> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-transfer-baseline-relay-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(crypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir,
    name: 'Transfer baseline relay',
    ownerUserId: OWNER_USER,
    ownerDeviceId: hostDeviceId,
    ownerDeviceName: 'Baseline host',
    ownerCredentialHash: owner.credentialHash,
    relayId,
    ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, ownerKey.seed, {
      relayId,
      deviceId: hostDeviceId,
      publicKey: ownerKey.publicKey,
      role: 'owner',
      issuedAt: Date.now(),
    }),
  });
  const relay = await startRelayServer({ dataDir, port: 0, host: '127.0.0.1' });
  const credentials = new Map<string, string>([[hostDeviceId, owner.credential]]);
  try {
    const base = relay.localUrl;
    const relayFetch: RelayFetch = (url, init) => fetch(url, init);
    for (const member of members) {
      const { code } = await call(base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: owner.credential });
      const pairSecret = createRelayPairSecret(crypto);
      const link = parseRelayJoinLink(
        buildRelayJoinLink({ baseUrl: base, code: code as string, ownerPublicKey: ownerKey.publicKey, pairSecret, app: 'cindy' }),
      )!;
      const identity = createRelayJoinIdentity(crypto, link, relayId, member.deviceId);
      const request = await submitRelayPairRequest(relayFetch, link, {
        deviceId: member.deviceId,
        deviceName: member.deviceName,
        platform: member.platform,
        appVersion: '0.0.0-baseline',
        accountUserId: OWNER_USER,
        publicKey: identity.publicKey,
        proof: identity.proof,
      });
      const approval = waitForRelayApproval(relayFetch, link, request, { deadlineMs: 30_000 });
      const { requests } = await call(base, 'GET', '/api/device-link/relay/admin/pair-requests', { credential: owner.credential });
      const pending = (requests as Array<Record<string, string>>).find((r) => r.requestId === request.requestId)!;
      if (!verifyRelayPairProof(crypto, pairSecret, {
        relayId, deviceId: member.deviceId, publicKey: pending.publicKey, proof: pending.proof,
      })) throw new Error('pairing proof mismatch');
      await call(base, 'POST', `/api/device-link/relay/admin/pair-requests/${request.requestId}/approve`, {
        credential: owner.credential,
        body: {
          cert: issueRelayDeviceCert(crypto, ownerKey.seed, {
            relayId, deviceId: member.deviceId, publicKey: pending.publicKey, role: 'member', issuedAt: Date.now(),
          }),
        },
      });
      const admitted = await approval;
      acceptRelayDeviceCert(crypto, link, { relayId, deviceId: member.deviceId, publicKey: identity.publicKey, cert: admitted.cert });
      credentials.set(member.deviceId, admitted.credential);
    }
  } catch (error) {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
    throw error;
  }
  return {
    wsUrl: `${relay.localUrl.replace(/^http/, 'ws')}/api/device-link/ws`,
    credentials,
    async close() {
      await relay.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
