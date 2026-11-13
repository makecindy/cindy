/**
 * 测试价值
 * - 生产入口与可观察结果：注册后的 self-hosted-relay:command IPC；部署完成只保存记录、不切换线路，
 *   多台服务器各留一条记录，改名只改本机记录；账号切换后的迟到部署/退出响应不能改写新账号配置或覆盖新部署进度；
 *   同账号设备经账号记录申请时，主人电脑只自动放行登记过的设备与公钥；分享给其他账号时只同意配对证明
 *   对得上自己链接的申请，对方账号在中转上建自己的网络、被拒时删掉本机为它生成的秘密。
 * - Bug/规则依据：appSessionState.activeOwnerScopeKey 的异步账号边界；原部署回调跨 await 读取当前账号，
 *   会将旧账号的部署记录写入新账号，切换中转在等待退出旧中转时也有同样问题；
 *   self-hosted-relay-plan.md §5.4（同账号免链接加入不能放行公钥被换掉的申请）、§5.5（中转不能替换对方的根公钥）。
 * - 现有覆盖缺口：部署器测试只验证 SSH 步骤，没有经过运行时 IPC 与账号切换，故单独覆盖该模块；
 *   中转内核的租户接口由 agent-net-relay 集成测试覆盖，这里只看运行时怎么用它们。
 * - 最小失败输入：挂起一次部署或退出请求，换账号，再让原请求完成；同一设备另起一把公钥来申请；
 *   同一邀请码下一真一假两条其他账号的申请；对方先拒绝再同意；主人电脑不回话 / 回过「收到」的两次同账号加入。
 * - tier：unit；SSH、存储、账号记录、中转 V2 接口和 Electron 为进程内 fake，无网络、磁盘或真实等待。
 * - 单文件实测：2.88 秒（29 例，测试体 61ms，Windows，含命令启动与转译）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayConfig } from '../selfHostedRelayConfig';
import type { SelfHostedRelayCommand, SelfHostedRelayCommandResult } from '../../../shared/selfHostedRelay';
import { RELAY_VERSION } from '../../../../../../packages/device-link-relay/src/version';
import { RELAY_DEPLOY_STEPS } from '../../../shared/selfHostedRelay';
import { resetClientEndpointsForTest } from '../../clientEndpointsService.js';
import { TEST_CLIENT_ENDPOINTS } from '../../../test/vitest/clientEndpointsFixture.js';

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
  onlyEncrypted: false,
  agentNetEnabled: false,
  invoke: vi.fn(),
  /** device-link-settings.json 是电脑本地设置；各账号共用同一份恢复记录。 */
  switchSettings: {} as Record<string, unknown>,
  switchMetadataWrite: vi.fn(),
  settingsCommitGate: vi.fn(),
  settingsCommitted: vi.fn(),
  /** 账号私有记录(Chat Server preferences)的进程内替身。 */
  prefs: new Map<string, unknown>(),
  /** 某个中转上的秘密(带 V2 身份或只走 V2 时);没有登记的按旧版凭证处理。 */
  secrets: new Map<string, { credential: string; seed: string; agentNet?: unknown }>(),
  /** 中转 V2 接口的替身:按「方法 路径」应答。 */
  agentNet: vi.fn(async (_method: string, _path: string, _body?: unknown): Promise<unknown> => ({})),
  createTenant: vi.fn(),
  writeSecrets: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getVersion: () => 'test' },
  ipcMain: { handle: (key: string, fn: never) => h.handlers.set(key, fn) },
}));
vi.mock('node:fs', () => ({ default: { existsSync: () => true, rmSync: vi.fn() } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: h.owner, generation: h.generation }),
  isAppSessionBoundaryPending: () => h.boundaryPending,
  onAppSessionInvalidated: (cb: () => void) => { h.invalidated = cb; },
}));
vi.mock('../../authManager.js', () => ({
  getAuthState: () => ({ isAuthenticated: true }),
  getCurrentUserId: () => h.owner,
  getCurrentMembershipDisplayName: () => (h.owner === 'account-a' ? 'Alice' : 'Bob'),
  getDeviceId: () => 'test-device',
  getActiveAuthRealm: () => 'global',
  onAuthStateChange: (cb: () => void) => { h.authChanged = cb; },
}));
vi.mock('../../logger.js', () => ({ createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }) }));
vi.mock('../../security/trustedAppRenderer.js', () => ({ assertTrustedAppRendererEvent: vi.fn() }));
vi.mock('../../utils/ipcValidate.js', () => ({ throwIpcError: (code: string) => { throw new Error(code); } }));
vi.mock('../invoke-context.js', () => ({ getDeviceLinkInvokeContext: () => null }));
vi.mock('../deviceName.js', () => ({ deviceName: () => 'Test computer' }));
vi.mock('../providerShareApi.js', () => ({ providerShareLinkApp: () => 'cindy' }));
vi.mock('../settings-store.desktop.js', () => {
  const read = (): Record<string, unknown> => ({ keepAwake: true, agentNetEnabled: h.agentNetEnabled, agentNetOnlyEncrypted: h.onlyEncrypted, ...h.switchSettings });
  const waitForCommit = async (key: string) => {
    if (key === 'agentNetChangedBy') await h.switchMetadataWrite();
    await h.settingsCommitGate(key);
  };
  const commit = (key: string, value: unknown) => {
    if (key === 'agentNetOnlyEncrypted') h.onlyEncrypted = value === true;
    if (key === 'agentNetEnabled') h.agentNetEnabled = value === true;
    if (key === 'agentNetPendingSwitch' || key === 'agentNetChangedBy') {
      h.switchSettings[key] = value;
    }
    h.settingsCommitted(key, value);
  };
  return { readDeviceLinkSettings: read,
    writeDeviceLinkSetting: async (key: string, value: unknown) => { await waitForCommit(key); commit(key, value); },
    updateDeviceLinkSetting: async (key: string, updater: (value: unknown) => unknown) => {
      await waitForCommit(key);
      const value = updater(read()[key]);
      commit(key, value);
      return value;
    },
  };
});
vi.mock('../selfHostedRelayFrameAuth.js', () => ({ refreshRelayCertificatesSoon: vi.fn() }));
vi.mock('../relayAccountPreferences.js', () => ({
  readAccountPreference: async (key: string) => ({ value: structuredClone(h.prefs.get(key) ?? null), revision: 0 }),
  updateAccountPreference: async (key: string, update: (value: unknown) => unknown) => {
    const next = update(structuredClone(h.prefs.get(key) ?? null));
    if (next !== undefined) h.prefs.set(key, structuredClone(next));
  },
}));
vi.mock('../index.js', () => ({
  broadcast: vi.fn(), getDeviceLinkConnectionIssue: () => null,
  remoteBackgroundInvoke: h.invoke,
  getDeviceLinkPeerLinks: () => ({ links: [] }),
  restartDeviceLinkForRelayChange: h.restart, setKeepAwakeEnabled: vi.fn(),
}));
vi.mock('@cindy/device-link-relay', () => ({
  createDeviceCredential: () => ({ credential: 'fake-credential' }),
  hashSecret: () => 'fake-hash', initializeRelay: vi.fn(), startRelayServer: h.startServer,
}));
vi.mock('../selfHostedRelayDeploy.js', () => ({
  bundledRelayVersion: () => RELAY_VERSION, deployRelayToServer: h.deploy, uninstallRelayFromServer: h.uninstall,
  checkRelayServer: vi.fn(), RelayDeployError: class extends Error {},
}));
vi.mock('../selfHostedRelayConfig.js', () => ({
  readRelayConfig: () => structuredClone(h.config.get(h.owner)),
  writeRelayConfig: (value: RelayConfig) => {
    h.write(h.owner, structuredClone(value));
    h.config.set(h.owner, structuredClone(value));
  },
  readRelaySecrets: (relayId: string) => h.secrets.get(relayId) ?? { credential: 'fake-credential', seed: 'A'.repeat(43) },
  writeRelaySecrets: h.writeSecrets, deleteRelaySecrets: h.deleteSecrets,
  activeSelfHostedRelay: () => {
    const active = h.config.get(h.owner)?.active;
    const credential = active ? h.secrets.get(active.relayId)?.credential ?? 'fake-credential' : '';
    return active ? { ...active, credential, signingSeed: 'A'.repeat(43) } : null;
  },
  activeRelayOrigin: () => h.config.get(h.owner)?.active?.origin ?? null,
  secureStorageAvailable: () => true, installSelfHostedRelayRouting: vi.fn(),
  relayDataPath: () => 'in-memory-relay-data',
  readHostNotificationBridgeConfig: () => undefined,
}));

