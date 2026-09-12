import { describe, expect, it, vi } from 'vitest';
import { CodexExternalAuthSession, assertCodexEphemeralAuth, useCodexHistoryHome } from './external-auth.js';

const initial = { accessToken: 'test-token-old', chatgptAccountId: 'account-b' };

describe('external account authentication', () => {
  it('removes inherited native identities while preserving the selected gateway credentials', () => {
    const env = { CODEX_HOME: '/account-b', CODEX_ACCESS_TOKEN: 'old', CODEX_API_KEY: 'old',
      OPENAI_API_KEY: 'old', OPENAI_FEDERATION_RULE_ID: '', OPENAI_IDENTITY_TOKEN_FILE: '/old',
      OPENAI_WORKLOAD_IDENTITY_CONTEXT: 'old', XDT_CODEX_API_KEY: 'selected-gateway', PATH: '/bin' };
    expect(useCodexHistoryHome(env, '/history-a')).toEqual({
      CODEX_HOME: '/history-a', XDT_CODEX_API_KEY: 'selected-gateway', PATH: '/bin',
    });
    expect(env.CODEX_HOME).toBe('/account-b');
  });

  it('refreshes the pinned account and reauthenticates each new client', async () => {
    const readTokens = vi.fn().mockResolvedValueOnce(initial)
      .mockResolvedValue({ ...initial, accessToken: 'test-token-new' });
    const session = new CodexExternalAuthSession({ readTokens });
    const request = vi.fn(async (method: string) => method === 'config/read'
      ? { config: { cli_auth_credentials_store: 'ephemeral' } } : { type: 'chatgptAuthTokens' });
    await session.authenticate(request);
    expect(request).toHaveBeenCalledWith('account/login/start', { type: 'chatgptAuthTokens', ...initial });
    await expect(session.tokens(true, 'account-b')).resolves.toMatchObject({ accessToken: 'test-token-new' });
    expect(readTokens).toHaveBeenLastCalledWith(true, 'test-token-old');
    await session.authenticate(request);
    expect(request).toHaveBeenLastCalledWith('account/login/start', {
      type: 'chatgptAuthTokens', ...initial, accessToken: 'test-token-new',
    });
  });

  it('does not treat a successful account read with the same rejected token as a refresh', async () => {
    const session = new CodexExternalAuthSession({ readTokens: async () => initial });
    await session.tokens(false);
    await expect(session.tokens(true, 'account-b')).rejects.toThrow('authentication is unavailable');
  });

  it('rejects foreign refreshes before reading credentials and rejects account changes on reconnect', async () => {
    const readTokens = vi.fn().mockResolvedValue(initial);
    const session = new CodexExternalAuthSession({ readTokens });
    await session.tokens(false);
    await expect(session.tokens(true, 'account-a')).rejects.toThrow('authentication is unavailable');
    expect(readTokens).toHaveBeenCalledTimes(1);
    readTokens.mockResolvedValue({ ...initial, chatgptAccountId: 'account-c' });
    await expect(session.tokens(false)).rejects.toThrow('authentication is unavailable');
  });

  it('redacts source and RPC errors, including echoed credentials', async () => {
    const source = new CodexExternalAuthSession({ readTokens: async () => { throw new Error('secret-token'); } });
    await expect(source.tokens(false)).rejects.toThrow('Codex account authentication is unavailable or has changed');
    const session = new CodexExternalAuthSession({ readTokens: async () => initial });
    await expect(session.authenticate(async () => { throw new Error('secret-token'); }))
      .rejects.toThrow('Codex could not initialize isolated account authentication');
    await expect(session.authenticate(async () => ({ type: 'apiKey' })))
      .rejects.toThrow('Codex could not initialize isolated account authentication');
  });
  it('refuses effective persistent credential policy before sending external tokens', async () => {
    const request = vi.fn().mockResolvedValue({ config: { cli_auth_credentials_store: 'file' } });
    await expect(assertCodexEphemeralAuth(request)).rejects.toThrow('isolated account authentication');
    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith('config/read', { includeLayers: false });
  });
  it('bounds credential reads and ignores results arriving after timeout', async () => {
    vi.useFakeTimers();
    try {
      let resolve!: (value: typeof initial) => void;
      const session = new CodexExternalAuthSession({ readTokens: () => new Promise(done => { resolve = done; }) });
      const pending = session.tokens(false);
      const rejected = expect(pending).rejects.toThrow('authentication is unavailable');
      await vi.advanceTimersByTimeAsync(10_000);
      await rejected;
      resolve(initial);
      await expect(session.tokens(true, initial.chatgptAccountId)).rejects.toThrow('authentication is unavailable');
    } finally {
      vi.useRealTimers();
    }
  });
});
