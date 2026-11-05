/**
 * 用现有的 device-link 互通测试(`pnpm test:device-link --interop`)验证自建中转:
 *
 * 1. 在临时目录初始化一个中转,主人电脑凭证在本进程生成;
 * 2. 在本机回环地址启动中转;
 * 3. 走真实的加入流程(加入码 → 申请 → 主人同意 → 取回凭证)拿到第二台设备的凭证;
 * 4. 以 `CindyRelay` 方案把两份凭证交给互通测试,由正式 DeviceLinkClient 与 Mobile 恢复核心连接;
 *    同时交出两台设备的签名密钥与中转上的证书,互通测试全程开启设备签名(主机核对每一条对端消息);
 * 5. 结束后关闭中转、删除临时目录。
 *
 * 凭证只经子进程环境变量传递,不打印。
 */
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
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
import { createDeviceCredential, initializeRelay, startRelayServer } from '../src/index';

const repoRoot = fileURLToPath(new URL('../../../', import.meta.url));
const OWNER_USER = 'interop-account';

async function call(base: string, method: string, pathname: string, init: { credential?: string; body?: unknown; pollToken?: string } = {}) {
  const headers: Record<string, string> = {};
  if (init.credential) headers.authorization = `CindyRelay ${init.credential}`;
  if (init.pollToken) headers['x-cindy-relay-poll-token'] = init.pollToken;
  if (init.body !== undefined) headers['content-type'] = 'application/json';
  const res = await fetch(`${base}${pathname}`, {
    method,
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
  const json = (await res.json()) as Record<string, any>;
  if (!res.ok) throw new Error(`${method} ${pathname} failed: ${res.status} ${json.error?.code ?? ''}`);
  return json;
}

async function main(): Promise<number> {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), 'cindy-relay-interop-'));
  const owner = createDeviceCredential();
  const ownerKey = createRelaySigningKey(crypto);
  const relayId = randomUUID();
  await initializeRelay({
    dataDir,
    name: 'Interop relay',
    ownerUserId: OWNER_USER,
    ownerDeviceId: 'interop-owner-desktop',
    ownerDeviceName: 'Interop host',
    ownerCredentialHash: owner.credentialHash,
    relayId,
    ownerPublicKey: ownerKey.publicKey,
    ownerCert: issueRelayDeviceCert(crypto, ownerKey.seed, {
      relayId,
      deviceId: 'interop-owner-desktop',
      publicKey: ownerKey.publicKey,
      role: 'owner',
      issuedAt: Date.now(),
    }),
  });
  const relay = await startRelayServer({ dataDir, port: 0 });
  try {
    const base = relay.localUrl;
    // 与 Desktop / Mobile 相同的加入路径:主人生成加入链接,新设备解析链接、申请、等主人同意。
    const { code } = await call(base, 'POST', '/api/device-link/relay/admin/join-codes', { credential: owner.credential });
    const pairSecret = createRelayPairSecret(crypto);
    const link = parseRelayJoinLink(
      buildRelayJoinLink({ baseUrl: base, code, ownerPublicKey: ownerKey.publicKey, pairSecret, app: 'cindy' }),
    )!;
    const relayFetch: RelayFetch = (url, init) => fetch(url, init);
    const deviceId = 'interop-controller-phone';
    const identity = createRelayJoinIdentity(crypto, link, relayId, deviceId);
    const request = await submitRelayPairRequest(relayFetch, link, {
      deviceId,
      deviceName: 'Interop controller',
      platform: 'ios',
      appVersion: '0.0.0-test',
      accountUserId: OWNER_USER,
      publicKey: identity.publicKey,
      proof: identity.proof,
    });
    const approval = waitForRelayApproval(relayFetch, link, request, { deadlineMs: 30_000 });
    // 主人电脑:核对配对证明后签发证书并同意。
    const { requests } = await call(base, 'GET', '/api/device-link/relay/admin/pair-requests', { credential: owner.credential });
    const pending = (requests as Array<Record<string, string>>).find((r) => r.requestId === request.requestId)!;
    if (!verifyRelayPairProof(crypto, pairSecret, { relayId, deviceId, publicKey: pending.publicKey, proof: pending.proof })) {
      throw new Error('pairing proof mismatch');
    }
    await call(base, 'POST', `/api/device-link/relay/admin/pair-requests/${request.requestId}/approve`, {
      credential: owner.credential,
      body: {
        cert: issueRelayDeviceCert(crypto, ownerKey.seed, { relayId, deviceId, publicKey: pending.publicKey, role: 'member', issuedAt: Date.now() }),
      },
    });
    const admitted = await approval;
    acceptRelayDeviceCert(crypto, link, { relayId, deviceId, publicKey: identity.publicKey, cert: admitted.cert });
    console.log('[relay-interop] relay started on loopback; controller paired through the join flow');

    const { certs } = await call(base, 'GET', '/api/device-link/relay/certs', { credential: owner.credential });

    return await new Promise<number>((resolve) => {
      const child = spawn(process.execPath, ['apps/mobile/scripts/device-link-reconnect-smoke.mjs', '--interop'], {
        cwd: repoRoot,
        stdio: 'inherit',
        env: {
          ...process.env,
          CINDY_TEST_RELAY_URL: `${base.replace(/^http/, 'ws')}/api/device-link/ws`,
          CINDY_TEST_HOST_TOKEN: owner.credential,
          CINDY_TEST_CONTROLLER_TOKEN: admitted.credential,
          CINDY_TEST_AUTH_SCHEME: 'CindyRelay',
          CINDY_TEST_FRAME_AUTH: JSON.stringify({
            relayId,
            ownerPublicKey: ownerKey.publicKey,
            certs,
            host: { deviceId: 'interop-owner-desktop', seed: ownerKey.seed },
            controller: { deviceId, seed: identity.seed },
          }),
        },
      });
      child.on('exit', (exitCode, signal) => resolve(exitCode ?? (signal ? 1 : 0)));
      child.on('error', () => resolve(1));
    });
  } finally {
    await relay.close();
    await rm(dataDir, { recursive: true, force: true });
  }
}

main().then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error: unknown) => {
    console.error(`[relay-interop] ${error instanceof Error ? error.message : 'failed'}`);
    process.exitCode = 1;
  },
);
