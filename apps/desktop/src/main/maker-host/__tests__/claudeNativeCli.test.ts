/**
 * claude-native-cli —— 内置 Claude Code CLI 的登录态读取、登录拉起与代理 env。
 * CLI 子进程用假 child 代替;代理解析与 SOCKS 桥 mock 掉。
 */
import { EventEmitter } from 'node:events';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  binary: '/opt/cindy/claude' as string | null,
  envProxy: false,
  resolved: null as string | null,
  resolveError: null as Error | null,
  bridge: vi.fn(async () => 'http://127.0.0.1:5555'),
  spawn: vi.fn(),
}));

vi.mock('electron', () => ({ app: { isPackaged: true, getPath: () => '/tmp/cindy-test-user-data' } }));
vi.mock('@cindy/maker-core', () => ({ cleanProcessEnv: () => ({ PATH: '/usr/bin' }) }));
vi.mock('../../agent-binaries/index.js', () => ({ getReadyBinaryPath: () => h.binary }));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));
vi.mock('../outbound-proxy-resolver.js', () => ({
  resolveDesktopOutboundProxy: async () => {
    if (h.resolveError) throw h.resolveError;
    return h.resolved;
  },
}));
vi.mock('@cindy/anthropic-compat-proxy', async (original) => ({
  ...(await original<typeof import('@cindy/anthropic-compat-proxy')>()),
  hasProxyEnvConfig: () => h.envProxy,
}));
vi.mock('../claude-cli-proxy-bridge.js', () => ({ ensureClaudeCliProxyBridge: h.bridge }));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));

import {
  claudeCliNetworkEnv,
  parseClaudeCliLoginStatus,
  peekClaudeCliLoginStatus,
  readClaudeCliLoginStatus,
  refreshClaudeCliLoginStatus,
  resetClaudeNativeCliForTest,
  runClaudeCliLogin,
} from '../claude-native-cli.js';

type FakeChild = EventEmitter & { stdout: EventEmitter; stderr: EventEmitter; kill: ReturnType<typeof vi.fn> };

function fakeChild(result: { stdout?: string; code?: number; error?: Error } | 'hang'): FakeChild {
  const child = new EventEmitter() as FakeChild;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => {
    setImmediate(() => child.emit('close', null));
    return true;
  });
  if (result !== 'hang') {
    setImmediate(() => {
      if (result.error) {
        child.emit('error', result.error);
        return;
      }
      if (result.stdout) child.stdout.emit('data', Buffer.from(result.stdout));
      child.emit('close', result.code ?? 0);
    });
  }
  return child;
}

const SUBSCRIPTION = JSON.stringify({
  loggedIn: true,
  authMethod: 'claude.ai',
  apiProvider: 'firstParty',
  email: 'user@example.com',
  subscriptionType: 'max',
});
const API_KEY_LOGIN = JSON.stringify({ loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' });
const LOGGED_OUT = JSON.stringify({ loggedIn: false, authMethod: 'none', apiProvider: 'firstParty' });

function argsOf(call: unknown[]): string[] {
  return call[1] as string[];
}

beforeEach(() => {
  resetClaudeNativeCliForTest();
  h.binary = '/opt/cindy/claude';
  h.envProxy = false;
  h.resolved = null;
  h.resolveError = null;
  h.bridge.mockClear();
  h.bridge.mockImplementation(async () => 'http://127.0.0.1:5555');
  h.spawn.mockReset();
});

describe('parseClaudeCliLoginStatus', () => {
  it('只把 Claude.ai 订阅账号的 OAuth 登录当作 Claude 订阅', () => {
    expect(parseClaudeCliLoginStatus(SUBSCRIPTION)).toEqual({
      loggedIn: true,
      authMethod: 'claude.ai',
      subscriptionType: 'max',
      email: 'user@example.com',
    });
  });

  it.each([
    ['Console 账号(managed key)', { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: '/login managed key' }],
    ['API Key', { loggedIn: true, authMethod: 'api_key', apiProvider: 'firstParty' }],
    ['apiKeyHelper', { loggedIn: true, authMethod: 'api_key_helper', apiProvider: 'firstParty' }],
    ['中转 token(ANTHROPIC_AUTH_TOKEN)', { loggedIn: true, authMethod: 'oauth_token', apiProvider: 'firstParty' }],
    ['第三方云', { loggedIn: true, authMethod: 'third_party', apiProvider: 'bedrock' }],
    ['订阅登录但指向第三方云', { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'vertex' }],
  ])('%s → 已登录但不是订阅', (_label, payload) => {
    expect(parseClaudeCliLoginStatus(JSON.stringify(payload))).toEqual({ loggedIn: false, notSubscription: true });
  });

  it('未登录与异常输出', () => {
    expect(parseClaudeCliLoginStatus(LOGGED_OUT)).toEqual({ loggedIn: false });
    expect(parseClaudeCliLoginStatus('not json')).toBeNull();
    expect(parseClaudeCliLoginStatus('[]')).toBeNull();
    expect(parseClaudeCliLoginStatus('{"authMethod":"claude.ai"}')).toBeNull();
  });
});

describe('claudeCliNetworkEnv', () => {
  it('代理 env 已给出 HTTP 代理:不动,子进程直接继承', async () => {
    h.envProxy = true;
    h.resolved = 'http://127.0.0.1:7890';
    await expect(claudeCliNetworkEnv()).resolves.toEqual({});
    expect(h.bridge).not.toHaveBeenCalled();
  });

  it.each([
    ['HTTP', 'http://127.0.0.1:7890'],
    ['SOCKS5', 'socks5://127.0.0.1:7891'],
  ])('系统 %s 代理:HTTPS_PROXY 指向按目标解析出口的本机桥,不下发 HTTP_PROXY', async (_kind, proxy) => {
    h.resolved = proxy;
    await expect(claudeCliNetworkEnv()).resolves.toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:5555',
      https_proxy: 'http://127.0.0.1:5555',
      NO_PROXY: 'localhost,127.0.0.1,::1',
      no_proxy: 'localhost,127.0.0.1,::1',
    });
    // 桥拿到的是逐目标解析器,而不是「对 api.anthropic.com 解析出的那一个代理」。
    expect(h.bridge).toHaveBeenCalledWith(expect.any(Function));
  });

  it('代理 env 只有 SOCKS5(如 ALL_PROXY):经桥覆盖 HTTPS_PROXY,保留用户自己的 NO_PROXY', async () => {
    h.envProxy = true;
    h.resolved = 'socks5://127.0.0.1:1080';
    await expect(claudeCliNetworkEnv()).resolves.toEqual({
      HTTPS_PROXY: 'http://127.0.0.1:5555',
      https_proxy: 'http://127.0.0.1:5555',
    });
  });

  it('直连、解析失败、桥起不来:都不下发', async () => {
    await expect(claudeCliNetworkEnv()).resolves.toEqual({});
    h.resolveError = new Error('resolver down');
    await expect(claudeCliNetworkEnv()).resolves.toEqual({});
    h.resolveError = null;
    h.resolved = 'socks5://127.0.0.1:7891';
    h.bridge.mockRejectedValueOnce(new Error('listen failed'));
    await expect(claudeCliNetworkEnv()).resolves.toEqual({});
  });
});