vi.mock('../../maker-host/outbound-fetch.desktop.js', () => ({
  outboundFetch: (input: string, init?: RequestInit) => fetch(input, init),
  createOutboundHttpAgent: async () => undefined,
}));
// V2 身份与证书签发有自己的测试(agentNetRuntime / agent-net-relay);这里只看运行时怎么用中转接口。
vi.mock('../agentNetRuntime.js', () => ({
  agentNetClientForRelay: (_relayId: string, base: string) => ({
    base,
    request: (method: string, path: string, body?: unknown) => h.agentNet(method, path, body),
    directory: () => h.agentNet('GET', '/directory'),
  }),
  approveAgentNetMember: () => ({ certificate: 'member' }),
  createAgentNetTenantRequest: h.createTenant,
  isAgentNetActive: () => false,
  ensureOwnerAgentNetBootstrap: vi.fn(),
  memberAgentNetIdentity: vi.fn(),
  memberAgentNetSecrets: vi.fn(),
}));

import {
  buildRelayJoinLink, computeRelayPairProof, createRelayPairSecret, parseRelayAccountOffers, parseRelayJoinLink, relayAccountTag, relayPublicKeyOf,
} from '@cindy/device-link';
import { createTenantJoinRequest, generateIdentity } from '@cindy/agent-net-relay';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { nodeRelayAuthCrypto } from '@cindy/device-link/node-relay-crypto';
import { agentNetSwitchRemoteHandler, getState, notifyRelayAccountPreferenceChanged, registerSelfHostedRelayIpc } from '../selfHostedRelayRuntime';

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
  resetClientEndpointsForTest(TEST_CLIENT_ENDPOINTS);
  h.onlyEncrypted = false;
  h.agentNetEnabled = false;
  h.switchSettings = {};
  h.switchMetadataWrite.mockReset();
  h.switchMetadataWrite.mockResolvedValue(undefined);
  h.settingsCommitGate.mockReset(); h.settingsCommitGate.mockResolvedValue(undefined);
  h.settingsCommitted.mockReset();
  h.invoke.mockResolvedValue({ ok: true, result: { enabled: false, confirmWithinMs: null } });
  h.prefs = new Map();
  h.secrets = new Map();
  h.agentNet.mockReset();
  h.agentNet.mockResolvedValue({});
  vi.useFakeTimers();
  vi.clearAllMocks();
  h.owner = 'account-a';
  h.generation += 1;
  h.boundaryPending = false;
  h.config = new Map([['account-a', emptyConfig()], ['account-b', emptyConfig()]]);
  registerSelfHostedRelayIpc();
  await vi.runAllTimersAsync();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const deploymentOf = (owner = 'account-a', sshHostId = 'test-server') =>
  h.config.get(owner)!.deployments.find((deployment) => deployment.sshHostId === sshHostId);

