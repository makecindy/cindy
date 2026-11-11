/**
 * 生产入口：验签、配对与媒体加解密；结果是篡改/错钥拒绝，合法随机邀请码不被误拒。
 * 依据：V2 独立身份及端到端加密要求。旧 V1 / Rust 测试不覆盖控制面。
 * 最小输入：以 -/_ 开头的 32 字符邀请码（首次集成测试暴露）；被改动的一字节媒体。
 * tier：unit，无 socket、磁盘或计时等待。
 * 实测耗时：2026-11-07 unit workspace 约 0.9 秒。
 */
import { expect, it, vi } from 'vitest';
import { createHash, generateKeyPairSync } from 'node:crypto';
import { SignJWT, createLocalJWKSet } from 'jose';
import type { IncomingMessage } from 'node:http';
import { sharingIdentityPayload } from '@cindy/agent-net-protocol';
import { createAgentNetSharingAuth } from '../sharingAuth.js';
import { generateIdentity, createRequestProof, createJoinRequest, verifyJoinRequest, approveJoin, issueCertificate, publicBytes, verifyCertificate, createDelegation, verifyDelegation } from '../identity.js';
import { encryptMedia, decryptMedia, AgentNetClient, createTransportModeProof, verifyTransportModeProof } from '../client.js';

// Unit: unlike an account access token, a private-relay identity card can be
// used only with the named network/device signing key and a fresh request proof.
it('verifies scoped sharing identities without accepting access tokens, another root or changed request bytes', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const keys = createLocalJWKSet({ keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'unit-auth', alg: 'RS256' }] });
  const identity = generateIdentity('unit-device'), root = generateIdentity('unit-root').signingKey;
  const issuer = 'https://auth.example.test', networkId = 'private:unit-network';
  const nonce = createHash('sha256').update(sharingIdentityPayload(networkId, root, identity.deviceId, identity.signingKey)).digest('hex');
  const base = { typ: 'identity-card', sub: 'unit-account', device: identity.deviceId, region: 'global', purpose: 'network-session', nonce };
  const card = (audience = 'cindy-agent-net-sharing', overrides: object = {}, lifetime = 300) => new SignJWT({ ...base, ...overrides })
    .setProtectedHeader({ alg: 'RS256', kid: 'unit-auth' }).setIssuer(issuer).setAudience(audience).setIssuedAt()
    .setExpirationTime(Math.floor(Date.now() / 1000) + lifetime).sign(pair.privateKey);
  const auth = createAgentNetSharingAuth({ issuer }, keys);
  const path = '/api/agent-net/sharing/shared-tasks', bytes = Buffer.from('{}');
  const request = (card: string) => ({ method: 'POST', url: path, headers: { authorization: 'AgentNetIdentity ' + Buffer.from(JSON.stringify({
    networkId, deviceId: identity.deviceId, signingKey: identity.signingKey, card, proof: createRequestProof(identity, 'POST', path, bytes),
  })).toString('base64url') } }) as IncomingMessage;
  const context = { rootPublicKey: () => root, remember() {} };
  expect(await auth.authenticate(request(await card()), bytes, context)).toEqual({ accountId: 'unit-account', deviceId: identity.deviceId, networkId });
  await expect(auth.authenticate(request(await card()), Buffer.from('{"changed":true}'), context)).rejects.toMatchObject({ code: 'ACCOUNT_AUTH_INVALID' });
  await expect(auth.authenticate(request(await card()), bytes, { ...context, rootPublicKey: () => identity.signingKey })).rejects.toMatchObject({ code: 'ACCOUNT_AUTH_INVALID' });
  for (const invalid of [await card('cindy', { typ: 'access' }), await card('cindy-provider-share'),
    await card(undefined, { device: 'other-device' }), await card(undefined, {}, 301)])
    await expect(auth.authenticate(request(invalid), bytes, context)).rejects.toMatchObject({ code: 'ACCOUNT_AUTH_INVALID' });
  await expect(auth.authenticate({ headers: { authorization: 'Bearer unit-token' } } as IncomingMessage, bytes, context))
    .rejects.toMatchObject({ code: 'AUTH_REQUIRED' });
});

