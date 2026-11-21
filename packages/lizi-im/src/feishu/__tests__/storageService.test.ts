import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const values = new Map<string, string>();
let failNextKey: string | null = null;

const secrets = {
  isAvailable: () => true,
  read: (key: string) => values.get(key) ?? null,
  readResult: (key: string): import('../../types.js').IMSecretReadResult => values.has(key) ? {kind:'value',value:values.get(key)!} : {kind:'missing'},
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

vi.doMock('../moduleScope.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../moduleScope.js')>()),
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

// #11767 P1, unit: actual clearAll must distinguish retained/error/missing;
// previous coverage checked only credential writes, never failed revocation.
it.each(['retained', 'error', 'unavailable', 'throw'] as const)('rejects unconfirmed revocation (%s)', mode => {
  values.set('feishu_bot_app_id', 'invalid-test-app');
  values.set('feishu_bot_app_secret', 'invalid-test-secret');
  const remove = vi.spyOn(secrets, 'remove').mockImplementation(key => {
    if (key === 'feishu_bot_app_id') { if (mode === 'throw') throw new Error('busy'); return; }
    values.delete(key);
  });
  const read = vi.spyOn(secrets, 'readResult');
  if (mode === 'error') read.mockReturnValue({kind:'error'});
  if (mode === 'unavailable') (secrets as Partial<typeof secrets>).readResult = undefined;
  try {
    expect(() => storage.clearAll()).toThrow('FEISHU_CREDENTIAL_CLEAR_FAILED');
    expect(values.has('feishu_bot_app_secret')).toBe(false);
  } finally { remove.mockRestore(); read.mockRestore(); }
  storage.clearAll();
  expect(storage.readCredentials()).toBeNull();
});
