/** Unit: explicit V2 invitations pin an external relay/root/resource; the V1
 * configured-server restriction must not be widened. Minimal malformed inputs
 * cover credential URLs, scope confusion and ambiguous handoffs. No I/O. */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { AgentNetClient, openEncryptedMedia, uploadEncryptedMedia } from '@cindy/agent-net-relay/client';
import { startAgentNetRelay } from '@cindy/agent-net-relay';
import { expect, it, vi } from 'vitest';
import { parseSharedTaskInvitation } from '@cindy/device-link';
import { encodeAgentNetSharingInvitation, decodeAgentNetSharingInvitation, buildAgentNetSharingInvitation,
  parseAgentNetSharingInvitation, type AgentNetSharingInvitation } from '../sharingInvitation.js';
import { toBase64Url, utf8 } from '../portableBytes.js';
import { syncAgentNetSharingOrigins } from '../sharingOrigins.js';
import { createPrivateNetwork, createDelegation, generateIdentity, issueCertificate, signature, verifyCertificate, verifySignature, verifyDelegation } from '@cindy/agent-net-relay';
import { sharingOriginsPayload } from '@cindy/agent-net-protocol';
import { AgentNetSharingClient } from '../sharingClient.js';
import { AgentNetSharingTransport } from '../sharingTransport.js';

const receipt: AgentNetSharingInvitation = { v: 2, kind: 'shared-task', invitation: 'A'.repeat(43), networkId: 'private:unit-network',
  rootPublicKey: toBase64Url(new Uint8Array(32).fill(17)), resourceId: 'unit-resource', hostDeviceId: 'unit-host', region: 'global' };
