/**
 * 测试价值
 * - 生产入口与可观察结果：注册后的 self-hosted-relay:command IPC；部署完成只保存记录、不切换线路，
 *   多台服务器各留一条记录，改名只改本机记录；账号切换后的迟到部署/退出响应不能改写新账号配置或覆盖新部署进度。
 * - Bug/规则依据：appSessionState.activeOwnerScopeKey 的异步账号边界；原部署回调跨 await 读取当前账号，
 *   会将旧账号的部署记录写入新账号，切换中转在等待退出旧中转时也有同样问题。
 * - 现有覆盖缺口：部署器测试只验证 SSH 步骤，没有经过运行时 IPC 与账号切换，故单独覆盖该模块。
 * - 最小失败输入：挂起一次部署或退出请求，换账号，再让原请求完成。
 * - tier：unit；SSH、存储和 Electron 为进程内 fake，无网络、磁盘或真实等待。
 * - 单文件实测：0.80 秒（17 例，测试体 35ms，Linux）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayConfig, RelaySecrets } from '../selfHostedRelayConfig';
import type { SelfHostedRelayCommand, SelfHostedRelayCommandResult } from '../../../shared/selfHostedRelay';
import { RELAY_VERSION } from '../../../../../../packages/device-link-relay/src/version';
import { RELAY_DEPLOY_STEPS } from '../../../shared/selfHostedRelay';

const h = vi.hoisted(() => ({
  owner: 'account-a',
  generation: 0,
  boundaryPending: false,
  config: new Map<string, RelayConfig>(),
  handlers: new Map<string, (event: unknown, raw: unknown) => Promise<SelfHostedRelayCommandResult>>(),
  invalidated: () => {},
  authChanged: () => {},
  write: vi.fn(),
  deleteSecrets: vi.fn(),
  restart: vi.fn(),
  deploy: vi.fn(),
  uninstall: vi.fn(),
  startServer: vi.fn(),
  upload: vi.fn(),
  verifyEndpoint: vi.fn(),
  secrets: new Map<string, RelaySecrets>(),
  bundlePath: 'in-memory-relay.mjs' as string | null,
}));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getVersion: () => 'test' },
  ipcMain: { handle: (key: string, fn: never) => h.handlers.set(key, fn) },
}));
vi.mock('node:fs', () => ({ default: { existsSync: () => true, rmSync: vi.fn(), readFileSync: () => Buffer.from('test-relay-bundle') } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: h.owner, generation: h.generation }),
  isAppSessionBoundaryPending: () => h.boundaryPending,
  onAppSessionInvalidated: (cb: () => void) => { h.invalidated = cb; },
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: true }),
  getCurrentUserId: () => h.owner,
  getDeviceId: () => 'test-device',
  onAuthStateChange: (cb: () => void) => { h.authChanged = cb; },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: (code: string) => { throw new Error(code); } }));
vi.mock('../invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => null }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Test computer' }));
vi.mock('../providerShareApi.js', () => ({ providerShareLinkApp: () => 'cindy' }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ keepAwake: true }) }));
vi.mock('../selfHostedRelayFrameAuth.js', () => ({ refreshRelayCertificatesSoon: vi.fn() }));
vi.mock('../index.js', () => ({
  broadcast: vi.fn(), getDeviceLinkConnectionIssue: () => null,
  restartDeviceLinkForRelayChange: h.restart, setKeepAwakeEnabled: vi.fn(),
}));
vi.mock('@cindy/device-link-relay', () => ({
  createDeviceCredential: () => ({ credential: 'fake-credential' }),
  hashSecret: () => 'fake-hash', initializeRelay: vi.fn(), startRelayServer: h.startServer,
}));
vi.mock('../selfHostedRelayDeploy.js', () => ({
  bundledRelayVersion: () => RELAY_VERSION, deployRelayToServer: h.deploy, uninstallRelayFromServer: h.uninstall,
  checkRelayServer: vi.fn(), RelayDeployError: class extends Error {},
  resolveRelayBundlePath: () => h.bundlePath,
}));
vi.mock('../selfHostedRelayUpload.js', () => ({ uploadRelayArtifacts: h.upload }));
vi.mock('../selfHostedRelayEndpoint.js', () => ({ verifyAgentRelayEndpoint: h.verifyEndpoint }));
vi.mock('../selfHostedRelayConfig.js', () => ({
  readRelayConfig: () => structuredClone(h.config.get(h.owner)),
  writeRelayConfig: (value: RelayConfig) => {
    h.write(h.owner, structuredClone(value));
    h.config.set(h.owner, structuredClone(value));
  },
  readRelaySecrets: (relayId: string) => h.secrets.get(`${h.owner}:${relayId}`) ?? { credential: 'fake-credential', seed: 'A'.repeat(43) },
  writeRelaySecrets: (relayId: string, secrets: RelaySecrets) => { h.secrets.set(`${h.owner}:${relayId}`, secrets); }, deleteRelaySecrets: h.deleteSecrets,
  activeSelfHostedRelay: () => {
    const active = h.config.get(h.owner)?.active;
    return active ? { ...active, credential: 'fake-credential', signingSeed: 'A'.repeat(43) } : null;
  },
  activeRelayOrigin: () => h.config.get(h.owner)?.active?.origin ?? null,
  secureStorageAvailable: () => true, installSelfHostedRelayRouting: vi.fn(),
  relayDataPath: () => 'in-memory-relay-data',
}));

import { getState, getAgentRelayState, projectAgentRelayState, registerSelfHostedRelayIpc, prepareAgentRelayDeployment, registerAgentRelayDeployment, uploadAgentRelayDeployment, executeSelfHostedRelayCommand } from '../selfHostedRelayRuntime';

function emptyConfig(): RelayConfig {
  return { version: 2, active: null, host: { enabled: false, port: 47820, listenAll: false, externalUrl: null, relayId: null }, deployments: [] };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

const command = (value: SelfHostedRelayCommand) => h.handlers.get('self-hosted-relay:command')!({}, value);
const deployCommand: SelfHostedRelayCommand = {
  type: 'deploy', sshHostId: 'test-server', address: '203.0.113.10', name: 'Test relay', replaceExisting: false,
};

async function switchOwner(owner: string) {
  h.invalidated();
  h.owner = owner;
  h.generation += 1;
  h.authChanged();
  await vi.runAllTimersAsync();
}

beforeEach(async () => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.owner = 'account-a';
  h.generation += 1;
  h.boundaryPending = false;
  h.secrets.clear();
  h.bundlePath = 'in-memory-relay.mjs';
  h.verifyEndpoint.mockReset();
  h.upload.mockReset().mockResolvedValue({ bundlePath: '/srv/staging/relay.mjs', initPath: '/srv/staging/init.json',
    bundleSha256: 'a'.repeat(64), initSha256: 'b'.repeat(64) });
  h.config = new Map([['account-a', emptyConfig()], ['account-b', emptyConfig()]]);
  registerSelfHostedRelayIpc();
  await vi.runAllTimersAsync();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const deploymentOf = (owner = 'account-a', sshHostId = 'test-server') =>
  h.config.get(owner)!.deployments.find((deployment) => deployment.sshHostId === sshHostId);

async function uploadedDeployment(key: string) {
  const result = await prepareAgentRelayDeployment({ deploymentKey: key, name: 'Relay' });
  expect((await uploadAgentRelayDeployment({ relayId: result.prepared!.relayId, sshHostId: 'uploaded-ssh', remoteDir: '/srv/staging' })).error).toBeUndefined();
  return result.prepared!;
}

// Agent 自选部署不经过 SSH 安装器；既有 IPC 测试无法证明主人身份、任务撤销与协议核验边界。
// 最小输入：同一 deploymentKey 重试，再提交任意 HTTPS 高端口。unit，网络与安全存储均为 fake。
it('prepares an idempotent owner identity without exposing its secrets or selecting a route', async () => {
  const first = await prepareAgentRelayDeployment({ deploymentKey: 'my-container', name: 'Container relay' });
  const retry = await prepareAgentRelayDeployment({ deploymentKey: 'my-container', name: 'Container relay' });
  expect(retry.prepared).toEqual(first.prepared);
  expect(h.config.get(h.owner)!.deployments).toHaveLength(1);
  expect(first.state.deployments[0]).toMatchObject({ managedBy: 'agent', sshHostId: '', relayVersion: '', active: false });
  expect(h.config.get(h.owner)!.active).toBeNull();
  expect(first.prepared?.init.ownerUserId).toBe('account-a');
  expect(JSON.stringify(first)).not.toContain('fake-credential');
  expect(JSON.stringify(first)).not.toContain(h.secrets.values().next().value!.seed);
  expect(h.deploy).not.toHaveBeenCalled();
  expect(h.restart).not.toHaveBeenCalled();
  h.bundlePath = null;
  expect((await prepareAgentRelayDeployment({ deploymentKey: 'missing-bundle', name: 'Missing' })).error).toBe('BUNDLE_MISSING');
  expect(h.config.get(h.owner)!.deployments).toHaveLength(1);
});

// UI state 含有效加入码和配对秘密；Agent 白名单不能因复用设置查询而泄露它们。tier: unit。
it('projects deployment state without exposing live UI pairing links or requests', () => {
  const state = { ...getState(), joinLink: { link: 'cindy://relay/join?c=private-code&s=private-pair-secret', expiresAt: '2099-01-01T00:00:00Z' },
    pendingRequests: [{ requestId: 'private-request', deviceName: 'Private device', platform: 'ios', verifyCode: '123456', replacesExisting: false, verified: true }] };
  expect(projectAgentRelayState(state)).toEqual(getAgentRelayState());
  expect(Object.keys(projectAgentRelayState(state)).sort()).toEqual(['bundledRelayVersion', 'deployments', 'issue', 'mode', 'relay']);
  expect(JSON.stringify(projectAgentRelayState(state))).not.toContain('private-');
});

it('verifies an agent relay at its real HTTPS URL and protects it from the fixed installer', async () => {
  const prepared = await uploadedDeployment('container');
  const info = { relayId: prepared!.relayId, ownerPublicKey: prepared!.init.ownerPublicKey, protocolVersion: 1, features: ['pairing-v1', 'device-signatures-v1'], relayVersion: '0.3.1' };
  const requests = vi.fn(async () => info);
  h.verifyEndpoint.mockResolvedValue(requests);
  const result = await registerAgentRelayDeployment({ relayId: info.relayId, baseUrl: 'https://relay.example:8443/cindy/', tlsPort: 443,
    metadata: { runtime: 'container', service: 'rootless podman', sshHostId: 'untrusted-description', programDir: '/srv/live' } });
  expect(result.error).toBeUndefined();
  expect(result.state.deployments[0]).toMatchObject({ baseUrl: 'https://relay.example:8443/cindy', managedBy: 'agent', relayVersion: '0.3.1', active: false, upgradeAvailable: false,
    metadata: { runtime: 'container', sshHostId: 'uploaded-ssh', programDir: '/srv/live' } });
  expect(h.verifyEndpoint).toHaveBeenLastCalledWith({ sshHostId: 'uploaded-ssh', baseUrl: 'https://relay.example:8443/cindy', tlsPort: 443, nodePath: 'node', assertCurrent: expect.any(Function) });
  expect(JSON.stringify(h.verifyEndpoint.mock.calls)).not.toContain('fake-credential');
  expect(requests).toHaveBeenNthCalledWith(1, 'info');
  expect(requests).toHaveBeenNthCalledWith(2, 'admin/status', 'fake-credential');
  expect(h.restart).not.toHaveBeenCalled();
  for (const type of ['upgrade-deployment', 'uninstall-deployment'] as const) {
    expect((await command({ type, relayId: info.relayId, removeData: true })).error).toBe('AGENT_MANAGED_DEPLOYMENT');
  }
  expect(h.deploy).not.toHaveBeenCalled();
  expect(h.uninstall).not.toHaveBeenCalled();
  await executeSelfHostedRelayCommand({ type: 'use-deployment', relayId: info.relayId });
  expect(h.config.get(h.owner)!.active).toMatchObject({ baseUrl: 'https://relay.example:8443/cindy', role: 'owner' });
  // A changed URL never reuses the previous endpoint proof.
  expect((await registerAgentRelayDeployment({ relayId: info.relayId, baseUrl: 'https://moved.example:9443', tlsPort: 8443, nodePath: '/opt/node' })).error).toBeUndefined();
  expect(h.verifyEndpoint).toHaveBeenCalledTimes(2);
  expect(h.verifyEndpoint).toHaveBeenLastCalledWith(expect.objectContaining({ baseUrl: 'https://moved.example:9443', sshHostId: 'uploaded-ssh', tlsPort: 8443, nodePath: '/opt/node' }));
  expect(h.config.get(h.owner)!.active).toMatchObject({ baseUrl: 'https://moved.example:9443' });
});

it.each(['identity', 'protocol', 'admin', 'redirect'] as const)('does not register a relay that fails %s verification', async (failure) => {
  const prepared = await uploadedDeployment('candidate');
  const original = structuredClone(h.config.get(h.owner));
  let calls = 0;
  const requests = vi.fn(async () => {
    calls += 1;
    if (failure === 'redirect') throw new TypeError('redirect not allowed');
    return {
      relayId: failure === 'identity' || (failure === 'admin' && calls === 2) ? 'other-relay' : prepared!.relayId,
      ownerPublicKey: prepared!.init.ownerPublicKey, protocolVersion: failure === 'protocol' ? 99 : 1,
      features: ['pairing-v1', 'device-signatures-v1'], relayVersion: '0.3.1',
    };
  });
  h.verifyEndpoint.mockResolvedValue(requests);
  const result = await registerAgentRelayDeployment({ relayId: prepared!.relayId, baseUrl: 'https://relay.example:9443', tlsPort: 443 });
  expect(result.error).toBe(failure === 'protocol' ? 'INCOMPATIBLE' : failure === 'redirect' ? 'NOT_REACHABLE' : 'RELAY_MISMATCH');
  expect(h.config.get(h.owner)).toEqual(original);
  expect(requests).toHaveBeenCalledTimes(failure === 'admin' ? 2 : 1);
  expect(h.restart).not.toHaveBeenCalled();
});

it('rejects cleartext URLs before sending a credential and ignores late verification after account changes', async () => {
  const prepared = await uploadedDeployment('candidate');
  const pending = deferred<Record<string, unknown>>();
  const requests = vi.fn(() => pending.promise);
  h.verifyEndpoint.mockResolvedValue(requests);
  expect((await registerAgentRelayDeployment({ relayId: prepared!.relayId, baseUrl: 'http://relay.example:8443', tlsPort: 443 })).error).toBe('INVALID_ADDRESS');
  expect(requests).not.toHaveBeenCalled();
  const registering = registerAgentRelayDeployment({ relayId: prepared!.relayId, baseUrl: 'https://relay.example:8443', tlsPort: 443 });
  const rejection = expect(registering).rejects.toThrow();
  await vi.waitFor(() => expect(requests).toHaveBeenCalledOnce());
  await switchOwner('account-b');
  pending.resolve({});
  await rejection;
  expect(h.config.get('account-b')!.deployments).toEqual([]);
  expect(h.config.get('account-a')!.deployments[0].complete).toBe(false);
  expect(requests).toHaveBeenCalledOnce();
});

// PR #8779: public relay/info is copyable. Only the successful upload's authenticated SSH host can bind a new URL.
// Existing identity checks did not cover missing upload anchors, failed endpoint proof, or a concurrently replaced receipt. Unit.
it('requires an uploaded SSH anchor and leaves the previous record untouched when binding fails', async () => {
  const { prepared } = await prepareAgentRelayDeployment({ deploymentKey: 'unbound', name: 'Relay' });
  const input = { relayId: prepared!.relayId, baseUrl: 'https://copy.example', tlsPort: 443, metadata: { sshHostId: 'forged-host' } };
  expect((await registerAgentRelayDeployment(input)).error).toBe('NO_DEPLOYMENT');
  expect(h.verifyEndpoint).not.toHaveBeenCalled();
  await uploadAgentRelayDeployment({ relayId: prepared!.relayId, sshHostId: 'uploaded-ssh', remoteDir: '/srv/staging' });
  const original = structuredClone(h.config.get(h.owner));
  h.verifyEndpoint.mockRejectedValue(new Error('certificate mismatch'));
  expect((await registerAgentRelayDeployment(input)).error).toBe('NOT_REACHABLE');
  expect(h.verifyEndpoint).toHaveBeenLastCalledWith(expect.objectContaining({ sshHostId: 'uploaded-ssh' }));
  expect(h.config.get(h.owner)).toEqual(original);
  expect(h.restart).not.toHaveBeenCalled();
});

it('does not register a stale endpoint proof after another upload replaces its SSH anchor', async () => {
  const prepared = await uploadedDeployment('concurrent');
  const info = { relayId: prepared.relayId, ownerPublicKey: prepared.init.ownerPublicKey, protocolVersion: 1,
    features: ['pairing-v1', 'device-signatures-v1'], relayVersion: '0.3.1' };
  h.verifyEndpoint.mockResolvedValue(async (endpoint: string) => {
    if (endpoint === 'admin/status') await uploadAgentRelayDeployment({ relayId: prepared.relayId, sshHostId: 'another-host', remoteDir: '/srv/other' });
    return info;
  });
  expect((await registerAgentRelayDeployment({ relayId: prepared.relayId, baseUrl: 'https://relay.example', tlsPort: 443 })).error).toBe('BUSY');
  expect(h.config.get(h.owner)!.deployments[0]).toMatchObject({ complete: false, baseUrl: '', lastUpload: { sshHostId: 'another-host' } });
  expect(h.restart).not.toHaveBeenCalled();
});

it('uploads only public initialization materials and preserves a prepared identity when task authority expires', async () => {
  const { prepared } = await prepareAgentRelayDeployment({ deploymentKey: 'upload', name: 'Upload' });
  h.upload.mockResolvedValue({ bundlePath: '/srv/relay.mjs', initPath: '/srv/init.json', bundleSha256: 'a'.repeat(64), initSha256: 'b'.repeat(64) });
  const result = await uploadAgentRelayDeployment({ relayId: prepared!.relayId, sshHostId: 'my-ssh', remoteDir: '/srv/cindy relay' });
  expect(result.uploaded).toMatchObject({ sshHostId: 'my-ssh', bundlePath: '/srv/relay.mjs' });
  const uploaded = h.upload.mock.calls[0][0];
  expect(uploaded.bundle.toString()).toBe('test-relay-bundle');
  expect(JSON.parse(uploaded.init.toString())).toEqual(prepared!.init);
  expect(uploaded.init.toString()).not.toContain('fake-credential');
  const before = structuredClone(h.config.get(h.owner));
  await expect(prepareAgentRelayDeployment({ deploymentKey: 'revoked', name: 'Revoked' }, { assertCurrent: () => { throw new Error('revoked'); } })).rejects.toThrow('revoked');
  expect(h.config.get(h.owner)).toEqual(before);
});

// PR #8779 P1：上传临时目录不是正在运行的安装位置。旧用例只检查上传内容，未覆盖已有线路的维护信息。
// 最小输入：已完成/未完成的 Agent 记录上传到另一个 SSH 主机的 staging 目录，不进行核验登记。tier: unit。
it.each([true, false])('records staging separately without changing live deployment information (complete=%s)', async (complete) => {
  const { prepared } = await prepareAgentRelayDeployment({ deploymentKey: 'staging-upgrade', name: 'Relay' });
  const config = h.config.get(h.owner)!;
  const original = complete ? { ...config.deployments[0], complete: true, baseUrl: 'https://live.example:8443', address: 'live.example:8443', relayVersion: '0.2.0',
    metadata: { sshHostId: 'live-ssh', programDir: '/opt/live-relay', dataDir: '/var/lib/live-relay', service: 'live-relay.service' } } : config.deployments[0];
  h.config.set(h.owner, { ...config, deployments: [original] });
  if (complete) await executeSelfHostedRelayCommand({ type: 'use-deployment', relayId: prepared!.relayId });
  const active = structuredClone(h.config.get(h.owner)!.active);
  h.restart.mockClear();
  const artifacts = { bundlePath: '/srv/staging/relay.mjs', initPath: '/srv/staging/init.json', bundleSha256: 'a'.repeat(64), initSha256: 'b'.repeat(64) };
  h.upload.mockResolvedValueOnce(artifacts);
  const result = await uploadAgentRelayDeployment({ relayId: prepared!.relayId, sshHostId: 'staging-ssh', remoteDir: '/srv/staging' });
  const receipt = { ...artifacts, sshHostId: 'staging-ssh', remoteDir: '/srv/staging', uploadedAt: new Date().toISOString() };
  expect(result.error).toBeUndefined();
  expect(h.config.get(h.owner)!.deployments[0]).toEqual({ ...original, lastUpload: receipt });
  expect(getAgentRelayState().deployments[0]).toMatchObject({ baseUrl: original.baseUrl, relayVersion: original.relayVersion, lastUpload: receipt });
  expect(h.config.get(h.owner)!.active).toEqual(active);
  expect(h.restart).not.toHaveBeenCalled();
  // 后续尝试失败也不能把原运行位置或上一次成功上传收据清掉。
  h.upload.mockRejectedValueOnce(new Error('upload failed'));
  expect((await uploadAgentRelayDeployment({ relayId: prepared!.relayId, sshHostId: 'failed-ssh', remoteDir: '/srv/failed' })).error).toBe('DEPLOY_FAILED');
  expect(h.config.get(h.owner)!.deployments[0]).toEqual({ ...original, lastUpload: receipt });
  if (complete) {
    // 切回官方只换路由，既不能删除远端安装记录，也不能丢弃以后继续维护的主人身份。
    const secrets = structuredClone(h.secrets);
    await executeSelfHostedRelayCommand({ type: 'use-official' });
    expect(h.config.get(h.owner)!.active).toBeNull();
    expect(h.config.get(h.owner)!.deployments[0]).toEqual({ ...original, lastUpload: receipt });
    expect(h.secrets).toEqual(secrets);
    expect(h.deleteSecrets).not.toHaveBeenCalled();
    expect(h.restart).toHaveBeenCalledOnce();
  }
});

// 用户 2026-10-30：部署是部署，切换要让用户自己切。原实现部署完成就改用新中转。
// 最小输入：官方线路上部署一次，再显式 use-deployment。tier: unit。
it('records a completed deployment without switching, and switches only when asked', async () => {
  h.deploy.mockResolvedValue({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(deploymentOf()?.complete).toBe(true);
  expect(h.config.get('account-a')?.active).toBeNull();
  expect(getState().deployJob).toMatchObject({ status: 'done', relayId: deploymentOf()!.relayId });
  expect(getState().deployments[0]).toMatchObject({ active: false, relayVersion: '0.2.0' });
  expect(h.restart).not.toHaveBeenCalled();
  await command({ type: 'use-deployment', relayId: deploymentOf()!.relayId });
  expect(h.config.get('account-a')?.active).toMatchObject({ origin: 'server', relayId: deploymentOf()!.relayId });
  expect(h.restart).toHaveBeenCalledOnce();
});

// 用户 2026-10-30：部署了一个就不能再部署。最小输入：两台服务器各部署一次，第二台部署时第一台正在使用。
// 第一台的记录、身份与正在用的线路都不受影响；同一台再部署沿用原身份。tier: unit。
it('keeps one relay per server and deploys to another server alongside the one in use', async () => {
  h.deploy.mockResolvedValue({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const first = deploymentOf()!;
  await command({ type: 'use-deployment', relayId: first.relayId });
  h.restart.mockClear();
  h.deploy.mockImplementationOnce(async (params: DeployParams) => {
    params.onServerChange?.();
    return { relayVersion: '0.2.0' };
  });
  await command({ ...deployCommand, sshHostId: 'other-server', address: '203.0.113.20', name: 'Second relay' });
  await vi.runAllTimersAsync();
  const config = h.config.get('account-a')!;
  expect(config.deployments.map((deployment) => deployment.sshHostId)).toEqual(['test-server', 'other-server']);
  expect(config.active?.relayId).toBe(first.relayId);
  expect(h.deleteSecrets).not.toHaveBeenCalled();
  expect(h.uninstall).not.toHaveBeenCalled();
  expect(h.restart).not.toHaveBeenCalled();
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(h.deploy.mock.calls.at(-1)![0].init.relayId).toBe(first.relayId);
  expect(h.config.get('account-a')!.deployments).toHaveLength(2);
});

// 用户 2026-10-30：部署完要能改名字。只改本机记录；正在用时当前线路名同步，部署中改名不被完成覆盖。tier: unit。
it('renames a deployment locally, including the route in use and a deployment still running', async () => {
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const relayId = deploymentOf()!.relayId;
  await command({ type: 'use-deployment', relayId });
  h.restart.mockClear();
  expect((await command({ type: 'rename-deployment', relayId, name: 'Office relay' })).error).toBeUndefined();
  expect(deploymentOf()?.name).toBe('Office relay');
  expect(h.config.get('account-a')?.active?.name).toBe('Office relay');
  expect(h.restart).not.toHaveBeenCalled();
  const upgrading = deferred<{ relayVersion: string }>();
  h.deploy.mockReturnValueOnce(upgrading.promise);
  await command({ type: 'upgrade-deployment', relayId });
  await command({ type: 'rename-deployment', relayId, name: 'Home relay' });
  upgrading.resolve({ relayVersion: '0.2.1' });
  await vi.runAllTimersAsync();
  expect(deploymentOf()).toMatchObject({ name: 'Home relay', relayVersion: '0.2.1' });
  expect(h.config.get('account-a')?.active?.name).toBe('Home relay');
  expect(h.restart).toHaveBeenCalledOnce();
  expect((await command({ type: 'rename-deployment', relayId: '00000000-0000-4000-8000-000000000000', name: 'X' })).error).toBe('NO_DEPLOYMENT');
});

// 0.3.0 已部署用户必须能从状态投影进入升级，才能获得本次证书重试修复；原版本号未递增时此用例失败。
// 生产入口为 state IPC；现有部署成功用例不覆盖旧版记录。最小输入：已完成的 0.3.0 部署，tier: unit。
it('offers the certificate retry update to an existing 0.3.0 relay and clears it after upgrading', async () => {
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.3.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect((await command({ type: 'state' })).state.deployments[0]?.upgradeAvailable).toBe(true);
  h.deploy.mockResolvedValueOnce({ relayVersion: RELAY_VERSION });
  await command({ type: 'upgrade-deployment', relayId: deploymentOf()!.relayId });
  await vi.runAllTimersAsync();
  expect((await command({ type: 'state' })).state.deployments[0]).toMatchObject({
    relayVersion: RELAY_VERSION, upgradeAvailable: false,
  });
});

// 管理卡片的在线、设备数与证书到期来自这条只读查询；服务器回的中转 ID 不是这份部署时
// 必须按连不上处理，不能把另一个中转的数字显示成自己的。最小输入：同一地址两次回应。tier: unit。
it('reads the deployed relay status with the owner credential and rejects another relay’s answer', async () => {
  h.deploy.mockResolvedValue({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const relayId = deploymentOf()!.relayId;
  const fetchMock = vi.fn(async () => new Response(JSON.stringify({
    relayId, devices: 3, online: 2, certificateExpiresAt: '2026-11-04T00:00:00.000Z',
  })));
  vi.stubGlobal('fetch', fetchMock);
  const status = await command({ type: 'deployment-status', relayId });
  expect(status.deploymentStatus).toEqual({ online: true, devices: 3, onlineDevices: 2, certificateExpiresAt: '2026-11-04T00:00:00.000Z' });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://203.0.113.10/api/device-link/relay/admin/status',
    expect.objectContaining({ headers: { authorization: 'CindyRelay fake-credential' } }),
  );
  fetchMock.mockResolvedValueOnce(new Response(JSON.stringify({ relayId: 'another-relay', devices: 9 })));
  expect((await command({ type: 'deployment-status', relayId })).deploymentStatus).toEqual({ online: false });
});

// 2026-10-29：部署期间看不出进展；原测试只看终态，未覆盖 SSH 尚未结束时的状态推送。
// 最小输入：挂起部署，回报一条下载进展再失败；unit，观察运行中日志与失败后保留的耗时。
it('publishes deployment progress while work is pending and retains it after failure', async () => {
  const pending = deferred<{ relayVersion: string }>();
  h.deploy.mockReturnValueOnce(pending.promise);
  await command(deployCommand);
  const params = h.deploy.mock.calls[0][0];
  params.onStep('runtime');
  params.onProgress('runtime-download');
  const running = getState().deployJob!;
  expect(running).toMatchObject({ status: 'running', step: 'runtime', startedAt: expect.any(Number) });
  expect(running.logs?.at(-1)).toMatchObject({ step: 'runtime', message: 'runtime-download' });
  await vi.advanceTimersByTimeAsync(5_000);
  pending.reject(new Error('connection lost'));
  await vi.runAllTimersAsync();
  const failed = getState().deployJob!;
  expect(failed).toMatchObject({ status: 'failed', step: 'runtime', error: 'DEPLOY_FAILED' });
  expect(failed.finishedAt! - failed.startedAt!).toBe(5_000);
  expect(failed.logs).toEqual(running.logs);
});

type DeployParams = { onServerChange?: () => void };
/** 部署器在检查通过、改动服务器前回调 onServerChange；之后的失败才会留下部署记录。 */
const failAfterServerChange = async (params: DeployParams) => {
  params.onServerChange?.();
  throw new Error('connection lost');
};

