/** Unit + real relay: a phone joins a network that exists only on Agent-Net V2 — the network another
 * account shared with this account (self-hosted-relay-plan.md §5.5), created by this account's computer.
 * There is no V1 credential, so the V2 certificate is the only trust anchor. Minimal failures: a relay that
 * returns a certificate from another root, or one issued to another account, must not be saved; and such a
 * route must never fall back to the unencrypted V1 connection. The relay kernel and SDK signing are real
 * (127.0.0.1); only the native engine, secure storage and AsyncStorage are memory fakes. */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { generateKeyPairSync, randomBytes, randomUUID } from 'node:crypto';
import {
  approveJoin, generateIdentity, identityFromSeed, issueCertificate, publicBytes, signature, startAgentNetRelay,
} from '../../../../packages/agent-net-relay/src/index.js';
import { AgentNetClient } from '../../../../packages/agent-net-relay/src/client.js';
import { buildRelayJoinLink, createRelayPairSecret, createRelaySigningKey, relayPairingVerifyCode, type RelayJoinLink } from '@cindy/device-link';
import { getMobileAuthOwner, setMobileAuthOwner } from '@/auth/authOwnerGeneration';

const fake = vi.hoisted(() => ({ storage: new Map<string, string>() }));
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => fake.storage.get(key) ?? null,
  setItem: async (key: string, value: string) => { fake.storage.set(key, value); },
} }));
vi.mock('expo-crypto', () => ({ randomUUID: () => randomUUID(), getRandomBytes: (size: number) => new Uint8Array(randomBytes(size)) }));
vi.mock('@/device-link/agentNetNative', () => ({ MobileAgentNetEngine: class {
  identity: ReturnType<typeof identityFromSeed>; assertCurrent: () => void;
  constructor(options: { context: string; seed: string; deviceId: string }, guard: () => void) {
    // The native engine keeps the paired signing key (legacySigning): same as identityFromSeed + the seed's own key.
    this.identity = identityFromSeed(options.context, options.seed, options.deviceId); this.assertCurrent = guard;
  }
  static available() { return true; }
  static async create(options: { context: string; seed: string; deviceId: string }, guard: () => void) { guard(); return new this(options, guard); }
  async sign(text: string) { this.assertCurrent(); return signature(this.identity.signingPrivateKey, text); }
  async destroy() {}
} }));

import { joinMobileAgentNetNetwork } from '@/device-link/agentNetPairing';
import { mobileRelayAuthCrypto } from '@/device-link/relayAuthCrypto';
import { getMobileAgentNetPreferences, mobileAgentNetAllowsLegacy, mobileAgentNetRequiresEncryption, waitForMobileAgentNetPreferences } from '@/device-link/agentNetPreferences';
import { setActiveSelfHostedRelay, __testing as routing } from '@/device-link/selfHostedRelayRouting';

const cleanups: Array<() => Promise<void>> = [];
beforeEach(() => { fake.storage.clear(); setMobileAuthOwner('guest-account'); });
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  routing.reset(); setMobileAuthOwner(null); vi.unstubAllGlobals();
});

/** This account's own network on a shared relay, owned by its computer (root held there). */
async function sharedNetwork() {
  const dataDir = await mkdtemp(path.join(tmpdir(), 'cindy-mobile-v2only-'));
  const root = generateKeyPairSync('ed25519').privateKey, rootPublicKey = publicBytes(root);
  const networkUuid = randomUUID(), networkId = 'private:' + networkUuid, computer = generateIdentity('guest-computer');
  const ownerCertificate = issueCertificate(root, { networkId, subject: 'guest-account', identity: computer, role: 'owner' });
  const relay = await startAgentNetRelay({ dataDir, bootstrap: { networkId, name: 'Shared', rootPublicKey, ownerCertificate } });
  cleanups.push(async () => { await relay.close(); await rm(dataDir, { recursive: true, force: true }); });
  const owner = new AgentNetClient(relay.url, computer, ownerCertificate, rootPublicKey);
  const { joinCode } = await owner.request<{ joinCode: string }>('POST', '/join-codes');
  const pairSecret = createRelayPairSecret(mobileRelayAuthCrypto);
  const link: RelayJoinLink = {
    baseUrl: relay.url, ownerPublicKey: rootPublicKey, pairSecret, agentNetCode: joinCode, relayId: networkUuid,
  };
  return { relay, owner, root, link, networkId, pairSecret };
}