// Unit: a same-account relay may return public endpoints, but cannot forge
// another device's origin signature or substitute its root. The previous URL
// parser tests do not cover origin recovery. Real keys, memory HTTP port.
it('syncs only device-signed public origins from the pinned own-account network', async () => {
  const { identity, root, bootstrap } = createPrivateNetwork('Own network'), other = generateIdentity('other-device');
  const cert = issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity: other, role: 'member' });
  const origin = { server: 'https://friend.example.test', networkId: 'private:friend', rootPublicKey: bootstrap.rootPublicKey, region: 'global' as const };
  const plain = { v: 2 as const, networkId: bootstrap.networkId, certificate: cert, issuedAt: Date.now(), origins: [origin] };
  const doc = { ...plain, signature: signature(other.signingPrivateKey, sharingOriginsPayload(plain)) };
  const request = vi.fn(async (method: string, _resource: string, body?: any): Promise<any> => {
    if (method === 'POST') {
      expect(verifySignature(identity.signingKey, sharingOriginsPayload(body), body.signature)).toBe(true);
      expect(body.origins).toEqual([origin]); return { ok: true };
    }
    return { origins: [doc, { ...doc, origins: [{ ...origin, rootPublicKey: identity.signingKey }] }] };
  });
  const found = await syncAgentNetSharingOrigins({ client: { certificate: bootstrap.ownerCertificate, rootPublicKey: bootstrap.rootPublicKey, request },
    signer: { identity, sign: async text => signature(identity.signingPrivateKey, text), random: async () => '' },
    origins: [origin], assertCurrent() {}, verifyCertificate, verifySignature });
  expect(found).toEqual([origin]); expect(request).toHaveBeenCalledTimes(2);
});
// Unit: a still-valid 50-second response is an old lease, not a fresh renewal.
// Returning it caused repeated socket restarts once per second. Real host
// signatures + fake HTTP/time isolate this untested lease boundary.
it('waits for a fresh host signature instead of accepting the expiring lease again', async () => {
  vi.useFakeTimers();
  const { identity: host, bootstrap } = createPrivateNetwork('Lease fixture'), guest = generateIdentity('guest');
  const scope = { memberId: 'member', guestSubject: 'guest-account', memberVersion: 1 };
  const old = createDelegation(host, bootstrap.ownerCertificate, { kind: 'shared-task', resourceId: 'task', guest, scope, lifetimeMs: 50_000 });
  const fresh = createDelegation(host, bootstrap.ownerCertificate, { id: old.id, kind: old.kind, resourceId: old.resourceId, guest, scope });
  const signer = { identity: guest, sign: async (text: string) => signature(guest.signingPrivateKey, text), random: async () => toBase64Url(new Uint8Array(18).fill(5)) };
  let calls = 0;
  const client = new AgentNetSharingClient({ base: 'https://relay.example.test', networkId: bootstrap.networkId, rootPublicKey: bootstrap.rootPublicKey,
    signer, assertCurrent() {}, hash: bytes => bytes, getIdentityCard: async () => ({ card: 'unit-card', expiresAt: new Date(Date.now() + 300_000).toISOString() }),
    fetch: async () => Response.json({ id: old.id, status: 'ready', networkId: bootstrap.networkId, rootPublicKey: bootstrap.rootPublicKey,
      certificate: bootstrap.ownerCertificate, delegation: ++calls === 1 ? old : fresh }) });
  const lease = new AgentNetSharingTransport({ client, applicant: signer, assertCurrent() {}, verifyCertificate, verifyDelegation,
    scope: { kind: old.kind, resourceId: old.resourceId, networkId: old.networkId, rootPublicKey: bootstrap.rootPublicKey, hostDeviceId: host.deviceId, memberId: scope.memberId, guestSubject: scope.guestSubject } });
  try { const pending = lease.acquire(); await vi.advanceTimersByTimeAsync(251); expect(await pending).toEqual(fresh); expect(calls).toBe(2); }
  finally { lease.close(); client.close(); vi.useRealTimers(); }
});
it.each(['shared-task', 'provider-share'] as const)('round-trips a %s web invitation and existing Cindy native handoff with the same pinned scope', kind => {
  const value = { ...receipt, kind }, server = 'https://relay.example.test';
  const link = buildAgentNetSharingInvitation(value, server, 'cindycn');
  expect(parseAgentNetSharingInvitation('Join here: ' + link, kind)).toEqual({ server, receipt: value });
  const native = 'cindycn://' + kind + '/join?invitation=' + encodeURIComponent(encodeAgentNetSharingInvitation(value))
    + '&server=' + encodeURIComponent(server);
  expect(parseAgentNetSharingInvitation(native, kind)).toEqual({ server, receipt: value });
  const url = new URL(link);
  expect(url.search).toBe(''); expect(url.pathname).not.toContain(receipt.invitation);
  expect(decodeAgentNetSharingInvitation(url.hash.slice(1).split('?')[0])).toEqual(value);
  expect(parseSharedTaskInvitation(server + '/shared-task/join#' + receipt.invitation, 'https://another.example.test'))
    .toEqual({ ok: false, reason: 'different-server' });
});
it('rejects altered receipt shape, mismatched kind and insecure or ambiguous handoffs', () => {
  const link = buildAgentNetSharingInvitation(receipt, 'https://relay.example.test');
  const raw = (value: object) => 'an2.' + toBase64Url(utf8(JSON.stringify(value)));
  for (const value of [{ ...receipt, v: 4 }, { ...receipt, v: 3, networkId: 'account:user' }, { ...receipt, kind: 'full-device' }, { ...receipt, rootPublicKey: 'bad' },
    { ...receipt, unexpected: 'field' }]) expect(decodeAgentNetSharingInvitation(raw(value))).toBeNull();
  for (const value of [link + ' ' + link, link.replace('https://', 'http://'), link.replace('relay.', 'user:pass@relay.'),
    link.replace('/shared-task/', '/provider-share/'), link + '&unexpected=1']) expect(parseAgentNetSharingInvitation(value)).toBeNull();
  expect(parseAgentNetSharingInvitation(link, 'provider-share')).toBeNull();
  expect(() => buildAgentNetSharingInvitation(receipt, 'http://192.168.10.2')).toThrow('SECURE_SHARING_INVITATION_REQUIRED');
});