// 2026-10-29 实机：部署停在检查端口，界面却出现「我的服务器中转」卡片，且不能重新选服务器。
// 原实现在连服务器之前就保存部署记录。最小输入：部署器在 onServerChange 之前失败。tier: unit。
it('keeps no deployment record when deployment stops before changing the server', async () => {
  h.deploy.mockRejectedValueOnce(new Error('ports busy'));
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(h.config.get('account-a')!.deployments).toEqual([]);
  expect(getState().deployJob).toMatchObject({ status: 'failed', serverChanged: false, target: { sshHostId: 'test-server' } });
  await command({ type: 'dismiss-deploy-job' });
  expect(getState().deployJob).toBeNull();
});

// 没完成的部署不影响部署到另一台服务器：原服务器那条记录与身份留着，之后可以继续或放弃。tier: unit。
it('keeps an unfinished deployment when deploying to another server', async () => {
  h.deploy.mockImplementationOnce(failAfterServerChange);
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const previous = structuredClone(deploymentOf()!);
  h.deploy.mockImplementationOnce(async (params: DeployParams) => {
    params.onServerChange?.();
    return { relayVersion: '0.2.0' };
  });
  await command({ ...deployCommand, sshHostId: 'other-server' });
  await vi.runAllTimersAsync();
  expect(getState().deployJob).toMatchObject({ status: 'done', steps: [...RELAY_DEPLOY_STEPS] });
  expect(h.uninstall).not.toHaveBeenCalled();
  expect(h.deleteSecrets).not.toHaveBeenCalled();
  expect(deploymentOf()).toEqual(previous);
  expect(deploymentOf('account-a', 'other-server')).toMatchObject({ complete: true });
});

