import { execFile } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { claudeLongLivedTokenFileVersion, parseClaudeCliLoginStatus, readClaudeCliLoginStatusBySpawn } from '../cli-login-status.js';

vi.mock('node:child_process', () => ({ execFile: vi.fn() }));

const subscription = {
  loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty',
  subscriptionType: 'pro', planTier: 'pro',
  email: 'user@example.com', orgName: 'Example organization', orgId: 'example-org',
};
const json = JSON.stringify(subscription);
const text = 'Login method: Claude Ultra account\nOrganization: Example organization\nEmail: user@example.com\n';
const options = { binary: '/test/claude', env: { CLAUDE_CONFIG_DIR: '/test/profile' }, timeoutMs: 10_000 };

function reply(stdout: string, error: Error | null = null): void {
  vi.mocked(execFile).mockImplementationOnce(((_binary: unknown, _args: unknown, _options: unknown, callback: (error: Error | null, stdout: string) => void) => {
    callback(error, stdout);
  }) as typeof execFile);
}

beforeEach(() => { vi.mocked(execFile).mockReset(); });
afterEach(() => { vi.restoreAllMocks(); });

describe('official CLI subscription display name', () => {
  // Unit: CLI 2.1.321 reports Ultra as pro in JSON and only names it in text.
  // Existing auth/parser coverage never exercises that two-format disagreement.
  it('uses matching official text without changing classification or profile context', async () => {
    reply(json);
    reply(text);
    const status = await readClaudeCliLoginStatusBySpawn(options);
    expect(status).toEqual({
      loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'pro', planTier: 'pro',
      email: 'user@example.com', planDisplayName: 'Ultra',
    });
    expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
      ['auth', 'status', '--json'], ['auth', 'status', '--text'],
    ]);
    for (const call of vi.mocked(execFile).mock.calls) {
      expect(call[0]).toBe(options.binary);
      expect(call[2]).toMatchObject({ env: options.env, windowsHide: true });
    }
  });

  it('prefers a future JSON display name and does not make a second request', async () => {
    reply(JSON.stringify({ ...subscription, planDisplayName: ' Ultra ' }));
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toMatchObject({
      planDisplayName: 'Ultra', subscriptionType: 'pro', planTier: 'pro',
    });
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each([
    text.replace('user@example.com', 'other@example.com'),
    text.replace('Example organization', 'Other organization'),
    text.replace('Email: user@example.com\n', ''),
    `${text}Email: user@example.com\n`,
    text.replace('Claude Ultra account', 'API key'),
  ])('ignores text that cannot identify the same subscription', output => {
    expect(parseClaudeCliLoginStatus(json, output)).toEqual(parseClaudeCliLoginStatus(json));
  });

  it.each([
    JSON.stringify({ loggedIn: false, authMethod: 'none' }),
    JSON.stringify({ ...subscription, authMethod: 'api_key' }),
    JSON.stringify({ ...subscription, email: null }),
    JSON.stringify({ ...subscription, orgName: null, orgId: null }),
    'not JSON',
  ])('does not query text without an authenticated, matchable JSON identity', async output => {
    reply(output);
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toEqual(parseClaudeCliLoginStatus(output));
    expect(execFile).toHaveBeenCalledTimes(1);
  });

  it.each(['', text])('keeps the JSON status when the optional text command fails or times out', async output => {
    reply(json);
    reply(output, Object.assign(new Error('timeout'), { killed: true }));
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toEqual(parseClaudeCliLoginStatus(json));
  });

  it('shares the original timeout budget and skips text after it is exhausted', async () => {
    const now = vi.spyOn(Date, 'now');
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(9_000);
    reply(json);
    reply(text);
    await readClaudeCliLoginStatusBySpawn(options);
    expect(vi.mocked(execFile).mock.calls[1][2]).toMatchObject({ timeout: 2_000 });

    vi.mocked(execFile).mockClear();
    now.mockReturnValueOnce(1_000).mockReturnValueOnce(11_000);
    reply(json);
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toEqual(parseClaudeCliLoginStatus(json));
    expect(execFile).toHaveBeenCalledTimes(1);
  });
});