const join = (link: RelayJoinLink, onWaiting = vi.fn()) => joinMobileAgentNetNetwork({
  owner: getMobileAuthOwner(), link, deviceId: 'guest-phone', seed: createRelaySigningKey(mobileRelayAuthCrypto).seed,
  name: 'Guest phone', signal: new AbortController().signal, onWaiting,
});

it('joins this account’s V2-only network with only an owner-signed certificate and shows the shared pairing code', async () => {
  const { owner, root, link, networkId, pairSecret } = await sharedNetwork();
  expect(buildRelayJoinLink({ ...link, app: 'cindy' })).toContain('r=' + link.relayId);
  const onWaiting = vi.fn();
  const joining = join(link, onWaiting);
  // The owner computer sees the request and approves it as this account's member.
  let requests: Array<{ requestId: string; pairingProof: string }> = [];
  await vi.waitFor(async () => {
    requests = (await owner.request<{ requests: typeof requests }>('GET', '/join-requests')).requests;
    expect(requests).toHaveLength(1);
  }, { timeout: 5_000 });
  const request = requests[0] as Parameters<typeof approveJoin>[1];
  expect(onWaiting).toHaveBeenCalledWith(relayPairingVerifyCode(mobileRelayAuthCrypto, request.pairingProof));
  await owner.request('POST', '/join-requests/' + request.requestId + '/approve', { certificate: approveJoin(root, request, pairSecret, 'guest-account') });
  const membership = await joining;
  expect(membership).toMatchObject({ version: 2, networkId, rootPublicKey: link.ownerPublicKey });
  expect(membership.certificate).toMatchObject({ networkId, deviceId: 'guest-phone', subject: 'guest-account', role: 'member' });
}, 20_000);

it('refuses a certificate from another root or for another account even when the relay says approved', async () => {
  const root = generateKeyPairSync('ed25519').privateKey, rootPublicKey = publicBytes(root);
  const networkUuid = randomUUID(), networkId = 'private:' + networkUuid;
  const link: RelayJoinLink = { baseUrl: 'https://relay.example.test', ownerPublicKey: rootPublicKey,
    pairSecret: 'S'.repeat(43), agentNetCode: 'V'.repeat(32), relayId: networkUuid };
  for (const forged of ['other-root', 'other-account'] as const) {
    let submitted: { deviceId: string; signingKey: string; transportKey: string } | null = null;
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      if (url.endsWith('/api/agent-net/join')) {
        submitted = JSON.parse(String(init.body));
        return Response.json({ requestId: 'x', pollToken: 'p'.repeat(43) }, { status: 202 });
      }
      const signer = forged === 'other-root' ? generateKeyPairSync('ed25519').privateKey : root;
      const certificate = issueCertificate(signer, { networkId, subject: forged === 'other-account' ? 'someone-else' : 'guest-account',
        identity: { deviceId: submitted!.deviceId, signingKey: submitted!.signingKey, transportKey: submitted!.transportKey }, role: 'member' });
      return Response.json({ status: 'approved', rootPublicKey, certificate });
    }));
    await expect(join(link)).rejects.toMatchObject({ code: 'OWNER_MISMATCH' });
  }
}, 20_000);

it('never allows the unencrypted V1 connection on a V2-only route, whatever the Agent-Net switch says', async () => {
  await waitForMobileAgentNetPreferences();
  // 未保存偏好的新安装和旧版升级均默认关闭，主动加入的 V2-only 网络另按自己的授权运行。
  expect(getMobileAgentNetPreferences()).toMatchObject({ ready: true, enabled: false, onlyEncrypted: false });
  expect(mobileAgentNetAllowsLegacy()).toBe(true);
  setActiveSelfHostedRelay({ relayId: randomUUID(), name: 'Shared', baseUrl: 'https://relay.example.test', credential: null,
    signing: null, agentNetOnly: true, shared: { ownerName: 'Alice' } });
  expect(mobileAgentNetRequiresEncryption()).toBe(true);
  expect(mobileAgentNetAllowsLegacy()).toBe(false);
});