// Bug：重启后进度对象不存在，持久部署记录仍须能继续，并保留已写入服务器的主人身份。tier: unit。
it('resumes an incomplete persisted deployment with the same relay identity', async () => {
  h.deploy.mockImplementationOnce(failAfterServerChange);
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const previous = structuredClone(deploymentOf()!);
  await switchOwner('account-b');
  await switchOwner('account-a');
  expect(getState().deployJob).toBeNull();
  expect(getState().deployments[0]?.relayVersion).toBe('');
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(h.deploy.mock.calls.at(-1)![0].init.relayId).toBe(previous.relayId);
  expect(deploymentOf()?.complete).toBe(true);
});

it.each(['resolve', 'reject'] as const)('ignores an old deployment that later %s after a new account starts its own', async (outcome) => {
  const old = deferred<{ relayVersion: string }>();
  const next = deferred<{ relayVersion: string }>();
  h.deploy.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await command(deployCommand);
  const oldStep = h.deploy.mock.calls[0][0].onStep;
  const oldProgress = h.deploy.mock.calls[0][0].onProgress;
  await switchOwner('account-b');
  expect(getState().deployJob).toBeNull();
  await command(deployCommand);
  const before = structuredClone(h.config.get('account-b'));
  h.write.mockClear();
  if (outcome === 'resolve') old.resolve({ relayVersion: '0.2.0' });
  else old.reject(new Error('old server failed'));
  await vi.runAllTimersAsync();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.config.get('account-b')).toEqual(before);
  expect(getState().deployJob?.status).toBe('running');
  expect(() => oldStep('upload')).toThrow();
  const currentJob = getState().deployJob;
  oldProgress('runtime-download');
  expect(getState().deployJob).toEqual(currentJob);
  next.resolve({ relayVersion: '0.2.0' });
  await vi.runAllTimersAsync();
  expect(getState().deployJob?.status).toBe('done');
});

