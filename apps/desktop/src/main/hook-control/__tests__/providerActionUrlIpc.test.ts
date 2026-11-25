// Unit: the actual remote action handler rejected official Feishu/Lark URLs as X links.
// Existing provider parser tests never exercised dispatch. A valid Feishu connect URL is
// the minimal regression; cross-provider URLs and unavailable actions remain rejected.
import { describe, expect, it, vi } from 'vitest';
import { providerActionUrlFromIpc } from '../providerActionUrlIpc.js';

const query = 'client_id=cli_fixture&redirect_uri=https%3A%2F%2Fhook.example.invalid%2Fcallback&state=fixture';
describe('remote official provider links', () => {
  it.each([
    ['feishu', 'connect', `https://accounts.feishu.cn/open-apis/authen/v1/authorize?${query}`],
    ['feishu', 'connect', `https://accounts.larksuite.com/open-apis/authen/v1/authorize?${query}`],
    ['feishu', 'provider', 'https://applink.feishu.cn/client/bot/open?appId=cli_fixture'],
    ['feishu', 'provider', 'https://applink.larksuite.com/client/bot/open?appId=cli_fixture'],
    ['telegram', 'provider', 'https://t.me/cindy_bot'],
    ['x', 'provider', 'https://x.com/cindy_bot'],
  ] as const)('returns the validated %s %s link', (provider, action, url) => {
    const manager = { providerActionUrl: vi.fn(() => url) };
    expect(providerActionUrlFromIpc(manager, provider, action)).toEqual({ url });
    expect(manager.providerActionUrl).toHaveBeenCalledWith(provider, action);
  });

  it.each([
    ['feishu', 'https://x.com/cindy_bot'],
    ['x', 'https://applink.feishu.cn/client/bot/open?appId=cli_fixture'],
    ['telegram', 'https://applink.larksuite.com/client/bot/open?appId=cli_fixture'],
    ['feishu', 'https://accounts.feishu.cn.evil.invalid/authorize'],
    ['feishu', null],
  ] as const)('refuses an unavailable or wrong-provider link for %s', (provider, url) => {
    expect(() => providerActionUrlFromIpc({ providerActionUrl: () => url }, provider, 'connect'))
      .toThrow('[INVALID_PARAMS]');
  });

  it('rejects invalid actions before reading a link', () => {
    const manager = { providerActionUrl: vi.fn() };
    expect(() => providerActionUrlFromIpc(manager, 'feishu', 'arbitrary')).toThrow('[INVALID_PARAMS]');
    expect(manager.providerActionUrl).not.toHaveBeenCalled();
  });
});