// 独立审查 #10095：发起端禁止 V1 时，不能先关闭目标再丢掉唯一可用控制通道。真实 IPC，tier:unit。
it('refuses to send a disable when the controller cannot reconnect over Device Link', async () => {
  h.agentNetEnabled = true;
  h.onlyEncrypted = true;
  const probe = await command({ type: 'peer-agent-net', deviceId: 'target', request: { action: 'status' } });
  expect(probe.peer).toMatchObject({ ok: true, controllerBlock: 'ENCRYPTION_REQUIRED' });
  h.invoke.mockClear();
  const result = await command({ type: 'peer-agent-net', deviceId: 'target', request: { action: 'set', enabled: false, switchId: 'switch-strict-controller' } });
  expect(result.peer).toMatchObject({ ok: false, message: expect.stringContaining('[AGENT_NET_SWITCH_CONTROLLER_ENCRYPTION_REQUIRED]') });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.onlyEncrypted).toBe(true);
});

it('exposes and enforces the V2-only relay restriction on both ends of a switch-back', async () => {
  h.agentNetEnabled = true;
  h.config.get('account-a')!.active = {
    relayId: 'v2-only-relay', name: 'Shared network', baseUrl: 'https://relay.invalid', origin: 'join', role: 'member',
    deviceId: 'test-device', ownerPublicKey: 'A'.repeat(43),
  };
  h.secrets.set('v2-only-relay', { credential: '', seed: 'fixture-seed', agentNet: {} });
  const target = agentNetSwitchRemoteHandler()!;
  await expect(target.handle({ action: 'status' }, 'controller', 'Other computer')).resolves.toMatchObject({ disableBlocked: 'V2_ONLY_RELAY' });
  const probe = await command({ type: 'peer-agent-net', deviceId: 'target', request: { action: 'status' } });
  expect(probe.peer).toMatchObject({ ok: true, controllerBlock: 'V2_ONLY_RELAY' });
  h.invoke.mockClear();
  const request = { action: 'set' as const, enabled: false, switchId: 'switch-v2-only-relay' };
  await expect(target.handle(request, 'controller', 'Other computer')).rejects.toThrow('[AGENT_NET_SWITCH_V2_ONLY_RELAY]');
  const result = await command({ type: 'peer-agent-net', deviceId: 'target', request });
  expect(result.peer).toMatchObject({ ok: false, message: expect.stringContaining('[AGENT_NET_SWITCH_V2_ONLY_RELAY]') });
  expect(h.invoke).not.toHaveBeenCalled();
  expect(h.agentNetEnabled).toBe(true);
});