it('does not clear a new account’s settings when an old member leave finishes', async () => {
  const leaving = deferred<Response>();
  vi.stubGlobal('fetch', vi.fn(() => leaving.promise));
  h.config.get('account-a')!.active = {
    relayId: 'old-relay', name: 'Old relay', baseUrl: 'https://relay.invalid', origin: 'join', role: 'member',
    deviceId: 'test-device', ownerPublicKey: 'A'.repeat(43),
  };
  const pending = command({ type: 'use-official' });
  await switchOwner('account-b');
  h.write.mockClear();
  leaving.resolve(new Response(null, { status: 204 }));
  const result = await pending;
  expect(result.error).toBe('NOT_SIGNED_IN');
  expect(h.write).not.toHaveBeenCalled();
  expect(h.deleteSecrets).not.toHaveBeenCalled();
  expect(h.restart).not.toHaveBeenCalled();
});

it('closes a local relay that finishes starting after its owner leaves', async () => {
  const starting = deferred<{ port: number; close: ReturnType<typeof vi.fn> }>();
  const close = vi.fn(async () => {});
  h.config.get('account-a')!.host.relayId = 'existing-relay';
  h.startServer.mockReturnValueOnce(starting.promise);
  const pending = command({ type: 'enable-host', port: 47820, listenAll: false, externalUrl: null });
  await vi.runAllTimersAsync();
  expect(h.startServer).toHaveBeenCalledOnce();
  await switchOwner('account-b');
  h.write.mockClear();
  starting.resolve({ port: 47820, close });
  expect((await pending).error).toBe('NOT_SIGNED_IN');
  expect(close).toHaveBeenCalledWith({ retire: false });
  expect(getState().host.running).toBe(false);
  expect(h.write).not.toHaveBeenCalled();
});