// Unit: explicit card-only peer trust must preserve V1's realm-qualified guest
// IDs. Same raw membership IDs from two issuers must not become one member.
it('qualifies an allowed peer identity and display card while rejecting unknown issuers and a false region', async () => {
  const pair = generateKeyPairSync('rsa', { modulusLength: 2048 }), jwks = { keys: [{ ...pair.publicKey.export({ format: 'jwk' }), kid: 'peer-unit', alg: 'RS256' }] };
  const issuer = 'https://global.example.test', peer = 'https://cn.example.test';
  const auth = createAgentNetSharingAuth({ issuer, region: 'global', peers: [{ issuer: peer, region: 'cn' }],
    fetch: vi.fn(async () => Response.json(jwks)) as typeof fetch }, createLocalJWKSet(jwks));
  const device = generateIdentity('unit-phone'), networkId = 'private:cross-region', root = generateIdentity('unit-root').signingKey;
  const nonce = createHash('sha256').update(sharingIdentityPayload(networkId, root, device.deviceId, device.signingKey)).digest('hex');
  const card = (claims: object, audience: string, signer = peer) => new SignJWT({ typ: 'identity-card', sub: 'same-id', region: 'cn', ...claims })
    .setProtectedHeader({ alg: 'RS256', kid: 'peer-unit' }).setIssuer(signer).setAudience(audience).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
  const bytes = Buffer.from('{}'), path = '/api/agent-net/sharing/shared-tasks';
  const request = (card: string) => ({ method: 'POST', url: path, headers: { authorization: 'AgentNetIdentity ' + Buffer.from(JSON.stringify({ networkId,
    deviceId: device.deviceId, signingKey: device.signingKey, card, proof: createRequestProof(device, 'POST', path, bytes) })).toString('base64url') } }) as IncomingMessage;
  const claims = { purpose: 'network-session', nonce, device: device.deviceId }, context = { rootPublicKey: () => root, remember() {} };
  expect(await auth.authenticate(request(await card(claims, 'cindy-agent-net-sharing')), bytes, context)).toMatchObject({ accountId: 'x:cn:same-id' });
  for (const invalid of [await card({ ...claims, region: 'global' }, 'cindy-agent-net-sharing'), await card(claims, 'cindy-agent-net-sharing', 'https://unknown.example.test')])
    await expect(auth.authenticate(request(invalid), bytes, context)).rejects.toMatchObject({ code: 'ACCOUNT_AUTH_INVALID' });
  const display = await card({ purpose: 'share-request', nonce: 'a'.repeat(64), name: 'Guest', avatar: null }, 'cindy-provider-share');
  await expect(auth.providers!.identityCards!.verify(display, { purpose: 'share-request', nonce: 'a'.repeat(64), subject: 'x:cn:same-id' })).resolves.toMatchObject({ region: 'cn' });
  await expect(auth.providers!.identityCards!.verify(display, { purpose: 'share-request', nonce: 'a'.repeat(64), subject: 'same-id' })).rejects.toMatchObject({ code: 'PROVIDER_SHARE_IDENTITY_INVALID' });
});

