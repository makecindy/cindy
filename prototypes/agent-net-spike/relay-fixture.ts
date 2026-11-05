/**
 * 本机起一个自建中转（`packages/device-link-relay` 的内核），走正式的加入流程登记设备，只给验证脚本用。
 * 第一个设备是主人，其余的用加入码申请、主人签发证书同意、取回凭证，和 Desktop / Mobile 加入时一样。
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  computeRelayPairProof,
  createRelayPairSecret,
  createRelaySigningKey,
  issueRelayDeviceCert,
} from '../../packages/device-link/src/index';
import { nodeRelayAuthCrypto as crypto } from '../../packages/device-link/src/nodeRelayCrypto';
import { createDeviceCredential, initializeRelay, startRelayServer } from '../../packages/device-link-relay/src/index';

const OWNER_USER = 'spike-account';

export interface RelayFixture {
  /** 中转的基础地址，例如 `http://127.0.0.1:50123`。 */
  url: string;
  /** 设备号 → 凭证。 */
  credentials: Map<string, string>;
  close(): Promise<void>;
}

async function call(base: string, method: string, pathname: string, init: { credential?: string; body?: unknown; pollToken?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.credential) headers.authorization = `CindyRelay ${init.credential}`;
  if (init.pollToken) headers['x-cindy-relay-poll-token'] = init.pollToken;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, { method, headers, body: init.body === undefined ? undefined : JSON.stringify(init.body) });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${method} ${pathname} failed: ${res.status} ${json.error?.code ?? ''}`);
  return json;
}

export interface RelayFixtureOptions {
  agentNet?: boolean;
  /** 监听端口，默认随机。 */
  port?: number;
  /** 其他设备访问中转用的地址，放在前置代理后面时填。 */
  publicUrl?: string;
}

export async function startRelay(deviceIds: string[], options: RelayFixtureOptions = {}): Promise<RelayFixture> {
  const [ownerDeviceId, ...members] = deviceIds;
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'agent-net-spike-relay-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(crypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir,
    name: 'agent-net spike relay',
    ownerUserId: OWNER_USER,
    ownerDeviceId,
    ownerDeviceName: ownerDeviceId,
    ownerCredentialHash: owner.credentialHash,
    relayId,
    ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, ownerKey.seed, { relayId, deviceId: ownerDeviceId, publicKey: ownerKey.publicKey, role: 'owner', issuedAt: Date.now() }),
  });
  const relay = await startRelayServer({
    dataDir,
    port: options.port ?? 0,
    agentNet: options.agentNet ?? true,
    ...(options.publicUrl ? { publicUrl: options.publicUrl, trustProxyHeaders: true } : {}),
  });
  const base = relay.localUrl;
  const credentials = new Map([[ownerDeviceId, owner.credential]]);
  for (const deviceId of members) {
    const { code } = await call(base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: owner.credential });
    const key = createRelaySigningKey(crypto);
    const proof = computeRelayPairProof(crypto, createRelayPairSecret(crypto), { relayId, deviceId, publicKey: key.publicKey });
    const submitted = await call(base, 'POST', '/api/device-link/relay/pair', {
      body: { code, deviceId, deviceName: deviceId, platform: 'darwin', appVersion: 'spike', accountUserId: OWNER_USER, publicKey: key.publicKey, proof },
    });
    await call(base, 'POST', `/api/device-link/relay/admin/pair-requests/${submitted.requestId}/approve`, {
      credential: owner.credential,
      body: { cert: issueRelayDeviceCert(crypto, ownerKey.seed, { relayId, deviceId, publicKey: key.publicKey, role: 'member', issuedAt: Date.now() }) },
    });
    const polled = await call(base, 'GET', `/api/device-link/relay/pair/${submitted.requestId}`, { pollToken: submitted.pollToken });
    if (polled.status !== 'approved') throw new Error(`pairing ${deviceId} was not approved`);
    credentials.set(deviceId, polled.credential as string);
  }
  return {
    url: base,
    credentials,
    async close() {
      await relay.close();
      await rm(dataDir, { recursive: true, force: true });
    },
  };
}