// #7722 discussion_r4403720703：Runtime 到中转内核的公开配置合同必须传入媒体对外地址。
// 经真实管理 IPC 启动并更改反向代理地址；配套内核媒体用例验证该选项生成可用签名 URL，tier: unit。
it('applies the configured public media address and restarts when it changes', async () => {
  const close = vi.fn(async () => {});
  h.startServer.mockResolvedValue({ port: 47820, close });
  h.config.get('account-a')!.host.relayId = 'existing-relay';
  vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ name: 'Home relay' }))));
  try {
    for (const externalUrl of ['https://relay.home.example', 'https://new-relay.home.example']) {
      const result = await command({ type: 'enable-host', port: 47820, listenAll: true, externalUrl });
      expect(result.error).toBeUndefined();
      expect(result.state.host.running).toBe(true);
      expect(h.startServer).toHaveBeenLastCalledWith(expect.objectContaining({
        publicUrl: externalUrl, trustProxyHeaders: false,
      }));
    }
    expect(h.startServer).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(1);
  } finally { await command({ type: 'disable-host' }); }
});

// Rui 2026-10-31：本机中转已开启，重开 Cindy 后中转没有起来（设备连 127.0.0.1 被拒），
// 直到手动「保存并重启」。登录提交账号时会话边界还没结束，ensureHost 判定未登录直接返回，
// 而 sync 已记下这个账号，边界结束后不会再试。最小输入：边界未结束时注册，再结束边界。tier: unit。
it('starts the enabled local relay once the sign-in session boundary ends', async () => {
  h.startServer.mockResolvedValue({ port: 47820, close: vi.fn(async () => {}) });
  h.config.get('account-a')!.host = { ...emptyConfig().host, enabled: true, relayId: 'existing-relay' };
  h.boundaryPending = true;
  h.generation += 1;
  registerSelfHostedRelayIpc();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.startServer).not.toHaveBeenCalled();
  h.boundaryPending = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.startServer).toHaveBeenCalledOnce();
  expect(getState().host.running).toBe(true);
  await command({ type: 'disable-host' });
});

