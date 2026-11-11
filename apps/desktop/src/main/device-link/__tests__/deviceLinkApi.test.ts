/**
 * 测试价值
 * - 生产入口与可观察结果:`deviceLinkApiFetch`(设备列表、媒体预签名、远程桌面 ICE 共用)经真实的
 *   `serverApiFetch` 发出的请求 —— 断言发到哪个地址、带什么 Authorization,以及 401 后是否触发账号刷新/登出。
 * - Bug/规则依据:docs/self-hosted-relay-plan.md §5.2/§8「Cindy 账号 token 不发往自建中转」「自建中转的 401
 *   不能让 Cindy 账号登出」;serverApiFetch 对 UNAUTHORIZED 类 401 会 refresh 并 invalidateSession。
 * - 现有覆盖缺口:serverApiClient.test.ts 只测官方 Bearer 路径;路由逻辑在 deviceLinkApi.ts,需要额外 mock
 *   中转配置,放进 serverApiClient.test.ts 会让那份文件的所有用例都背上无关 mock,故单独成文件。
 * - 最小失败输入:自建中转生效时任意 REST 请求;中转回 401 UNAUTHORIZED。
 * - tier:unit(electron net 与 authManager 为进程内 fake)。
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  netFetch: vi.fn(),
  getAccessToken: vi.fn(() => 'account-access-token'),
  refresh: vi.fn(async () => true),
  invalidateSession: vi.fn(),
  officialBase: 'https://device-link.official.invalid',
  relay: null as null | import('../selfHostedRelayRouting').ActiveSelfHostedRelay,
  hasV2: false,
  v2Active: false, onlyEncrypted: false, selection: 'route-a',
  scope: 'owner-a',
  v2Directory: vi.fn(), v2Request: vi.fn(),
  readV2Secrets: vi.fn(),
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../../authManager', () => ({
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
  invalidateSession: mocks.invalidateSession,
}));
vi.mock('../../i18n.desktop.js', () => ({ getResolvedMainLocale: () => 'zh-CN' }));
vi.mock('../../logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => mocks.officialBase,
}));
vi.mock('../index.js', () => ({ deviceLinkApiBase: () => 'http://192.168.1.20:47820', remoteBackgroundInvoke: vi.fn() }));
vi.mock('../providerShareGuest.js', () => ({ getReceivedShares: () => [] }));
vi.mock('../settings-store.desktop.js', () => ({ readDeviceLinkSettings: () => ({ disabledControlDeviceIds: [], lastKnownDeviceNames: {} }) }));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: vi.fn(async () => []) }));
vi.mock('../selfHostedRelayConfig.js', () => ({ readRelaySecrets: mocks.readV2Secrets }));
vi.mock('../agentNetRuntime.js', () => ({ agentNetClientForRelay: () => ({
  rootPublicKey: 'A'.repeat(43), directory: mocks.v2Directory, request: mocks.v2Request,
}), currentAgentNetClient: () => mocks.v2Active ? { certificate: { deviceId: 'pc' }, directory: mocks.v2Directory } : null,
agentNetRequiresEncryption: () => mocks.onlyEncrypted, agentNetSelectionKey: () => mocks.selection }));
vi.mock('../../appSessionState.js', () => ({ activeOwnerScopeKey: () => mocks.scope, isAppSessionBoundaryPending: () => false }));

import { deviceLinkApiFetch, officialDeviceLinkApiFetch } from '../deviceLinkApi';
import { setSelfHostedRelaySource } from '../selfHostedRelayRouting';
import { remoteLocalAgentModels } from '../../local-agent/remoteCatalog.js';

setSelfHostedRelaySource(() => mocks.relay);

function lastRequest(): { url: string; authorization: string | undefined } {
  const [url, init] = mocks.netFetch.mock.calls.at(-1)!;
  return { url, authorization: (init as { headers: Record<string, string> }).headers.Authorization };
}

describe('deviceLinkApiFetch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.relay = null;
    mocks.officialBase = 'https://device-link.official.invalid';
    mocks.hasV2 = false; mocks.scope = 'owner-a';
    mocks.v2Active = false; mocks.onlyEncrypted = false; mocks.selection = 'route-a';
    mocks.readV2Secrets.mockReset().mockImplementation(() => mocks.hasV2 ? { agentNet: {} } : null);
    mocks.v2Directory.mockReset(); mocks.v2Request.mockReset().mockResolvedValue({});
  });
  // Lazy V2 discovery is an await boundary even for a legacy-only deployment. The captured route's
  // owner generation must be checked before sending any legacy mutation (unit tier, real API adapter).
  it('rejects a device mutation if ownership changes during lazy credential discovery', async () => {
    mocks.relay = { relayId: 'private', name: 'test', baseUrl: 'http://192.168.1.20:47820', role: 'owner',
      credential: 'relay-credential', deviceId: 'owner', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43),
      get scopeKey() { return mocks.scope; } };
    mocks.readV2Secrets.mockImplementationOnce(() => { mocks.scope = 'owner-b'; return null; });
    await expect(deviceLinkApiFetch('/api/device-link/devices/peer', { method: 'DELETE' })).rejects.toThrow('DEVICE_LINK_SCOPE_CHANGED');
    expect(mocks.netFetch).not.toHaveBeenCalled(); expect(mocks.v2Request).not.toHaveBeenCalled();
  });
  // V1 and V2 use independent membership stores: a successful management operation must not leave the V2 identity active.
  it.each(['DELETE', 'PATCH'] as const)('updates both private protocols for %s without sending an account token', async (method) => {
    mocks.relay = { baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'owner',
      relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43) };
    mocks.hasV2 = true; mocks.v2Directory.mockResolvedValue([{ certificate: { deviceId: 'peer' } }]);
    mocks.netFetch.mockResolvedValue(new Response('{}', { status: 200 }));
    const body = method === 'PATCH' ? { name: 'Updated' } : undefined;
    await deviceLinkApiFetch('/api/device-link/devices/peer', { method, body });
    expect(mocks.v2Request).toHaveBeenCalledWith(method, '/devices/peer', body);
    expect(lastRequest()).toEqual({ url: 'http://192.168.1.20:47820/api/device-link/devices/peer', authorization: 'CindyRelay relay-credential' });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });
  it('cancels a management mutation if the owner changes while the V2 directory is loading', async () => {
    mocks.relay = { baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'owner',
      relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43) };
    mocks.hasV2 = true;
    mocks.v2Directory.mockImplementation(async () => { mocks.scope = 'owner-b'; return [{ certificate: { deviceId: 'peer' } }]; });
    await expect(deviceLinkApiFetch('/api/device-link/devices/peer', { method: 'DELETE' })).rejects.toThrow('DEVICE_LINK_SCOPE_CHANGED');
    expect(mocks.v2Request).not.toHaveBeenCalled(); expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  // /models 复用真实目录读取与 API 路由；旧 caller 直接用 serverApiFetch 会把官方 token 发到自建中转。
  // 最小输入为自建路由 + 空设备目录，不能仅 mock 新 helper，否则会漏掉 caller 未迁移的问题。tier: unit。
  it('uses the relay credential when the local Agent reads its remote model directory', async () => {
    mocks.relay = {
      baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'member',
      relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43),
    };
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
    await expect(remoteLocalAgentModels(() => true)).resolves.toEqual([]);
    expect(lastRequest()).toEqual({ url: 'http://192.168.1.20:47820/api/device-link/devices', authorization: 'CindyRelay relay-credential' });
    expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  // 共享任务附件只存在于官方存储:走自建中转时也必须带账号 token 发往官方,不能落到中转。
  it('keeps official requests on the official endpoint with the account token while a relay is active', async () => {
    mocks.relay = {
      baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'member',
      relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43),
    };
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ getUrl: 'https://oss.invalid/o' }), { status: 200 }));
    await officialDeviceLinkApiFetch('/api/device-link/media/presign-get', { method: 'POST', body: { key: 'k' } });
    expect(lastRequest()).toEqual({
      url: 'https://device-link.official.invalid/api/device-link/media/presign-get',
      authorization: 'Bearer account-access-token',
    });
  });

  it('sends the relay credential, never the account token, and keeps the Cindy session on a relay 401', async () => {
    mocks.relay = {
      baseUrl: 'http://192.168.1.20:47820',
      credential: 'relay-credential',
      role: 'member',
      relayId: 'r',
      name: 'Home',
      deviceId: 'pc',
      signingSeed: 'A'.repeat(43),
      ownerPublicKey: 'A'.repeat(43),
    };
    mocks.netFetch.mockResolvedValue(
      new Response(JSON.stringify({ error: { code: 'UNAUTHORIZED', message: 'nope' } }), { status: 401 }),
    );

    await expect(deviceLinkApiFetch('/api/device-link/devices')).rejects.toMatchObject({ statusCode: 401 });

    expect(mocks.netFetch).toHaveBeenCalledTimes(1);
    expect(lastRequest()).toEqual({
      url: 'http://192.168.1.20:47820/api/device-link/devices',
      authorization: 'CindyRelay relay-credential',
    });
    expect(JSON.stringify(mocks.netFetch.mock.calls)).not.toContain('account-access-token');
    expect(mocks.refresh).not.toHaveBeenCalled();
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });

  // #7722 discussion_r4402946273:刷新期间切到自建中转后，官方重试只能跟随官方区域，
  // 不能把刷新后的账号 token 交给自建服务器。最小输入:官方 401 → 切中转/区域 → refresh 成功。
  it('keeps an official retry on official endpoints when the selected relay changes during refresh', async () => {
    mocks.netFetch
      .mockResolvedValueOnce(new Response(JSON.stringify({ error: { code: 'TOKEN_EXPIRED' } }), { status: 401 }))
      .mockResolvedValueOnce(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
    mocks.refresh.mockImplementationOnce(async () => {
      mocks.relay = {
        baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'member',
        relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43),
      };
      mocks.officialBase = 'https://device-link.new-region.invalid';
      return true;
    });

    await expect(deviceLinkApiFetch('/api/device-link/devices')).resolves.toEqual({ devices: [] });

    expect(mocks.netFetch.mock.calls.map(([url, init]) => ({
      url, authorization: (init as { headers: Record<string, string> }).headers.Authorization,
    }))).toEqual([
      { url: 'https://device-link.official.invalid/api/device-link/devices', authorization: 'Bearer account-access-token' },
      { url: 'https://device-link.new-region.invalid/api/device-link/devices', authorization: 'Bearer account-access-token' },
    ]);
    expect(mocks.refresh).toHaveBeenCalledTimes(1);
    expect(mocks.invalidateSession).not.toHaveBeenCalled();
  });

  it('keeps the official relay on the account token', async () => {
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ devices: [] }), { status: 200 }));

    await expect(deviceLinkApiFetch('/api/device-link/devices')).resolves.toEqual({ devices: [] });

    expect(lastRequest()).toEqual({
      url: 'https://device-link.official.invalid/api/device-link/devices',
      authorization: 'Bearer account-access-token',
    });
  });

  // Regression from the 2026-11-09 strict-V2 native run: schedule reads called a
  // working Mac offline because the adapter queried only its disconnected V1
  // presence. Unit tier, real API entry; existing routing tests had no active V2
  // directory. A V2-online/V1-offline row is the minimal failing input.
  const v2Peer = (deviceId: string, online = true, enabled = true) => ({
    certificate: { deviceId }, name: deviceId, platform: 'darwin', online,
    remoteControlEnabled: enabled,
  });
  const legacyPeer = (deviceId: string, online = false) => ({
    deviceId, name: deviceId, platform: 'darwin', online, remoteControlEnabled: online, isSelf: false,
  });

  it.each(['official', 'private'])('merges %s V2 presence with V1-only peers and preserves explicit control-off', async route => {
    mocks.v2Active = true;
    if (route === 'private') mocks.relay = {
      baseUrl: 'http://192.168.1.20:47820', credential: 'relay-credential', role: 'member',
      relayId: 'r', name: 'Home', deviceId: 'pc', signingSeed: 'A'.repeat(43), ownerPublicKey: 'A'.repeat(43),
    };
    mocks.v2Directory.mockResolvedValue([v2Peer('v2'), v2Peer('off', true, false), v2Peer('legacy', false)]);
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ devices: [
      legacyPeer('v2'), legacyPeer('off', true), legacyPeer('legacy', true), legacyPeer('neighbour'),
    ] }), { status: 200 }));
    const result = await deviceLinkApiFetch<{ devices: Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean }> }>('/api/device-link/devices');
    expect(result.devices.map(({ deviceId, online, remoteControlEnabled }) => ({ deviceId, online, remoteControlEnabled }))).toEqual([
      { deviceId: 'v2', online: true, remoteControlEnabled: true },
      { deviceId: 'off', online: true, remoteControlEnabled: false },
      { deviceId: 'legacy', online: true, remoteControlEnabled: true },
      { deviceId: 'neighbour', online: false, remoteControlEnabled: false },
    ]);
    expect(lastRequest().authorization).toBe(route === 'private' ? 'CindyRelay relay-credential' : 'Bearer account-access-token');
    if (route === 'private') expect(mocks.getAccessToken).not.toHaveBeenCalled();
  });

  it('reads encrypted-only presence without depending on a legacy directory', async () => {
    mocks.v2Active = true; mocks.onlyEncrypted = true;
    mocks.v2Directory.mockResolvedValue([v2Peer('v2'), v2Peer('off', false, false)]);
    await expect(deviceLinkApiFetch('/api/device-link/devices')).resolves.toMatchObject({ devices: [
      { deviceId: 'v2', online: true }, { deviceId: 'off', online: false, remoteControlEnabled: false },
    ] });
    expect(mocks.netFetch).not.toHaveBeenCalled();
    mocks.v2Active = false;
    await expect(deviceLinkApiFetch('/api/device-link/devices')).rejects.toThrow('AGENT_NET_ENCRYPTED_IDENTITY_REQUIRED');
    expect(mocks.netFetch).not.toHaveBeenCalled();
  });

  it.each(['owner', 'route', 'selection'])('discards an in-flight V2 directory after %s changes', async change => {
    mocks.v2Active = true;
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ devices: [] }), { status: 200 }));
    mocks.v2Directory.mockImplementation(async () => {
      if (change === 'owner') mocks.scope = 'owner-b';
      if (change === 'selection') mocks.selection = 'route-b';
      if (change === 'route') mocks.relay = { relayId: 'other' } as NonNullable<typeof mocks.relay>;
      return [v2Peer('old-owner-only')];
    });
    await expect(deviceLinkApiFetch('/api/device-link/devices')).rejects.toThrow('DEVICE_LINK_SCOPE_CHANGED');
  });

  it('keeps V2 discovery working through a transient V1 failure but does not mask a denial', async () => {
    mocks.v2Active = true;
    mocks.v2Directory.mockResolvedValue([v2Peer('v2')]);
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'SERVICE_UNAVAILABLE' } }), { status: 503 }));
    await expect(deviceLinkApiFetch('/api/device-link/devices')).resolves.toMatchObject({ devices: [{ deviceId: 'v2', online: true }] });
    mocks.netFetch.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'FORBIDDEN' } }), { status: 403 }));
    await expect(deviceLinkApiFetch('/api/device-link/devices')).rejects.toMatchObject({ statusCode: 403 });
  });

  it('retains legacy discovery during a transient V2 outage but never ignores an untrusted directory', async () => {
    mocks.v2Active = true;
    mocks.netFetch.mockImplementation(async () => new Response(JSON.stringify({ devices: [legacyPeer('legacy', true)] }), { status: 200 }));
    mocks.v2Directory.mockRejectedValue(Object.assign(new Error('unavailable'), { status: 503 }));
    await expect(deviceLinkApiFetch('/api/device-link/devices')).resolves.toMatchObject({ devices: [{ deviceId: 'legacy', online: true }] });
    mocks.v2Directory.mockRejectedValue(new Error('UNTRUSTED_DIRECTORY'));
    await expect(deviceLinkApiFetch('/api/device-link/devices')).rejects.toThrow('UNTRUSTED_DIRECTORY');
  });
});