// 账号代次：开关按电脑保存，旧账号排队的 IPC 不能在新账号下取消恢复并启用/重连。真实装配 IPC，unit。
// 缺口：部署边界测试没经过远程切换队列。最小输入：挂起归因写入，排队本机打开，换账号后才放行写入。
it('rejects an old account local switch queued behind a remote write without enabling under the new account', async () => {
  const metadata = deferred<void>();
  h.switchMetadataWrite.mockImplementationOnce(() => metadata.promise);
  const remote = agentNetSwitchRemoteHandler()!.handle({ action: 'set', enabled: true, switchId: 'switch-owner-a' }, 'controller', 'Other computer')
    .then(() => null, (error: unknown) => error);
  await vi.advanceTimersByTimeAsync(0);
  expect(h.switchMetadataWrite).toHaveBeenCalledTimes(1);
  const pending = structuredClone(h.switchSettings.agentNetPendingSwitch);
  const local = command({ type: 'set-agent-net', enabled: true });
  await vi.advanceTimersByTimeAsync(0);
  h.invalidated();
  h.owner = 'account-b'; h.generation += 1;
  h.authChanged();
  metadata.resolve();
  await remote;
  const result = await local;
  expect.soft(result.error).toBe('NOT_SIGNED_IN');
  expect.soft(h.switchSettings.agentNetPendingSwitch).toEqual(pending);
  expect.soft(h.agentNetEnabled).toBe(false);
  expect.soft(h.restart).not.toHaveBeenCalled();
});

// Greptile #10095 discussion_r4547215636：真实 IPC；等待设置提交时换账号，未确认打开不能失去恢复。
// 缺口：前例只在归因写入时换账号。最小输入：pending 清理等待；以及清理已提交、await 尚未恢复。tier:unit。
it('keeps recovery when the account expires while a local cancellation waits to commit', async () => {
  await agentNetSwitchRemoteHandler()!.handle({ action: 'set', enabled: true, switchId: 'switch-clear-owner' }, 'controller', 'Other computer');
  await vi.advanceTimersByTimeAsync(400);
  const pending = structuredClone(h.switchSettings.agentNetPendingSwitch);
  const entered = deferred<void>(); const release = deferred<void>();
  h.settingsCommitGate.mockImplementation(async (key: string) => {
    if (key === 'agentNetPendingSwitch') { entered.resolve(); await release.promise; }
  });
  const local = command({ type: 'set-agent-net', enabled: false });
  await entered.promise;
  h.invalidated(); h.owner = 'account-b'; h.generation += 1; h.authChanged();
  release.resolve();
  expect((await local).error).toBe('NOT_SIGNED_IN');
  expect(h.switchSettings.agentNetPendingSwitch).toEqual(pending);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(h.agentNetEnabled).toBe(false);
  expect(h.switchSettings.agentNetPendingSwitch).toBeNull();
});

// 初次 pending 已有效提交后才换号：必须先挂设备期限，再拒绝原账号后续步骤，避免无计时的 BUSY 记录。
it('arms recovery when the account expires just after the initial pending record commits', async () => {
  h.settingsCommitted.mockImplementation((key: string, value: unknown) => {
    if (key === 'agentNetPendingSwitch' && value !== null) {
      h.invalidated(); h.owner = 'account-b'; h.generation += 1; h.authChanged();
    }
  });
  await expect(agentNetSwitchRemoteHandler()!.handle({ action: 'set', enabled: true, switchId: 'switch-initial-commit' }, 'controller', 'Other computer')).rejects.toThrow();
  h.settingsCommitted.mockReset();
  expect(h.agentNetEnabled).toBe(false);
  await vi.advanceTimersByTimeAsync(75_000);
  expect(h.switchSettings.agentNetPendingSwitch).toBeNull();
});