// Integration: exercise real member and guest HTTP proofs on a self-hosted relay with no account service.
// The existing invitation and transport tests substitute HTTP responses and cannot detect a wire mismatch.
it('creates, joins and revokes private shares using only the selected relay', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'agent-net-private-share-'));
  const { bootstrap, identity } = createPrivateNetwork('private sharing');
  const relay = await startAgentNetRelay({ dataDir: directory, bootstrap });
  try {
    const member = new AgentNetClient(relay.url, identity, bootstrap.ownerCertificate, bootstrap.rootPublicKey);
    const noCard = vi.fn(async (): Promise<never> => { throw new Error('Account service offline'); });
    const make = (owner: boolean) => {
      const signerIdentity = generateIdentity(owner ? identity.deviceId : 'external');
      return new AgentNetSharingClient({ base: relay.url, networkId: bootstrap.networkId, rootPublicKey: bootstrap.rootPublicKey,
        privateSharing: true, signer: { identity: signerIdentity, sign: async value => signature(signerIdentity.signingPrivateKey, value),
          random: async () => randomBytes(18).toString('base64url') }, hash: bytes => createHash('sha256').update(bytes).digest(),
        assertCurrent() {}, getIdentityCard: noCard, memberAuthorization: owner ? (m, p, b) => member.header(m, p, b) : undefined,
        fetch: (url, options) => {
          expect(new URL(String(url)).origin).toBe(relay.url);
          const authorization = new Headers(options?.headers).get('authorization')!;
          const proof = JSON.parse(Buffer.from(authorization.slice('AgentNetPrivate '.length), 'base64url').toString());
          expect(Object.keys(proof).sort()).toEqual(['networkId', 'proof', 'signingKey']);
          return fetch(url, options);
        } });
    };
    const host = make(true), guest = make(false), base = '/api/device-link/shared-tasks';
    const { sharedTaskId } = await host.request<{ sharedTaskId: string }>(base, { method: 'POST', body: { sessionId: 'session', title: 'Private task' } });
    const resource = base + '/' + sharedTaskId;
    const { invitation } = await host.request<{ invitation: string }>(resource + '/invites', { method: 'POST', body: {} });
    const { memberId } = await guest.request<{ memberId: string }>(base + '/join', { method: 'POST', body: { invitation, displayName: 'Guest' } });
    await expect(guest.request(resource, { method: 'GET' })).resolves.toBeTruthy();
    const transportId = 'guest:' + guest.options.signer.identity.signingKey;
    const transportIdentity = generateIdentity(transportId);
    const applicant = { identity: transportIdentity, sign: async (value: string) => signature(transportIdentity.signingPrivateKey, value),
      random: async () => randomBytes(18).toString('base64url') };
    const pending = await guest.request<{ id: string }>('/api/agent-net/sharing/transport', { method: 'POST', applicant,
      body: { kind: 'shared-task', resourceId: sharedTaskId, memberId, signingKey: transportIdentity.signingKey, transportKey: transportIdentity.transportKey } });
    const listing = await member.request<{ delegationRequests: import('@cindy/agent-net-protocol').DelegationRequest[] }>('GET', '/directory');
    const request = listing.delegationRequests.find(r => r.id === pending.id)!;
    const grant = await member.acceptDelegationRequest(request, () => undefined);
    const visiting = new AgentNetClient(relay.url, transportIdentity, bootstrap.ownerCertificate, bootstrap.rootPublicKey, grant);
    const uplink = await visiting.connect();
    uplink.close();
    const plain = randomBytes(8192);
    const uploaded = await uploadEncryptedMedia(visiting, identity.deviceId, identity.transportKey, plain.length,
      async (offset, length) => plain.subarray(offset, offset + length));
    const opened = await openEncryptedMedia(member, uploaded.id, uploaded.headerSha256, undefined, 'application/octet-stream');
    expect(Buffer.from(await opened.arrayBuffer())).toEqual(plain);
    await expect(make(false).request(resource, { method: 'GET' })).rejects.toThrow();
    await host.request(resource + '/members/' + memberId + '/remove', { method: 'POST', body: {} });
    await expect(guest.request(resource, { method: 'GET' })).rejects.toThrow();
    await expect(visiting.directory()).rejects.toThrow();
    const providers = '/api/device-link/provider-shares';
    const link = await host.request<{ invitation: string; shareId: string }>(providers + '/links', { method: 'POST',
      body: { providerId: 'local-provider', providerLabel: 'Provider', deviceName: 'Host', identityCard: 'private-device' } });
    const proposed = await guest.request<{ requestId: string; status: string }>(providers + '/requests', { method: 'POST',
      body: { invitation: link.invitation, identityCard: 'private-device' } });
    expect(proposed.status).toBe('pending');
    await expect(guest.request(providers + '/requests/' + proposed.requestId + '/approve', { method: 'POST', body: {} })).rejects.toThrow();
    const approved = await host.request<{ shareId: string }>(providers + '/requests/' + proposed.requestId + '/approve', { method: 'POST', body: {} });
    expect(approved.shareId).toBe(link.shareId);
    expect(noCard).not.toHaveBeenCalled();
  } finally {
    await relay.close();
    await rm(directory, { recursive: true, force: true });
  }
});