// Unit, 2026-11-24 long-lived Claude token. The official JSON status reports every bearer token as
// `oauth_token` (measured on CLI 2.1.321: a relay token and a `claude setup-token` token are
// identical there); only the text status names the source. Until now every `oauth_token` login was
// refused as "not a subscription". Minimal failing input: the two payloads below.
describe('long-lived subscription token', () => {
  const tokenJson = JSON.stringify({ loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty', loginExpiresAt: null });

  it.each([
    ['Auth token: CLAUDE_CODE_OAUTH_TOKEN_FILE_DESCRIPTOR\n', { loggedIn: true, authMethod: 'oauth_token', longLivedToken: 'descriptor' }],
    ['Auth token: CLAUDE_CODE_OAUTH_TOKEN\n', { loggedIn: true, authMethod: 'oauth_token', longLivedToken: 'settings' }],
    // A relay token must never be taken for a subscription.
    ['Auth token: ANTHROPIC_AUTH_TOKEN\n', { loggedIn: false, notSubscription: true }],
    ['Auth token: CLAUDE_CODE_OAUTH_TOKEN\nAuth token: ANTHROPIC_AUTH_TOKEN\n', { loggedIn: false, notSubscription: true }],
    [undefined, { loggedIn: false, notSubscription: true }],
  ])('classifies a token login by the source the text status names: %j', (textStatus, expected) => {
    expect(parseClaudeCliLoginStatus(tokenJson, textStatus)).toEqual(expected);
  });

  it('describes the account through the ordinary login stored beside the token', async () => {
    reply(tokenJson);
    reply('Auth token: CLAUDE_CODE_OAUTH_TOKEN\n');
    reply(JSON.stringify({ ...subscription, planDisplayName: 'Ultra', loginExpiresAt: '2026-12-21T17:12:41.249Z' }));
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toEqual({
      loggedIn: true, authMethod: 'oauth_token', longLivedToken: 'settings', storedLogin: true,
      subscriptionType: 'pro', planTier: 'pro', planDisplayName: 'Ultra', email: 'user@example.com',
      loginExpiresAt: '2026-12-21T17:12:41.249Z',
    });
    // The third read leaves the user's settings out, so the CLI answers from the stored login.
    expect(vi.mocked(execFile).mock.calls.map(call => call[1])).toEqual([
      ['auth', 'status', '--json'], ['auth', 'status', '--text'], ['--setting-sources', '', 'auth', 'status', '--json'],
    ]);
  });

  it('keeps the token login when the ordinary login has ended', async () => {
    reply(tokenJson);
    reply('Auth token: CLAUDE_CODE_OAUTH_TOKEN\n');
    reply(JSON.stringify({ loggedIn: false, authMethod: 'none' }), new Error('exit 1'));
    await expect(readClaudeCliLoginStatusBySpawn(options)).resolves.toEqual({
      loggedIn: true, authMethod: 'oauth_token', longLivedToken: 'settings', storedLogin: false,
    });
  });

  it('reports a distinct secret-free token version when the token file is replaced', async () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'cindy-status-token-version-'));
    try {
      const settingsPath = path.join(dir, 'settings.json');
      writeFileSync(settingsPath, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-first' } }));
      const dirOptions = { ...options, env: { CLAUDE_CONFIG_DIR: dir } };
      reply(tokenJson);
      reply('Auth token: CLAUDE_CODE_OAUTH_TOKEN\n');
      reply(JSON.stringify({ loggedIn: false, authMethod: 'none' }), new Error('exit 1'));
      const first = await readClaudeCliLoginStatusBySpawn(dirOptions);
      expect(first?.longLivedTokenVersion).toMatch(/^settings:/);
      expect(first?.longLivedTokenVersion).not.toContain('sk-ant-');

      // Atomic replacement (temp + rename, like writePrivateFile) changes inode and version.
      const tmp = path.join(dir, 'settings.json.tmp');
      writeFileSync(tmp, JSON.stringify({ env: { CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-second' } }));
      renameSync(tmp, settingsPath);
      const secondVersion = claudeLongLivedTokenFileVersion('settings', dir);
      expect(secondVersion).toMatch(/^settings:/);
      expect(secondVersion).not.toBe(first?.longLivedTokenVersion);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