it('binds a signed transport choice to the certified device, recipient, request and freshness', () => {
  const identity = generateIdentity('owner'), stranger = generateIdentity('stranger');
  const root = generateKeyPairSync('ed25519').privateKey;
  const certificate = issueCertificate(root, { networkId: 'net', subject: 'person', identity, role: 'owner' });
  const proof = createTransportModeProof(identity, 'receiver', 'request-1', false);
  expect(verifyTransportModeProof(certificate, 'receiver', 'request-1', proof)).toBe(true);
  for (const changed of [{ ...proof, enabled: true }, { ...proof, to: 'other' }, { ...proof, requestId: 'request-2' },
    { ...proof, unexpected: true }]) {
    expect(verifyTransportModeProof(certificate, 'receiver', 'request-1', changed)).toBe(false);
  }
  expect(verifyTransportModeProof({ ...certificate, signingKey: stranger.signingKey }, 'receiver', 'request-1', proof)).toBe(false);
  const clock = vi.spyOn(Date, 'now').mockReturnValue(proof.at + 90_001);
  try { expect(verifyTransportModeProof(certificate, 'receiver', 'request-1', proof)).toBe(false); }
  finally { clock.mockRestore(); }
});
it('keeps private membership until explicit revocation while official certificates retain short validity', () => {
  const root = generateKeyPairSync('ed25519').privateKey, identity = generateIdentity();
  const certificate = issueCertificate(root, { networkId: 'private:unit-network', subject: 'person', identity, role: 'owner' });
  expect(certificate.expiresAt).toBe(Number.MAX_SAFE_INTEGER);
  expect(() => issueCertificate(root, { networkId: 'account:unit-network', subject: 'person', identity, role: 'owner', lifetimeMs: 365 * 24 * 60 * 60 * 1000 })).toThrow('INVALID_CERTIFICATE_LIFETIME');
});

it.each(['-', '_', 'a'])('accepts a base64url join code beginning with %s while still verifying possession', (prefix) => {
  const identity = generateIdentity();
  const request = createJoinRequest(identity, 'net', prefix + 'a'.repeat(31), 'New device', 'owner-pairing-secret');
  expect(verifyJoinRequest(request)).toBe(true);
  expect(verifyJoinRequest({ ...request, transportKey: generateIdentity().transportKey })).toBe(false);
  const root = generateKeyPairSync('ed25519').privateKey;
  expect(() => approveJoin(root, request, 'wrong-secret', 'person')).toThrow('PAIRING_PROOF_INVALID');
});
it('binds certificate roles, transport keys, delegation expiry and the guest identity', () => {
  const root = generateKeyPairSync('ed25519').privateKey;
  const owner = generateIdentity('owner'), guest = generateIdentity('guest');
  const certificate = issueCertificate(root, { networkId: 'net', subject: 'person', identity: owner, role: 'owner' });
  expect(verifyCertificate(publicBytes(root), certificate)).toBe(true);
  for (const modification of [{ role: 'member' }, { transportKey: guest.transportKey }, { privateKey: 'unexpected-field' }]) {
    expect(verifyCertificate(publicBytes(root), { ...certificate, ...modification })).toBe(false);
  }
  const delegation = createDelegation(owner, certificate, { kind: 'provider-share', resourceId: 'provider', guest, lifetimeMs: 60_000 });
  expect(verifyDelegation(publicBytes(root), delegation)).toBe(true);
  expect(verifyDelegation(publicBytes(root), delegation, delegation.expiresAt)).toBe(false);
  expect(() => new AgentNetClient('http://127.0.0.1:1', generateIdentity('guest'), certificate, publicBytes(root), delegation)).toThrow('IDENTITY_DELEGATION_MISMATCH');
});
it('encrypts media for the recipient only and detects tampering', () => {
  const recipient = generateIdentity(), stranger = generateIdentity();
  const plain = Buffer.from('private payload'), encrypted = encryptMedia(recipient.transportKey, plain);
  expect(decryptMedia(recipient.transportPrivateKey, encrypted)).toEqual(plain);
  expect(Buffer.from(encrypted).includes(plain)).toBe(false);
  expect(() => decryptMedia(stranger.transportPrivateKey, encrypted)).toThrow();
  encrypted[encrypted.length - 1] ^= 1;
  expect(() => decryptMedia(recipient.transportPrivateKey, encrypted)).toThrow();
});