it('does not discard recovery before applying a local selection when the account expires after cleanup commits', async () => {
  await agentNetSwitchRemoteHandler()!.handle({ action: 'set', enabled: true, switchId: 'switch-clear-resume' }, 'controller', 'Other computer');
  await vi.advanceTimersByTimeAsync(400);
  h.settingsCommitted.mockImplementation((key: string, value: unknown) => {
    if (key === 'agentNetPendingSwitch' && value === null) {
      h.invalidated(); h.owner = 'account-b'; h.generation += 1; h.authChanged();
    }
  });
  const result = await command({ type: 'set-agent-net', enabled: false });
  expect(result.error).toBe('NOT_SIGNED_IN');
  await vi.advanceTimersByTimeAsync(75_000);
  expect(h.agentNetEnabled).toBe(false);
});

// #10095 discussion_r4546067871：旧链接加入的中转没有 V2 身份，不能宣称已具备切换前提。
// 真实远程 handler；已有部署/配对测试没有运行其只读探测。最小输入：member 仅有 V1 凭证。tier:unit。
it('reports missing Agent-Net identity on the selected self-hosted relay before accepting a switch', async () => {
  h.config.get('account-a')!.active = {
    relayId: 'legacy-relay', name: 'Legacy relay', baseUrl: 'https://relay.invalid', origin: 'join', role: 'member',
    deviceId: 'test-device', ownerPublicKey: 'A'.repeat(43),
  };
  const handler = agentNetSwitchRemoteHandler()!;
  await expect(handler.handle({ action: 'status' }, 'controller', 'Other computer')).resolves.toMatchObject({ blocked: 'RELAY_IDENTITY_MISSING' });
  await expect(handler.handle({ action: 'set', enabled: true, switchId: 'switch-legacy' }, 'controller', 'Other computer')).rejects.toThrow('[AGENT_NET_SWITCH_NOT_READY]');
  expect(h.restart).not.toHaveBeenCalled();
});

// Minimal privacy policy change must reach the host-owned preference and close compatibility routes.
// Existing deployment tests did not exercise the new IPC command (unit tier, no network).
it('commits the encrypted-only policy through the existing IPC and reconnects with the new rule', async () => {
  const result = await command({ type: 'set-agent-net-encryption', enabled: true });
  expect(result.error).toBeUndefined(); expect(result.state.agentNetOnlyEncrypted).toBe(true);
  expect(h.restart).toHaveBeenCalledTimes(1);
  expect((await command({ type: 'state' })).state.agentNetOnlyEncrypted).toBe(true);
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
  let features: string[] | null = ['tenants-v1'];
  const fetchMock = vi.fn(async (url: string) => url.endsWith('/api/agent-net/info')
    ? new Response(JSON.stringify({ features }), { status: features ? 200 : 404 })
    : new Response(JSON.stringify({ relayId, devices: 3, online: 2, certificateExpiresAt: '2026-11-04T00:00:00.000Z' })));
  vi.stubGlobal('fetch', fetchMock);
  const status = await command({ type: 'deployment-status', relayId });
  expect(status.deploymentStatus).toEqual({
    online: true, devices: 3, onlineDevices: 2, certificateExpiresAt: '2026-11-04T00:00:00.000Z', agentNet: true, tenants: true,
  });
  expect(fetchMock).toHaveBeenCalledWith(
    'https://203.0.113.10/api/device-link/relay/admin/status',
    expect.objectContaining({ headers: { authorization: 'CindyRelay fake-credential' } }),
  );
  // 只装了 Device Link 的旧中转：能力声明 404，详情里要能看出它不带 Agent-Net。
  features = null;
  expect((await command({ type: 'deployment-status', relayId })).deploymentStatus).toMatchObject({ online: true, agentNet: false, tenants: false });
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

// 用户 2026-11-09:同账号设备不用链接、主人电脑自动放行——但只放行登记在账号里的那台设备、那把公钥。
// 最小失败输入:中转上同时有登记过的申请和同一设备换了公钥的申请,后者必须留给主人处理。
it('auto-approves only the device and key registered in the account and leaves others for the owner', async () => {
  const relayId = '55555555-5555-4555-8555-555555555555';
  const ownerPublicKey = relayPublicKeyOf(nodeRelayAuthCrypto, 'A'.repeat(43))!;
  const phoneKey = relayPublicKeyOf(nodeRelayAuthCrypto, 'Q'.repeat(43))!;
  const otherKey = relayPublicKeyOf(nodeRelayAuthCrypto, 'w'.repeat(43))!;
  h.config.get('account-a')!.active = {
    relayId, name: 'Home relay', baseUrl: 'https://203.0.113.10', role: 'owner', origin: 'server', deviceId: 'test-device', ownerPublicKey,
  };
  h.prefs.set('relay.join.v1', {
    v: 1,
    requests: { phone: { requestId: '66666666-6666-4666-8666-666666666666', deviceName: 'Phone', platform: 'ios', relayId,
      ownerDeviceId: 'test-device', publicKey: phoneKey, createdAt: Date.now() } },
    invites: {},
  });
  const registered = '77777777-7777-4777-8777-777777777777';
  const swapped = '88888888-8888-4888-8888-888888888888';
  let pairRequests: Array<Record<string, string>> = [];
  const approved: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path.endsWith('/relay/admin/join-codes')) return new Response(JSON.stringify({ code: 'J'.repeat(43) }));
    if (path.endsWith('/relay/admin/pair-requests')) return new Response(JSON.stringify({ requests: pairRequests }));
    const decision = /pair-requests\/([^/]+)\/approve$/.exec(path);
    if (decision) {
      approved.push(decision[1]);
      pairRequests = pairRequests.filter((request) => request.requestId !== decision[1]);
      return new Response('{}');
    }
    return new Response('{}', { status: 404 });
  }));

  notifyRelayAccountPreferenceChanged('relay.join.v1');
  await vi.advanceTimersByTimeAsync(100);
  const invite = (h.prefs.get('relay.join.v1') as { invites: Record<string, { link: string }> }).invites.phone;
  const link = parseRelayJoinLink(invite.link)!;
  expect(link.ownerPublicKey).toBe(ownerPublicKey);
  // 先回过一声「收到」,之后换成了链接。
  expect(h.prefs.get('relay.join.v1')).toMatchObject({ invites: { phone: { requestId: '66666666-6666-4666-8666-666666666666' } } });
  expect((h.prefs.get('relay.join.v1') as { invites: Record<string, { pending?: true }> }).invites.phone.pending).toBeUndefined();

  const proof = (publicKey: string) => computeRelayPairProof(nodeRelayAuthCrypto, link.pairSecret, { relayId, deviceId: 'phone', publicKey });
  pairRequests = [
    { requestId: registered, deviceId: 'phone', deviceName: 'Phone', verifyCode: '1111', publicKey: phoneKey, proof: proof(phoneKey) },
    { requestId: swapped, deviceId: 'phone', deviceName: 'Phone', verifyCode: '2222', publicKey: otherKey, proof: proof(otherKey) },
  ];
  await vi.advanceTimersByTimeAsync(2_100);
  expect(approved).toEqual([registered]);
  expect(getState().pendingRequests.map((request) => request.requestId)).toEqual([swapped]);
  await command({ type: 'use-official' });
});