describe('登录态读取', () => {
  it('读失败后退避,期间不再反复拉起 CLI;force 绕过退避', async () => {
    h.spawn.mockImplementation(() => fakeChild({ error: new Error('ENOENT') }));
    await expect(refreshClaudeCliLoginStatus()).resolves.toEqual({ loggedIn: false });
    await expect(refreshClaudeCliLoginStatus()).resolves.toEqual({ loggedIn: false });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    h.spawn.mockImplementation(() => fakeChild({ stdout: SUBSCRIPTION }));
    await expect(refreshClaudeCliLoginStatus({ force: true })).resolves.toMatchObject({ loggedIn: true });
    expect(h.spawn).toHaveBeenCalledTimes(2);
    expect(argsOf(h.spawn.mock.calls[1])).toEqual(['auth', 'status', '--json']);
  });

  it('staleWhileRevalidate:没有缓存时不等 CLI,后台读完再更新缓存', async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    h.spawn.mockImplementation(() => {
      const child = fakeChild('hang');
      void gate.then(() => {
        child.stdout.emit('data', Buffer.from(SUBSCRIPTION));
        child.emit('close', 0);
      });
      return child;
    });
    await expect(readClaudeCliLoginStatus({ maxAgeMs: 30_000, staleWhileRevalidate: true })).resolves.toEqual({
      loggedIn: false,
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    release();
    await vi.waitFor(() => expect(peekClaudeCliLoginStatus()).toMatchObject({ loggedIn: true }));
    // 有新鲜缓存时直接返回,不再拉起。
    await expect(readClaudeCliLoginStatus({ maxAgeMs: 30_000, staleWhileRevalidate: true })).resolves.toMatchObject({
      loggedIn: true,
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });
});

describe('runClaudeCliLogin', () => {
  it('已登录直接返回,不拉起登录', async () => {
    h.spawn.mockImplementation(() => fakeChild({ stdout: SUBSCRIPTION }));
    await expect(runClaudeCliLogin(new AbortController().signal)).resolves.toMatchObject({ ok: true });
    expect(h.spawn).toHaveBeenCalledTimes(1);
  });

  it('CLI 用非订阅方式登录:返回 not_a_subscription,不替用户改 CLI 的登录', async () => {
    h.spawn.mockImplementation(() => fakeChild({ stdout: API_KEY_LOGIN }));
    await expect(runClaudeCliLogin(new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'not_a_subscription',
    });
    expect(h.spawn).toHaveBeenCalledTimes(1);
    expect(argsOf(h.spawn.mock.calls[0])).toEqual(['auth', 'status', '--json']);
  });

  it('拉起 `claude auth login --claudeai`,完成后以重读的登录态为结论', async () => {
    h.spawn
      .mockImplementationOnce(() => fakeChild({ stdout: LOGGED_OUT }))
      .mockImplementationOnce(() => fakeChild({ stdout: 'Login successful.', code: 0 }))
      .mockImplementationOnce(() => fakeChild({ stdout: SUBSCRIPTION }));
    await expect(runClaudeCliLogin(new AbortController().signal)).resolves.toMatchObject({
      ok: true,
      status: { loggedIn: true },
    });
    expect(argsOf(h.spawn.mock.calls[1])).toEqual(['auth', 'login', '--claudeai']);
  });

  it('取消时结束登录子进程', async () => {
    const login = fakeChild('hang');
    h.spawn
      .mockImplementationOnce(() => fakeChild({ stdout: LOGGED_OUT }))
      .mockImplementationOnce(() => login);
    const abort = new AbortController();
    const pending = runClaudeCliLogin(abort.signal);
    await vi.waitFor(() => expect(h.spawn).toHaveBeenCalledTimes(2));
    abort.abort();
    await expect(pending).resolves.toEqual({ ok: false, reason: 'login_cancelled' });
    expect(login.kill).toHaveBeenCalled();
  });

  it('内置 CLI 不可用 → local_unavailable', async () => {
    h.binary = null;
    await expect(runClaudeCliLogin(new AbortController().signal)).resolves.toEqual({
      ok: false,
      reason: 'local_unavailable',
    });
    expect(h.spawn).not.toHaveBeenCalled();
  });
});
