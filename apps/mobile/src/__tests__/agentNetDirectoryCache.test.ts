/**
 * 测试价值
 * - 生产入口与可观察结果：手机冷启动读 Agent-Net 名册缓存（readMobileAgentNetDirectory）。记录完好时原样读回，
 *   其中的证书不再逐个做 Ed25519 验签，之后连接建立过程里对同一批证书的校验也命中「已验证」；记录被改过时
 *   读不出来，被改的证书也不会被当成已验证。
 * - Bug／规则依据：2026-11-21 真机，24 台设备的名册每次冷启动都重新验签，纯 JS 每张约 28 毫秒，共约 0.7 秒；
 *   同时「不验签」只能发生在本机自己写入、且用本机密钥证明完好的记录上（relayAuthCrypto.ts 的 rememberVerifiedSignature）。
 * - 现有覆盖缺口：agentNetRuntime、agentNetDeviceApi 两个套件都把这个模块整个替换掉，真实的读写与校验顺序没有测试。
 * - 最小失败输入：一条含两张证书的完好记录；同一条记录改掉一个字节；换一把密钥写出的记录。
 * - tier：unit，真实证书与校验，存储在内存里；每个用例重新加载模块一次，模拟冷启动后空的「已验证」记录。
 */
import { beforeEach, expect, it, vi } from 'vitest';
import type { DeviceView } from '@cindy/agent-net-protocol';
import { createPrivateNetwork, generateIdentity, issueCertificate } from '../../../../packages/agent-net-relay/src/index.js';

const stored = vi.hoisted(() => new Map<string, string>());
vi.mock('@react-native-async-storage/async-storage', () => ({ default: {
  getItem: async (key: string) => stored.get(key) ?? null,
  setItem: async (key: string, value: string) => { stored.set(key, value); },
} }));
vi.mock('expo-crypto', () => ({ getRandomBytes: (size: number) => new Uint8Array(size) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({ accountKey: 'account-key', accountId: 'account' }) }));

const local = generateIdentity('phone'), computers = [generateIdentity('computer-a'), generateIdentity('computer-b')];
const { root, bootstrap } = createPrivateNetwork('Roster cache', local);
const devices: DeviceView[] = computers.map(identity => ({
  certificate: issueCertificate(root, { networkId: bootstrap.networkId, subject: bootstrap.ownerCertificate.subject, identity, role: 'member' }),
  name: identity.deviceId, online: true, remoteControlEnabled: true, capabilities: [],
}));
const identityWith = (seed: string) => ({
  seed, signer: { assertCurrent() {} },
  api: { base: 'https://relay.example.test', rootPublicKey: bootstrap.rootPublicKey, certificate: bootstrap.ownerCertificate, identity: local },
}) as never;
const SEED = Buffer.alloc(32, 7).toString('base64url');

/** A cold start: nothing is recorded as verified yet. Returns the modules and how often Ed25519 really ran since. */
async function coldStart() {
  // reset-modules: 被测行为就是 App 重启——「验过的签名」只记在进程内存里，重启后为空，生产代码没有也不该有清空它的入口
  vi.resetModules();
  const { ed25519 } = await import('@noble/curves/ed25519');
  const verify = vi.spyOn(ed25519, 'verify');
  const cache = await import('@/device-link/agentNetDirectoryCache');
  const protocol = await import('@/device-link/agentNetProtocol');
  return { cache, protocol, verify };
}

beforeEach(() => { stored.clear(); vi.restoreAllMocks(); });

it('reads an intact roster back without verifying its certificates again', async () => {
  const writer = await coldStart();
  await writer.cache.writeMobileAgentNetDirectory(identityWith(SEED), devices);
  expect(writer.verify).toHaveBeenCalledTimes(devices.length);

  const { cache, protocol, verify } = await coldStart();
  const read = await cache.readMobileAgentNetDirectory(identityWith(SEED));
  expect(read?.devices).toEqual(devices);
  // The connection that follows checks the same certificates (AgentNetSocket.updateDirectory, authorized): still no Ed25519.
  for (const view of devices) expect(protocol.verifyMobileAgentNetCertificate(bootstrap.rootPublicKey, view.certificate, view.certificate.issuedAt)).toBe(true);
  expect(verify).not.toHaveBeenCalled();
});

it.each([
  ['a changed certificate', (raw: string) => raw.replace(devices[0].certificate.transportKey, computers[1].transportKey)],
  ['a record written with another key', (raw: string) => raw],
] as const)('reads nothing from %s and does not take its certificates for verified', async (name, change) => {
  const writer = await coldStart();
  await writer.cache.writeMobileAgentNetDirectory(identityWith(name === 'a record written with another key' ? Buffer.alloc(32, 9).toString('base64url') : SEED), devices);
  const [slot, raw] = [...stored.entries()][0];
  stored.set(slot, change(raw));

  const { cache, protocol, verify } = await coldStart();
  expect(await cache.readMobileAgentNetDirectory(identityWith(SEED))).toBeNull();
  expect(verify).not.toHaveBeenCalled();
  // Nothing was recorded: the certificate as stored still has to pass a real verification, and the changed one fails it.
  const first = (JSON.parse(stored.get(slot)!) as { devices: DeviceView[] }).devices[0].certificate;
  expect(protocol.verifyMobileAgentNetCertificate(bootstrap.rootPublicKey, first, first.issuedAt)).toBe(name !== 'a changed certificate');
  expect(verify).toHaveBeenCalledOnce();
});
