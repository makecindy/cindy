/** 测试价值
 * - 生产入口与可观察结果：createAgentNetNode 的身份与注册（Node Host 接入 Agent-Net 用的共用主体，不依赖 Electron）。
 *   第一次用账号令牌注册一次，身份（种子、证书、私钥）只写进宿主给的凭证库那一条记录；重启后直接用存下的证书，不再注册；
 *   换了账号各用各的记录；离到期不到一天时重新注册，注册失败而证书还没到期就继续用旧的。关着 Agent-Net 重启后，
 *   旧版链路的签名声明（「我现在没开」）仍用存下的身份签，不注册；从没加入过的 Host 不签，别的账号不签。
 * - Bug／规则依据：docs/dev-rules/credentials-and-local-storage.md「运行时需要持久化秘密时，复用现有宿主管理的 credential store」；
 *   docs/agent-net-session-plan.md 阶段 5 Node Host 接入。2026-11-17 真机：Host 关掉 Agent-Net 后，开着 Agent-Net 的同账号
 *   Desktop 认得它、要它的声明，它不签，每次调用都是 Untrusted transport mode（Desktop 关着时照样签，见 agentNetRuntime.ts）。
 * - 现有覆盖缺口：新模块；Desktop 的同类逻辑（agentNetOfficial.ts）绑在 Electron 的凭证存储上，Host 用不了。
 * - 最小失败输入：一次首次启动、一次重启、一次换账号、一次快到期且注册失败；一次加入后关着重启；关着超过证书有效期
 *   （2026-11-17 用户选「放宽校验」：原来证书过期后不再签，开着 Agent-Net 的电脑连 Device Link 都拒收它）。
 *   官方服务连不上时重启：用上次存下的名册起来（2026-11-17：原来没有缓存，Host 在服务出故障时重启就一直连不上 Agent-Net）。
 * - tier：unit，内存凭证库，假注册服务（真实的证书签发与校验），不开网络、不起 worker（打开 worker 连接的那一步换成记录参数）。 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { EventEmitter } from 'node:events';
import { AgentNetWorkerSocket } from '@cindy/agent-net';
import { createPrivateNetwork, generateIdentity, issueCertificate } from '@cindy/agent-net-relay';
import { createTransportModeProof, verifyTransportModeProof } from '@cindy/agent-net-relay/client';
import { createAgentNetNode, type AgentNetNodePorts } from '../agentNetNode';
import { acceptTransportStatement } from '../agentNetTransportStatement';

const { root, bootstrap } = createPrivateNetwork('Unit official network', generateIdentity('unit-root-owner'));

function fixture() {
  const records = new Map<string, string>();
  const state = { subject: 'account-a', lifetimeMs: 7 * 24 * 60 * 60_000, enrollments: 0, failEnrollment: false, enabled: true };
  const ports: AgentNetNodePorts = {
    base: () => 'https://agent-net.example.test', subject: () => state.subject, deviceId: () => 'host-device', deviceName: () => 'Unit Host',
    enabled: () => state.enabled, current: () => true,
    readSecret: async (key) => records.get(key) ?? null,
    writeSecret: async (key, value) => { records.set(key, value); },
    enroll: async (_base, body) => {
      state.enrollments++;
      if (state.failEnrollment) throw new Error('ENROLLMENT_SERVICE_UNAVAILABLE');
      const request = body as { deviceId: string; signingKey: string; transportKey: string };
      return { rootPublicKey: bootstrap.rootPublicKey, certificate: issueCertificate(root, { networkId: 'account:unit', subject: state.subject,
        identity: request, role: 'member', lifetimeMs: state.lifetimeMs }) };
    },
    fetch: async () => { throw new Error('NO_NETWORK_IN_UNIT_TEST'); },
    createWebSocket: async () => { throw new Error('NO_NETWORK_IN_UNIT_TEST'); },
    workerFile: () => null, coreModule: async () => { throw new Error('NO_CORE_IN_UNIT_TEST'); },
    log: { info() {}, warn() {} },
  };
  return { records, state, ports };
}

describe('createAgentNetNode', () => {
  afterEach(() => { vi.useRealTimers(); });
  it('starts from the device list it saved last time when the official service cannot be reached', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-net-node-cache-'));
    const { ports } = fixture();
    Object.assign(ports, { directoryCacheFile: () => path.join(dir, 'directory.json'), workerFile: () => 'unit-worker.mjs',
      coreModule: async () => ({}) as WebAssembly.Module });
    const peer = { certificate: issueCertificate(root, { networkId: 'account:unit', subject: 'account-a', identity: generateIdentity('peer-desktop'),
      role: 'member' }), name: 'Desktop', online: true, remoteControlEnabled: true, capabilities: [] };
    const opened: Array<Parameters<typeof AgentNetWorkerSocket.open>[0]> = [];
    const socket = Object.assign(new EventEmitter(), { close: vi.fn(), useSessions: vi.fn(), restrictPeers: vi.fn() });
    const open = vi.spyOn(AgentNetWorkerSocket, 'open').mockImplementation(async (options) => { opened.push(options); return socket as never; });
    try {
      await createAgentNetNode(ports).openSocket('account-a');
      expect(opened[0].cachedDirectory?.map((view) => view.certificate.deviceId)).toEqual(['host-device']);
      opened[0].onDirectory?.([peer]);
      // 重启时官方服务还连不上（fetch 都失败）：用存下的名册，里面有对方电脑和自己。
      await createAgentNetNode(ports).openSocket('account-a');
      expect(opened[1].cachedDirectory?.map((view) => view.certificate.deviceId).sort()).toEqual(['host-device', 'peer-desktop']);
      expect(opened[1].directoryExpiresAt).toBeGreaterThan(Date.now());
    } finally { open.mockRestore(); fs.rmSync(dir, { recursive: true, force: true }); }
  });

  it('enrolls once, keeps the identity only in the launcher credential record, and reuses it after a restart', async () => {
    const { records, state, ports } = fixture();
    const first = await createAgentNetNode(ports).member();
    expect(first.certificate).toMatchObject({ subject: 'account-a', deviceId: 'host-device', networkId: 'account:unit' });
    expect(state.enrollments).toBe(1);
    expect(records.size).toBe(1);
    const [[key, value]] = [...records];
    expect(key).toMatch(/^agent-net-[0-9a-f]{32}$/);
    expect(value).toContain('PRIVATE KEY');
    expect(key).not.toContain('example.test'); expect(key).not.toContain('account-a');
    // A restart reads the same record: same identity, no second use of the account token.
    const restarted = await createAgentNetNode(ports).member();
    expect(restarted.certificate.signature).toBe(first.certificate.signature);
    expect(state.enrollments).toBe(1);
    // Another account on the same Host gets its own record instead of tripping over this one.
    state.subject = 'account-b';
    const other = await createAgentNetNode(ports).member();
    expect(other.certificate.subject).toBe('account-b');
    expect(state.enrollments).toBe(2);
    expect(records.size).toBe(2);
  });

  it('renews within a day of expiry and keeps the current certificate when renewal fails before it expires', async () => {
    const { state, ports } = fixture();
    state.lifetimeMs = 60 * 60_000;
    const short = await createAgentNetNode(ports).member();
    // Renewal is due (an hour left) but the service is down: the still-valid certificate keeps working.
    state.failEnrollment = true;
    const kept = await createAgentNetNode(ports).member();
    expect(state.enrollments).toBe(2);
    expect(kept.certificate.signature).toBe(short.certificate.signature);
    // Next time it renews, with the same keys.
    state.failEnrollment = false; state.lifetimeMs = 7 * 24 * 60 * 60_000;
    const renewed = await createAgentNetNode(ports).member();
    expect(state.enrollments).toBe(3);
    expect(renewed.certificate.expiresAt).toBeGreaterThan(short.certificate.expiresAt);
    expect(renewed.identity.signingKey).toBe(short.identity.signingKey);
  });

  it('signs relay links with its stored identity while Agent-Net is off, and signs nothing it has no identity for', async () => {
    const { state, ports } = fixture();
    state.enabled = false;
    const neverJoined = createAgentNetNode(ports);
    await neverJoined.prepareTransportStatement();
    expect(neverJoined.transportAttestation('desktop-a', 'request-1')).toBeUndefined();
    expect(state.enrollments).toBe(0);
    // Joined once, then restarted with Agent-Net off: the relay link says "off", signed by this Host, without enrolling again.
    state.enabled = true;
    const certificate = (await createAgentNetNode(ports).member()).certificate;
    state.enabled = false;
    const restarted = createAgentNetNode(ports);
    await restarted.prepareTransportStatement();
    const proof = restarted.transportAttestation('desktop-a', 'request-2');
    expect(proof).toMatchObject({ enabled: false });
    expect(verifyTransportModeProof(certificate, 'desktop-a', 'request-2', proof)).toBe(true);
    expect(state.enrollments).toBe(1);
    // After an account switch the previous account's identity does not speak for this Host.
    state.subject = 'account-b';
    expect(restarted.transportAttestation('desktop-a', 'request-3')).toBeUndefined();
  });

  it('still says "off" after its certificate expired while off, and a peer takes only "off" from an expired certificate', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.UTC(2026, 10, 1));
    const { state, ports } = fixture();
    state.lifetimeMs = 14 * 24 * 60 * 60_000;
    const joined = await createAgentNetNode(ports).member();
    state.enabled = false;
    // Three weeks with Agent-Net off: no renewal, the certificate the peers hold has expired.
    vi.setSystemTime(Date.UTC(2026, 10, 22));
    const node = createAgentNetNode(ports);
    await node.prepareTransportStatement();
    const off = node.transportAttestation('desktop-a', 'request-1');
    expect(off).toMatchObject({ enabled: false });
    expect(state.enrollments).toBe(1);
    const accept = (proof: unknown, requestId: string, accepted = true) =>
      acceptTransportStatement(bootstrap.rootPublicKey, joined.certificate, 'desktop-a', requestId, proof, accepted);
    expect(accept(off, 'request-1')).toBe(true);
    // Not "on" from that certificate, not from a device removed in Device Link, not for another request or receiver.
    expect(accept(createTransportModeProof(joined.identity, 'desktop-a', 'request-2', true), 'request-2')).toBe(false);
    expect(accept(off, 'request-1', false)).toBe(false);
    expect(accept(off, 'request-other')).toBe(false);
    expect(acceptTransportStatement(bootstrap.rootPublicKey, joined.certificate, 'desktop-b', 'request-1', off)).toBe(false);
    // A certificate from another network root is not taken even for "off".
    const otherRoot = createPrivateNetwork('Another network', generateIdentity('other-root-owner')).bootstrap.rootPublicKey;
    expect(acceptTransportStatement(otherRoot, joined.certificate, 'desktop-a', 'request-1', off)).toBe(false);
    // While the certificate is valid either statement is taken, as before.
    vi.setSystemTime(Date.UTC(2026, 10, 2));
    expect(accept(createTransportModeProof(joined.identity, 'desktop-a', 'request-3', true), 'request-3')).toBe(true);
  });

  // 2026-11-17 rebase: a Device Link deletion now also revokes the device on Agent-Net (deviceLinkApi.ts), permanently. Signed in
  // again, it must still reach the other computers on Device Link: refused by Agent-Net, this run is as with Agent-Net off (the relay
  // client's next attempt uses the relay) and it says "off"; a peer that knew it takes that "off" with the certificate it last had.
  it('runs on the relay once Agent-Net refuses this identity, says "off", and peers take only "off" from a revoked device', async () => {
    const { state, ports } = fixture();
    const joined = await createAgentNetNode(ports).member();
    state.enabled = true;
    const node = createAgentNetNode({ ...ports, enroll: async () => { throw Object.assign(new Error('refused'), { code: 'DEVICE_REENROLLMENT_REQUIRES_APPROVAL' }); },
      readSecret: async () => null, writeSecret: async () => {} });
    expect(node.active()).toBe(true);
    await expect(node.openSocket('account-a')).rejects.toThrow('AGENT_NET_IDENTITY_REFUSED');
    expect(node.active()).toBe(false);
    await expect(node.openSocket('account-a')).resolves.toBeNull();
    // Its statement now says "off" (signed with the identity it still has).
    const revoked = createAgentNetNode(ports);
    await revoked.prepareTransportStatement();
    revoked.noteIdentityRefused('relay closed 4410');
    const off = revoked.transportAttestation('desktop-a', 'request-1');
    expect(off).toMatchObject({ enabled: false });
    const accept = (proof: unknown, requestId: string, accepted = true) => acceptTransportStatement(bootstrap.rootPublicKey,
      joined.certificate, 'desktop-a', requestId, proof, accepted, { offOnly: true });
    expect(accept(off, 'request-1')).toBe(true);
    expect(accept(createTransportModeProof(joined.identity, 'desktop-a', 'request-2', true), 'request-2')).toBe(false);
    expect(accept(off, 'request-1', false)).toBe(false);
    // Another error is not a refusal: no fallback, the attempt just fails as before.
    const broken = createAgentNetNode({ ...ports, readSecret: async () => { throw new Error('KEYRING_LOCKED'); } });
    await expect(broken.openSocket('account-a')).rejects.toThrow('KEYRING_LOCKED');
    expect(broken.active()).toBe(true);
  });
});
