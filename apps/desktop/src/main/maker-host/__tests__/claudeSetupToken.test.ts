/**
 * 测试价值(2026-11-24 Claude 长期令牌,docs/dev-rules/credentials-and-local-storage.md)
 * - 生产入口与可观察结果:runClaudeSetupToken(代跑官方 `claude setup-token`)交回的令牌与失败原因;
 *   saveClaudeLongLivedToken / removeClaudeLongLivedToken 落在账号目录里的文件。
 * - Bug／规则依据:2026-11-24 实测,官方命令的界面增量刷新,去掉控制序列直接读会漏字,读出的令牌
 *   少两位、被服务端以 401 拒绝;令牌文件只能本人可读,Windows 上要并入用户设置且不得破坏原有设置。
 * - 现有覆盖缺口:此前没有任何代码读取终端屏幕或写这份令牌。
 * - 最小失败输入:先画一行、再用「光标右移」跳过未变字符重画的同一行。
 * - tier:unit(内存里的假终端、临时目录,不拉起 CLI)。
 */
import { EventEmitter } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp/cindy-test-user-data' } }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../cli-proxy-bridge.js', () => ({ ensureCliProxyBridge: vi.fn() }));
vi.mock('@cindy/maker-core', () => ({ cleanProcessEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('node:child_process', () => ({ spawn: h.spawn, execFile: vi.fn() }));

import type { ClaudeCliLoginStatus } from '@cindy/maker-core/claude-cli-login-status';
import { removeClaudeLongLivedToken, saveClaudeLongLivedToken } from '../claude-long-lived-token.js';
import { createClaudeNativeCli } from '../claude-native-cli.js';
import { runClaudeSetupToken, type SetupTokenTerminal } from '../claude-setup-token.js';
import { TerminalScreen } from '../terminal-screen.js';

// Obviously not a credential: the shape the official command prints, filled with one letter.
const TOKEN = `sk-ant-oat01-${'A'.repeat(95)}`;
const ESC = '\x1b';

function fakeTerminal() {
  let data: (chunk: string) => void = () => {};
  let exit: (event: { exitCode: number }) => void = () => {};
  const terminal: SetupTokenTerminal & { kill: ReturnType<typeof vi.fn> } = {
    onData: (listener) => { data = listener; },
    onExit: (listener) => { exit = listener; },
    kill: vi.fn(),
  };
  return { terminal, emit: (chunk: string) => data(chunk), exit: (exitCode = 0) => exit({ exitCode }) };
}

function start(signal = new AbortController().signal) {
  const fake = fakeTerminal();
  const spawn = vi.fn(() => fake.terminal);
  const result = runClaudeSetupToken({
    binary: '/test/claude', env: { PATH: '/usr/bin', CLAUDE_CONFIG_DIR: '/test/profile' }, cwd: '/test',
    signal, timeoutMs: 60_000, spawn,
  });
  return { ...fake, spawn, result };
}

/** The success screen as the CLI draws it: status lines first, then the token line redrawn in place. */
function successScreen(token: string): string[] {
  return [
    ' Browser didn\'t open? Use the url below to sign in\r\n',
    ' Paste code here if prompted >\r\n',
    `${ESC}[2A${ESC}[2K ${ESC}[32m✓ Long-lived authentication token created successfully!${ESC}[0m\r\n`,
    `${ESC}[2K Your OAuth token (valid for 1 year):\r\n`,
    ` ${token.slice(0, 40)}`,
    `${token.slice(40)}\r\n`,
    ' Store this token securely. You won\'t be able to see it again.\r\n',
  ];
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('reading the terminal screen', () => {
  it('keeps characters an incremental redraw skips with a cursor move', () => {
    const screen = new TerminalScreen(80, 4);
    // First frame, then the same row redrawn: only changed cells are written, unchanged ones are
    // stepped over with "cursor forward". Stripping the sequences would read "sk-ant-at01".
    screen.write('xx-xxx-oxxxx\r');
    screen.write(`sk${ESC}[1Cant${ESC}[2Cat01`);
    expect(screen.lines()[0]).toBe('sk-ant-oat01');
    // A sequence cut in half by a chunk boundary is completed by the next chunk.
    screen.write(`\r\n${ESC}[`);
    screen.write('3Cdone');
    expect(screen.lines()[1]).toBe('   done');
  });
});

describe('creating a long-lived token through the official command', () => {
  it('returns the token only once the finished screen has settled', async () => {
    const run = start();
    expect(run.spawn).toHaveBeenCalledExactlyOnceWith('/test/claude', ['setup-token'], expect.objectContaining({
      env: expect.objectContaining({ CLAUDE_CONFIG_DIR: '/test/profile', TERM: 'xterm-256color' }),
    }));
    const chunks = successScreen(TOKEN);
    let settled = false;
    void run.result.then(() => { settled = true; });
    // Everything up to half of the token: the line already looks like a token prefix.
    for (const chunk of chunks.slice(0, 5)) run.emit(chunk);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(settled).toBe(false);
    for (const chunk of chunks.slice(5)) run.emit(chunk);
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(run.result).resolves.toEqual({ ok: true, token: TOKEN });
    expect(run.terminal.kill).toHaveBeenCalled();
  });

  it.each([
    ['the user cancels', (run: ReturnType<typeof start>, abort: AbortController) => abort.abort(), 'login_cancelled'],
    ['the command exits without a token', (run: ReturnType<typeof start>) => run.exit(1), 'login_failed'],
    ['an organization policy forbids subscription tokens', (run: ReturnType<typeof start>) => {
      run.emit('setup-token creates a long-lived Claude.ai subscription token, which this policy does not permit.\r\n');
      run.exit(1);
    }, 'token_not_permitted'],
    ['nobody authorizes in time', async () => { await vi.advanceTimersByTimeAsync(60_000); }, 'timeout'],
  ] as const)('reports why no token was created when %s', async (_name, act, reason) => {
    const abort = new AbortController();
    const run = start(abort.signal);
    await act(run, abort);
    await expect(run.result).resolves.toEqual({ ok: false, reason });
    expect(run.terminal.kill).toHaveBeenCalled();
  });
});

describe('keeping the token in the account directory', () => {
  let directory: string;
  beforeEach(() => {
    vi.useRealTimers();
    directory = mkdtempSync(path.join(tmpdir(), 'cindy-long-lived-token-'));
  });
  afterEach(() => { rmSync(directory, { recursive: true, force: true }); });

  it('writes a file only its owner can read, and removes it again', async () => {
    const profile = path.join(directory, 'profile');
    await saveClaudeLongLivedToken(profile, TOKEN, 'darwin');
    const file = path.join(profile, 'cindy-long-lived-token');
    expect(readFileSync(file, 'utf8')).toBe(`${TOKEN}\n`);
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600);
    await expect(removeClaudeLongLivedToken(profile, 'darwin')).resolves.toBe(true);
    expect(() => statSync(file)).toThrow();
    await expect(removeClaudeLongLivedToken(profile, 'darwin')).resolves.toBe(false);
  });

  it('adds the token to the Windows user settings without touching the rest, and takes only it back out', async () => {
    const settings = path.join(directory, 'settings.json');
    writeFileSync(settings, JSON.stringify({ env: { HTTPS_PROXY: 'http://proxy.test:8080' }, theme: 'dark' }));
    await saveClaudeLongLivedToken(directory, TOKEN, 'win32');
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({
      env: { HTTPS_PROXY: 'http://proxy.test:8080', CLAUDE_CODE_OAUTH_TOKEN: TOKEN }, theme: 'dark',
    });
    await expect(removeClaudeLongLivedToken(directory, 'win32')).resolves.toBe(true);
    expect(JSON.parse(readFileSync(settings, 'utf8'))).toEqual({ env: { HTTPS_PROXY: 'http://proxy.test:8080' }, theme: 'dark' });
  });

  it('leaves a settings file it cannot understand exactly as it is', async () => {
    const settings = path.join(directory, 'settings.json');
    writeFileSync(settings, '{ not json');
    await expect(saveClaudeLongLivedToken(directory, TOKEN, 'win32')).rejects.toThrow();
    expect(readFileSync(settings, 'utf8')).toBe('{ not json');
  });
});

describe('moving an account onto a long-lived token', () => {
  const posix = process.platform !== 'win32';
  const signedIn: ClaudeCliLoginStatus = { loggedIn: true, authMethod: 'claude.ai', email: 'user@example.com', subscriptionType: 'max' };
  const onToken = (storedLogin: boolean): ClaudeCliLoginStatus => ({
    loggedIn: true, authMethod: 'oauth_token', longLivedToken: posix ? 'descriptor' : 'settings', storedLogin,
    ...(storedLogin ? { email: 'user@example.com', subscriptionType: 'max' } : {}),
  });
  let profile: string;
  let readStatus: ReturnType<typeof vi.fn<(options: { env: NodeJS.ProcessEnv; oauthTokenFile?: string }) => Promise<ClaudeCliLoginStatus | null>>>;
  let terminal: ReturnType<typeof fakeTerminal>;
  let spawnTerminal: ReturnType<typeof vi.fn>;
  const cli = () => createClaudeNativeCli({
    binaryPath: () => '/test/claude', resolveOutboundProxy: () => null, readStatus, spawnTerminal: spawnTerminal as never,
  });
  const tokenStored = () => posix
    ? existsSync(path.join(profile, 'cindy-long-lived-token'))
    : existsSync(path.join(profile, 'settings.json')) && readFileSync(path.join(profile, 'settings.json'), 'utf8').includes(TOKEN);
  /** Authorize in the "browser": the command shows its success screen. */
  const authorize = async () => {
    await vi.waitFor(() => expect(spawnTerminal).toHaveBeenCalled());
    for (const chunk of successScreen(TOKEN)) terminal.emit(chunk);
    await vi.advanceTimersByTimeAsync(2_000);
  };

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    profile = mkdtempSync(path.join(tmpdir(), 'cindy-token-account-'));
    readStatus = vi.fn();
    terminal = fakeTerminal();
    spawnTerminal = vi.fn(() => terminal.terminal);
    h.spawn.mockReset();
  });
  afterEach(() => { rmSync(profile, { recursive: true, force: true }); });

  it('keeps the token in the account directory and reads the account with it from then on', async () => {
    readStatus.mockResolvedValueOnce(signedIn).mockResolvedValue(onToken(true));
    const { runClaudeCliLongLivedToken } = cli();
    const result = runClaudeCliLongLivedToken(new AbortController().signal, profile);
    await authorize();
    await expect(result).resolves.toEqual({ ok: true, status: onToken(true) });
    expect(spawnTerminal).toHaveBeenCalledExactlyOnceWith('/test/claude', ['setup-token'],
      expect.objectContaining({ env: expect.objectContaining({ CLAUDE_CONFIG_DIR: profile }) }));
    expect(tokenStored()).toBe(true);
    // Before: the ordinary login alone. After: the token file goes along with the status read.
    expect(readStatus.mock.calls[0][0].oauthTokenFile).toBeUndefined();
    expect(readStatus.mock.calls[1][0].oauthTokenFile)
      .toBe(posix ? path.join(profile, 'cindy-long-lived-token') : undefined);
    // The token never rides in the environment of any CLI process this module starts.
    expect(JSON.stringify(readStatus.mock.calls.map(call => call[0].env))).not.toContain(TOKEN);
  });

  it('leaves the account as it was when the CLI does not pick the token up', async () => {
    readStatus.mockResolvedValue(signedIn);
    const { runClaudeCliLongLivedToken } = cli();
    const result = runClaudeCliLongLivedToken(new AbortController().signal, profile);
    await authorize();
    await expect(result).resolves.toEqual({ ok: false, reason: 'login_failed' });
    expect(tokenStored()).toBe(false);
  });

  it.each([
    ['signed out', (): ClaudeCliLoginStatus => ({ loggedIn: false })],
    ['on a token whose ordinary sign-in has ended', () => onToken(false)],
  ])('asks for the ordinary sign-in first when the account is %s: a token cannot say whose it is', async (_name, status) => {
    readStatus.mockResolvedValue(status());
    await expect(cli().runClaudeCliLongLivedToken(new AbortController().signal, profile))
      .resolves.toEqual({ ok: false, reason: 'not_signed_in' });
    expect(spawnTerminal).not.toHaveBeenCalled();
  });

  it('reads plan usage through the ordinary login, and not at all once that login has ended', async () => {
    // A token in user settings would answer the usage read itself (and has no profile scope),
    // so the read leaves user settings out; with the ordinary login gone there is nothing to ask.
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stdin: { write: vi.fn(), end: vi.fn(), on: vi.fn() }, kill: vi.fn(),
    });
    h.spawn.mockReturnValue(child);
    readStatus.mockResolvedValue({ ...onToken(true), longLivedToken: 'settings' });
    const native = cli();
    await native.refreshClaudeCliLoginStatus({ configDir: profile, force: true });
    const usage = native.readClaudeCliPlanUsage(profile);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalled());
    const args = h.spawn.mock.calls[0][1] as string[];
    expect(args.slice(args.indexOf('--setting-sources'), args.indexOf('--setting-sources') + 2)).toEqual(['--setting-sources', '']);
    child.stdout.emit('data', Buffer.from(`${JSON.stringify({ type: 'control_response', response: {
      request_id: 'cindy-plan-usage', subtype: 'success', response: { rate_limits_available: true, rate_limits: { five_hour: null } },
    } })}\n`));
    await expect(usage).resolves.toEqual({ rateLimits: { five_hour: null } });

    h.spawn.mockClear();
    readStatus.mockResolvedValue({ ...onToken(false), longLivedToken: 'settings' });
    await native.refreshClaudeCliLoginStatus({ configDir: profile, force: true });
    await expect(native.readClaudeCliPlanUsage(profile)).rejects.toThrow('stored login unavailable');
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