// 用户 2026-11-09:中转可以分享给其他账号。中转替对方转交申请,可能把对方的根公钥换成自己的:
// 主人电脑只同意配对证明对得上自己给出的那条链接的申请。最小失败输入:同一邀请码下一真一假两条申请。
it('shares the relay with another account only for a request proven to come from its own link, and can stop sharing', async () => {
  const relayId = '55555555-5555-4555-8555-555555555555';
  h.config.get('account-a')!.active = {
    relayId, name: 'Home relay', baseUrl: 'https://203.0.113.10', role: 'owner', origin: 'server', deviceId: 'test-device',
    ownerPublicKey: relayPublicKeyOf(nodeRelayAuthCrypto, 'A'.repeat(43))!,
  };
  h.secrets.set(relayId, { credential: 'fake-credential', seed: 'A'.repeat(43), agentNet: {} });
  const invite = 'T'.repeat(32);
  let tenantRequests: unknown[] = [];
  let tenants = [{ networkId: 'private:' + randomUUID(), accountName: 'Alice', devices: 2, online: true, createdAt: Date.now() }];
  const calls: string[] = [];
  h.agentNet.mockImplementation(async (method: string, path: string) => {
    calls.push(`${method} ${path}`);
    if (path === '/join-codes') return { joinCode: 'V'.repeat(32), expiresAt: Date.now() + 300_000 };
    if (path === '/tenant-invites') return { inviteCode: invite, expiresAt: Date.now() + 300_000 };
    if (path === '/join-requests') return { requests: [] };
    if (path === '/tenant-requests') return { requests: tenantRequests };
    if (path === '/tenants' && method === 'GET') return { tenants };
    if (method === 'DELETE' && path.startsWith('/tenants/')) {
      tenants = tenants.filter((tenant) => '/tenants/' + encodeURIComponent(tenant.networkId) !== path);
      return { ok: true };
    }
    return {};
  });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    const path = new URL(url).pathname;
    if (path === '/api/agent-net/info') return new Response(JSON.stringify({ features: ['tenants-v1'] }));
    if (path.endsWith('/relay/admin/join-codes')) return new Response(JSON.stringify({ code: 'J'.repeat(43) }));
    if (path.endsWith('/relay/admin/pair-requests')) return new Response(JSON.stringify({ requests: [] }));
    return new Response('{}', { status: 404 });
  }));

  const shared = await command({ type: 'create-join-link', fresh: true });
  expect(shared.state.joinLink?.otherAccounts).toBe(true);
  const link = parseRelayJoinLink(shared.state.joinLink!.link)!;
  expect(link).toMatchObject({ tenantCode: invite, ownerAccountTag: relayAccountTag(nodeRelayAuthCrypto, 'account-a') });
  const ask = (pairingSecret: string) => createTenantJoinRequest({
    root: generateKeyPairSync('ed25519').privateKey, identity: generateIdentity('bob-pc'), networkId: 'private:' + randomUUID(),
    subject: 'account-b', name: 'Home relay', accountName: 'Bob', deviceName: 'Bob PC', inviteCode: invite, pairingSecret,
  });
  const genuine = ask(link.pairSecret);
  const forged = ask('F'.repeat(43));
  tenantRequests = [{ request: genuine, requestedAt: Date.now() }, { request: forged, requestedAt: Date.now() }];
  await vi.advanceTimersByTimeAsync(2_100);
  expect(getState().pendingRequests.map((request) => [request.requestId, request.accountName, request.verified])).toEqual([
    ['tenant:' + genuine.requestId, 'Bob', true],
    ['tenant:' + forged.requestId, 'Bob', false],
  ]);
  expect((await command({ type: 'decide', requestId: 'tenant:' + forged.requestId, approve: true })).error).toBe('PAIR_PROOF_INVALID');
  expect(calls).not.toContain(`POST /tenant-requests/${forged.requestId}/approve`);
  expect((await command({ type: 'decide', requestId: 'tenant:' + genuine.requestId, approve: true })).error).toBeUndefined();
  expect(calls).toContain(`POST /tenant-requests/${genuine.requestId}/approve`);

  await command({ type: 'refresh-account-relays' });
  const alice = getState().tenants!.find((tenant) => tenant.accountName === 'Alice')!;
  expect(alice).toMatchObject({ devices: 2, online: true });
  await command({ type: 'revoke-tenant', tenantId: alice.tenantId });
  expect(calls).toContain('DELETE /tenants/' + encodeURIComponent('private:' + alice.tenantId));
  expect(getState().tenants).toEqual([]);
  await command({ type: 'use-official' });
});

