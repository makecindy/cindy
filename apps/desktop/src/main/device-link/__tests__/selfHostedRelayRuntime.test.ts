/**
 * 测试价值
 * - 生产入口与可观察结果：注册后的 self-hosted-relay:command IPC；部署完成会保存并切换中转，
 *   账号切换后的迟到部署/退出响应不能改写新账号配置或覆盖新部署进度。
 * - Bug/规则依据：appSessionState.activeOwnerScopeKey 的异步账号边界；原部署回调跨 await 读取当前账号，
 *   会将旧账号的部署记录写入新账号，切换中转在等待退出旧中转时也有同样问题。
 * - 现有覆盖缺口：部署器测试只验证 SSH 步骤，没有经过运行时 IPC 与账号切换，故单独覆盖该模块。
 * - 最小失败输入：挂起一次部署或退出请求，换账号，再让原请求完成。
 * - tier：unit；SSH、存储和 Electron 为进程内 fake，无网络、磁盘或真实等待。
 * - 单文件实测：1.39 秒（6 例，测试体 22ms，Windows）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayConfig } from '../selfHostedRelayConfig';
import type { SelfHostedRelayCommand, SelfHostedRelayCommandResult } from '../../../shared/selfHostedRelay';

const h = vi.hoisted(() => ({
  owner: 'account-a',
  generation: 0,
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
}));

vi.mock('electron', () => ({
  app: { on: vi.fn(), getVersion: () => 'test' },
  ipcMain: { handle: (key: string, fn: never) => h.handlers.set(key, fn) },
}));
vi.mock('node:fs', () => ({ default: { existsSync: () => true, rmSync: vi.fn() } }));
vi.mock('../../appSessionState.js', () => ({
  activeOwnerScopeKey: () => `${h.owner}:${h.generation}`,
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: h.owner, generation: h.generation }),
  isAppSessionBoundaryPending: () => false,
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
  bundledRelayVersion: () => '0.2.0', deployRelayToServer: h.deploy, uninstallRelayFromServer: h.uninstall,
  RelayDeployError: class extends Error {},
}));
vi.mock('../selfHostedRelayConfig.js', () => ({
  readRelayConfig: () => structuredClone(h.config.get(h.owner)),
  writeRelayConfig: (value: RelayConfig) => {
    h.write(h.owner, structuredClone(value));
    h.config.set(h.owner, structuredClone(value));
  },
  readRelaySecrets: () => ({ credential: 'fake-credential', seed: 'A'.repeat(43) }),
  writeRelaySecrets: vi.fn(), deleteRelaySecrets: h.deleteSecrets,
  activeSelfHostedRelay: () => {
    const active = h.config.get(h.owner)?.active;
    return active ? { ...active, credential: 'fake-credential', signingSeed: 'A'.repeat(43) } : null;
  },
  activeRelayOrigin: () => h.config.get(h.owner)?.active?.origin ?? null,
  secureStorageAvailable: () => true, installSelfHostedRelayRouting: vi.fn(),
  relayDataPath: () => 'in-memory-relay-data',
}));

import { getState, registerSelfHostedRelayIpc } from '../selfHostedRelayRuntime';

function emptyConfig(): RelayConfig {
  return { version: 2, active: null, host: { enabled: false, port: 47820, listenAll: false, externalUrl: null, relayId: null }, deployment: null };
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
  h.config = new Map([['account-a', emptyConfig()], ['account-b', emptyConfig()]]);
  registerSelfHostedRelayIpc();
  await vi.runAllTimersAsync();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

it('records a completed deployment and activates it for the account that started it', async () => {
  h.deploy.mockResolvedValue({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(h.config.get('account-a')?.deployment?.complete).toBe(true);
  expect(h.config.get('account-a')?.active?.origin).toBe('server');
  expect(getState().deployJob?.status).toBe('done');
  expect(h.restart).toHaveBeenCalledOnce();
});

// Bug：重启后进度对象不存在，持久部署记录仍须能继续，并保留已写入服务器的主人身份。tier: unit。
it('resumes an incomplete persisted deployment with the same relay identity', async () => {
  h.deploy.mockRejectedValueOnce(new Error('connection lost'));
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const previous = structuredClone(h.config.get('account-a')!.deployment!);
  await switchOwner('account-b');
  await switchOwner('account-a');
  expect(getState().deployJob).toBeNull();
  expect(getState().deployment?.relayVersion).toBe('');
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  expect(h.deploy.mock.calls.at(-1)![0].init.relayId).toBe(previous.relayId);
  expect(h.config.get('account-a')!.deployment?.complete).toBe(true);
});

it.each(['resolve', 'reject'] as const)('ignores an old deployment that later %s after a new account starts its own', async (outcome) => {
  const old = deferred<{ relayVersion: string }>();
  const next = deferred<{ relayVersion: string }>();
  h.deploy.mockReturnValueOnce(old.promise).mockReturnValueOnce(next.promise);
  await command(deployCommand);
  const oldStep = h.deploy.mock.calls[0][0].onStep;
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

it('does not remove another account’s deployment after a delayed uninstall', async () => {
  h.deploy.mockResolvedValueOnce({ relayVersion: '0.2.0' });
  await command(deployCommand);
  await vi.runAllTimersAsync();
  const uninstall = deferred<void>();
  h.uninstall.mockReturnValueOnce(uninstall.promise);
  await command({ type: 'uninstall-deployment', removeData: true });
  await switchOwner('account-b');
  h.write.mockClear();
  h.deleteSecrets.mockClear();
  uninstall.resolve();
  await vi.runAllTimersAsync();
  expect(h.write).not.toHaveBeenCalled();
  expect(h.deleteSecrets).not.toHaveBeenCalled();
  expect(getState().deployJob).toBeNull();
});
