import { execFile } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { parseClaudeCliLoginStatus, readClaudeCliLoginStatusBySpawn } from '../cli-login-status.js';

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