// 用户 2026-11-09:别人分享的中转,本账号在上面建自己的网络;本账号其他设备经账号目录看到它,一键加入。
// 最小输入:打开对方的分享链接,对方先拒绝一次、再同意一次。被拒时本机为它生成的秘密要删掉。
it('joins a relay shared by another account as its own network only after approval, and offers it to this account’s devices', async () => {
  await switchOwner('account-b');
  const link = buildRelayJoinLink({
    baseUrl: 'https://203.0.113.10', code: 'J'.repeat(43), ownerPublicKey: relayPublicKeyOf(nodeRelayAuthCrypto, 'A'.repeat(43))!,
    pairSecret: createRelayPairSecret(nodeRelayAuthCrypto), app: 'cindy', agentNetCode: 'V'.repeat(32),
    tenantCode: 'T'.repeat(32), ownerAccountTag: relayAccountTag(nodeRelayAuthCrypto, 'account-a'), ownerName: 'Alice',
  });
  const networks: string[] = [];
  h.createTenant.mockImplementation((networkId: string, _seed: string, input: { inviteCode: string }) => {
    networks.push(networkId);
    return { requestId: randomUUID(), inviteCode: input.inviteCode, pairingProof: 'P'.repeat(43) };
  });
  const statuses = ['rejected'];
  vi.stubGlobal('fetch', vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/device-link/relay/info') {
      return new Response(JSON.stringify({ relayId: 'relay', name: 'Alice relay', protocolVersion: 1, features: ['pairing-v1', 'device-signatures-v1'] }));
    }
    if (path === '/api/agent-net/tenant-join') {
      const body = JSON.parse(String(init?.body)) as { requestId: string };
      return new Response(JSON.stringify({ requestId: body.requestId, pollToken: 'poll' }), { status: 202 });
    }
    if (path === '/api/agent-net/tenant-join/status') return new Response(JSON.stringify({ status: statuses.shift() ?? 'pending' }));
    return new Response('{}', { status: 404 });
  }));
  h.agentNet.mockResolvedValue([]);

  await command({ type: 'join', link });
  await vi.advanceTimersByTimeAsync(2_100);
  expect(getState().join).toMatchObject({ status: 'failed', error: 'REJECTED' });
  expect(h.deleteSecrets).toHaveBeenCalledWith(networks[0]);
  expect(h.config.get('account-b')!.active).toBeNull();

  statuses.push('pending', 'approved');
  await command({ type: 'join', link });
  await vi.advanceTimersByTimeAsync(2_100);
  expect(getState().join).toMatchObject({ status: 'waiting', relayName: 'Alice relay' });
  await vi.advanceTimersByTimeAsync(2_100);
  const networkId = networks[1];
  expect(h.config.get('account-b')!.active).toMatchObject({
    relayId: networkId, role: 'owner', origin: 'join', baseUrl: 'https://203.0.113.10', shared: { ownerName: 'Alice' },
  });
  expect(h.deleteSecrets).not.toHaveBeenCalledWith(networkId);
  expect(getState().relay).toMatchObject({ role: 'owner', origin: 'join', shared: { ownerName: 'Alice' } });
  await vi.advanceTimersByTimeAsync(100);
  expect(parseRelayAccountOffers(h.prefs.get('relay.offers.v1'))).toEqual([
    expect.objectContaining({ ownerDeviceId: 'test-device', relayId: networkId, kind: 'shared', sharedBy: 'Alice' }),
  ]);

  // 离开:这个网络从中转上删掉(本账号经它加入的设备一起断开),本机秘密也删掉。
  h.secrets.set(networkId, { credential: '', seed: 'A'.repeat(43), agentNet: {} });
  const calls: string[] = [];
  h.agentNet.mockImplementation(async (method: string, path: string) => { calls.push(`${method} ${path}`); return {}; });
  await command({ type: 'use-official' });
  expect(calls).toContain('DELETE /tenants/' + encodeURIComponent('private:' + networkId));
  expect(h.deleteSecrets).toHaveBeenCalledWith(networkId);
});

