import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
let failNextKey: string | null = null;

const secrets = {
  isAvailable: () => true,
  read: (key: string) => values.get(key) ?? null,
  write: (key: string, value: string) => {
    if (failNextKey === key) {
      failNextKey = null;
      return false;
    }
    values.set(key, value);
    return true;
  },
  remove: (key: string) => {
    values.delete(key);
  },
};

vi.doMock('../moduleScope.js', () => ({
  getHost: () => ({ secrets }),
  getLog: () => ({
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  }),
}));

let storage: typeof import('../storage.js');

beforeAll(async () => {
  storage = await import('../storage.js');
});

beforeEach(() => {
  values.clear();
  failNextKey = null;
});

describe('IM service credential storage', () => {
  it('defaults legacy credentials without a service key to Feishu', () => {
    values.set('feishu_bot_app_id', 'cli_legacy');
    values.set('feishu_bot_app_secret', 'legacy-secret');

    expect(storage.readCredentials()).toEqual({
      appId: 'cli_legacy',
      appSecret: 'legacy-secret',
      service: 'feishu',
    });
  });

  it('persists Lark as part of the credential set', () => {
    expect(
      storage.writeCredentials({
        appId: 'cli_lark',
        appSecret: 'lark-secret',
        service: 'lark',
      }),
    ).toBe(true);

    expect(storage.readCredentials()).toEqual({
      appId: 'cli_lark',
      appSecret: 'lark-secret',
      service: 'lark',
    });
  });

  it('restores the previous credential set when a write fails', () => {
    values.set('feishu_bot_app_id', 'cli_previous');
    values.set('feishu_bot_app_secret', 'previous-secret');
    values.set('feishu_bot_service', 'feishu');
    failNextKey = 'feishu_bot_app_secret';

    expect(
      storage.writeCredentials({
        appId: 'cli_replacement',
        appSecret: 'replacement-secret',
        service: 'lark',
      }),
    ).toBe(false);
    expect(storage.readCredentials()).toEqual({
      appId: 'cli_previous',
      appSecret: 'previous-secret',
      service: 'feishu',
    });
  });
});