// 同一修正的另一半：边界期间只推迟启动，换账号时上一个账号的本机中转仍要立即关掉（中转属于开启它的账号）。
// 最小输入：A 的中转在运行且关闭较慢，边界未结束时换到 B，再结束边界。tier: unit。
it('closes the previous account’s local relay at once when the switch lands inside a session boundary', async () => {
  // A 的中转要等设备连接关掉才释放端口：关闭没完成前不能启动 B，否则端口冲突后就不再重试。
  const closingA = deferred<void>();
  const closeA = vi.fn(() => closingA.promise);
  h.startServer.mockResolvedValueOnce({ port: 47820, close: closeA }).mockResolvedValueOnce({ port: 47820, close: vi.fn(async () => {}) });
  for (const owner of ['account-a', 'account-b']) h.config.get(owner)!.host = { ...emptyConfig().host, enabled: true, relayId: `${owner}-relay` };
  h.generation += 1;
  registerSelfHostedRelayIpc();
  await vi.advanceTimersByTimeAsync(0);
  expect(getState().host.running).toBe(true);
  h.boundaryPending = true;
  h.invalidated();
  h.owner = 'account-b';
  h.generation += 1;
  h.authChanged();
  await vi.advanceTimersByTimeAsync(0);
  expect(closeA).toHaveBeenCalledWith({ retire: false });
  expect(h.startServer).toHaveBeenCalledOnce();
  h.boundaryPending = false;
  await vi.advanceTimersByTimeAsync(1_000);
  expect(h.startServer).toHaveBeenCalledOnce();
  closingA.resolve();
  await vi.advanceTimersByTimeAsync(0);
  expect(h.startServer).toHaveBeenCalledTimes(2);
  expect(getState().host.running).toBe(true);
  await command({ type: 'disable-host' });
});

it('does not remove another account’s deployment after a delayed uninstall', async () => {
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const uninstall = deferred<void>();
  h.uninstall.mockReturnValueOnce(uninstall.promise);
  await command({ type: 'uninstall-deployment', relayId: deploymentOf()!.relayId, removeData: true });
  await switchOwner('account-b');
  h.write.mockClear();
  h.deleteSecrets.mockClear();
  uninstall.resolve();
  await vi.runAllTimersAsync();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.deleteSecrets).not.toHaveBeenCalled();
  expect(getState().deployJob).toBeNull();
});