// 用户 2026-11-09:主人电脑不在线时尽早提示,不用等 45 秒。在线的主人电脑读到申请先回一声「收到」;
// 最小输入:没人回话的一次加入(约 12 秒内报错),和回过「收到」、还在准备链接的一次(超过 12 秒仍在等)。
it('reports an offline owner computer within seconds, but keeps waiting once that computer has acknowledged', async () => {
  const relayId = '55555555-5555-4555-8555-555555555555';
  h.prefs.set('relay.offers.v1', { v: 1, offers: { 'other-pc': {
    ownerDeviceName: 'Other PC', relayId, name: 'Home relay', baseUrl: 'https://203.0.113.10',
    ownerPublicKey: relayPublicKeyOf(nodeRelayAuthCrypto, 'A'.repeat(43))!, kind: 'server', updatedAt: Date.now(),
  } } });
  vi.stubGlobal('fetch', vi.fn(async (url: string) => new URL(url).pathname === '/api/device-link/relay/info'
    ? new Response(JSON.stringify({ relayId, name: 'Home relay', protocolVersion: 1, features: ['pairing-v1', 'device-signatures-v1'] }))
    : new Response('{}', { status: 404 })));
  await command({ type: 'refresh-account-relays' });

  await command({ type: 'join-account-relay', ownerDeviceId: 'other-pc', relayId });
  await vi.advanceTimersByTimeAsync(14_500);
  expect(getState().join).toMatchObject({ status: 'failed', error: 'OWNER_UNAVAILABLE', accountRelayId: relayId });

  await command({ type: 'join-account-relay', ownerDeviceId: 'other-pc', relayId });
  await vi.advanceTimersByTimeAsync(100);
  const board = h.prefs.get('relay.join.v1') as { v: 1; requests: Record<string, { requestId: string }>; invites: Record<string, unknown> };
  board.invites['test-device'] = { requestId: board.requests['test-device'].requestId, relayId, pending: true, expiresAt: Date.now() + 600_000 };
  await vi.advanceTimersByTimeAsync(14_500);
  expect(getState().join).toMatchObject({ status: 'connecting', accountRelayId: relayId });
  await vi.advanceTimersByTimeAsync(32_000);
  expect(getState().join).toMatchObject({ status: 'failed', error: 'OWNER_UNAVAILABLE' });
});
