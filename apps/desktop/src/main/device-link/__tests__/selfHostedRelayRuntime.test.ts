/**
 * 测试价值
 * - 生产入口与可观察结果：注册后的 self-hosted-relay:command IPC；部署完成只保存记录、不切换线路，
 *   多台服务器各留一条记录，改名只改本机记录；账号切换后的迟到部署/退出响应不能改写新账号配置或覆盖新部署进度。
 * - Bug/规则依据：appSessionState.activeOwnerScopeKey 的异步账号边界；原部署回调跨 await 读取当前账号，
 *   会将旧账号的部署记录写入新账号，切换中转在等待退出旧中转时也有同样问题。
 * - 现有覆盖缺口：部署器测试只验证 SSH 步骤，没有经过运行时 IPC 与账号切换，故单独覆盖该模块。
 * - 最小失败输入：挂起一次部署或退出请求，换账号，再让原请求完成。
 * - tier：unit；SSH、存储和 Electron 为进程内 fake，无网络、磁盘或真实等待。
 * - 单文件实测：1.32 秒（15 例，测试体 44ms，Windows）。
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { RelayConfig } from '../selfHostedRelayConfig';
import type { SelfHostedRelayCommand, SelfHostedRelayCommandResult } from '../../../shared/selfHostedRelay';
import { RELAY_VERSION } from '../../../../../../packages/device-link-relay/src/version';
import { RELAY_DEPLOY_STEPS } from '../../../shared/selfHostedRelay';

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
  bundledRelayVersion: () => RELAY_VERSION, deployRelayToServer: h.deploy, uninstallRelayFromServer: h.uninstall,
  checkRelayServer: vi.fn(), RelayDeployError: class extends Error {},
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
  h.config = new Map([['account-a', emptyConfig()], ['account-b', emptyConfig()]]);
  registerSelfHostedRelayIpc();
  await vi.runAllTimersAsync();
});

afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });

const deploymentOf = (owner = 'account-a', sshHostId = 'test-server') =>
  h.config.get(owner)!.deployments.find((deployment) => deployment.sshHostId === sshHostId);

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
