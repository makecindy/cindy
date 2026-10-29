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
}));

vi.mock('electron', () => ({ net: { fetch: mocks.netFetch } }));
vi.mock('../../authManager', () => ({
  getAccessToken: mocks.getAccessToken,
  refresh: mocks.refresh,
  invalidateSession: mocks.invalidateSession,
}));
vi.mock('../../i18n.js', () => ({ getResolvedMainLocale: () => 'zh-CN' }));
vi.mock('../../logger', () => ({ createLogger: () => ({ error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('../../clientEndpointsService.js', () => ({
  getClientEndpoint: () => mocks.officialBase,
}));
vi.mock('../index.js', () => ({ deviceLinkApiBase: () => 'http://192.168.1.20:47820', remoteBackgroundInvoke: vi.fn() }));
vi.mock('../providerShareGuest.js', () => ({ getReceivedShares: () => [] }));
vi.mock('../settings-store.js', () => ({ readDeviceLinkSettings: () => ({ disabledControlDeviceIds: [], lastKnownDeviceNames: {} }) }));
vi.mock('../../remote-agent/controller/deviceCatalog.js', () => ({ readDeviceProviderViews: vi.fn(async () => []) }));

import { deviceLinkApiFetch } from '../deviceLinkApi';
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
});
