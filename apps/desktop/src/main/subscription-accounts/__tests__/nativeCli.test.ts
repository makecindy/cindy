/** Standard tier: real native control transport with in-memory CLI pipes.
 * Protects profile separation, bounded subprocess lifetime and sanitized errors, without real credentials.
 */
import { EventEmitter } from 'node:events';
import { access, mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  binary: '/fixture/codex' as string | null,
  spawn: vi.fn(),
  error: false,
  errorMessage: 'fixture-secret-must-not-leak',
  hold: false,
  accountResult: undefined as unknown,
  authStore: 'ephemeral',
  modelRefresh: false,
  renew: undefined as (() => Promise<void>) | undefined,
  oldAuthenticated: false,
  oldReason: 'oauth_expired',
  oldLogin: vi.fn<(...args: unknown[]) => Promise<{ ok: boolean; reason?: string }>>(async () => ({ ok: true })),
  oldCancel: vi.fn(),
}));
vi.mock('node:child_process', () => ({ spawn: h.spawn }));
vi.mock('@cindy/maker-core', () => ({
  cleanProcessEnv: () => ({
    PATH: '/fixture/bin',
    OPENAI_API_KEY: 'fixture-key',
    CODEX_API_KEY: 'fixture-key',
    CODEX_HOME: '/wrong-profile',
    openai_base_url: 'https://gateway.invalid',
  }),
}));
vi.mock('../../agent-binaries/index.js', () => ({ getReadyBinaryPath: () => h.binary }));
vi.mock('../../maker-host/codex-account-auth.desktop.js', () => ({
  codexAccountState: () => ({ authenticated: h.oldAuthenticated, errorReason: h.oldAuthenticated ? undefined : h.oldReason }),
  loginCodexAccount: h.oldLogin,
  cancelCodexAccountLogin: h.oldCancel,
}));
vi.mock('../../maker-host/claude-native-cli.desktop.js', () => ({
  refreshClaudeCliLoginStatus: vi.fn(),
  readClaudeCliPlanUsage: vi.fn(),
  runClaudeCliLogin: vi.fn(),
}));
import {
  codexAccountRpc,
  readNativeAccount,
  readNativeAccountUsage,
  loginNativeAccount,
  readNativeCodexTokens,
  readLegacyCodexProviderAccount,
  loginLegacyCodexProviderAccount,
  withCodexModelDiscovery,
} from '../nativeCli.js';
import { isAccountServiceUnreachable } from '../accountServiceError.js';
import { refreshClaudeCliLoginStatus, runClaudeCliLogin } from '../../maker-host/claude-native-cli.desktop.js';

const children: (EventEmitter & {
  stdin: EventEmitter & { write: ReturnType<typeof vi.fn> };
  stdout: EventEmitter;
  kill: ReturnType<typeof vi.fn>;
})[] = [];

// Unit regression: account replacement during CLI startup must prevent the
// reset request itself, not merely reject its already-consumed response.
it('does not dispatch a reset after its credential guard expires during startup', async () => {
  await expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => false)).rejects.toThrow('changed before dispatch');
  const methods = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method);
  expect(methods).toEqual(['initialize', 'initialized']);
});

// Existing pooled accounts use synchronous proofs. Do not insert a new yield between proof and write.
it('preserves synchronous guarded dispatch before the next microtask', async () => {
  let methodsAtNextMicrotask: string[] = [];
  await codexAccountRpc('/second', 'account/rateLimitResetCredit/consume', { idempotencyKey: 'key' }, () => {
    queueMicrotask(() => {
      methodsAtNextMicrotask = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method);
    });
    return true;
  });
  expect(methodsAtNextMicrotask).toEqual(['initialize', 'initialized', 'account/rateLimitResetCredit/consume']);
});

// #10408, unit: filesystem/source checks are asynchronous. A Promise is not authorization;
// inspect actual CLI writes, including connection termination while the proof is pending.
it.each([true, false])('waits for an asynchronous dispatch proof (allowed: %s)', async (allowed) => {
  let decide!: (allowed: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proof = new Promise<boolean>(resolve => { decide = resolve; });
  const pending = codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => { entered(); return proof; });
  const observed = allowed ? expect(pending).resolves.toBeDefined()
    : expect(pending).rejects.toThrow('changed before dispatch');
  await started;
  try {
    expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
      .toEqual(['initialize', 'initialized']);
  } finally {
    decide(allowed);
    await observed;
  }
  expect(children[0].stdin.write.mock.calls.some(([line]) =>
    JSON.parse(line).method === 'account/rateLimitResetCredit/consume')).toBe(allowed);
});

it('does not dispatch after the connection closes while an asynchronous proof is pending', async () => {
  let decide!: (allowed: boolean) => void;
  let entered!: () => void;
  const started = new Promise<void>(resolve => { entered = resolve; });
  const proof = new Promise<boolean>(resolve => { decide = resolve; });
  const pending = expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, () => { entered(); return proof; })).rejects.toThrow('connection closed');
  await started;
  children[0].emit('close', null);
  await pending;
  decide(true);
  await Promise.resolve();
  expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
    .toEqual(['initialize', 'initialized']);
});

it('rejects a failed asynchronous proof without sending or exposing its error details', async () => {
  await expect(codexAccountRpc('/second', 'account/rateLimitResetCredit/consume',
    { idempotencyKey: 'key' }, async () => { throw new Error('fixture-secret-must-not-leak'); }))
    .rejects.toThrow('Codex account changed before dispatch');
  expect(children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line).method))
    .toEqual(['initialize', 'initialized']);
});

beforeEach(() => {
  h.binary = '/fixture/codex';
  h.error = false;
  h.errorMessage = 'fixture-secret-must-not-leak';
  h.hold = false;
  h.accountResult = undefined;
  h.authStore = 'ephemeral';
  h.modelRefresh = false;
  h.renew = undefined;
  h.oldAuthenticated = false;
  h.oldReason = 'oauth_expired';
  h.oldLogin.mockReset().mockResolvedValue({ ok: true });
  h.oldCancel.mockReset();
  children.length = 0;
  h.spawn.mockReset().mockImplementation((_binary, args, options) => {
    const child = Object.assign(new EventEmitter(), {
      stdin: Object.assign(new EventEmitter(), { write: vi.fn() }),
      stdout: new EventEmitter(),
      kill: vi.fn(),
    });
    child.kill.mockImplementation(() => {
      child.emit('close', null);
    });
    child.stdin.write.mockImplementation((line: string) => {
      const request = JSON.parse(line);
      if (!request.id || h.hold) return;
      queueMicrotask(async () => {
        if (request.method === 'account/read' && h.renew) await h.renew();
        if (request.method === 'model/list' && h.modelRefresh) {
          child.stdout.emit('data', Buffer.from(JSON.stringify({ id: 2,
            method: 'account/chatgptAuthTokens/refresh',
            params: { reason: 'unauthorized', previousAccountId: 'fixture-account' },
          }) + '\n'));
          return;
        }
        child.stdout.emit(
          'data',
          Buffer.from(
            JSON.stringify(
              request.id === 1
                ? { id: 1, result: {} }
                : h.error
                  ? { id: request.id, error: { message: h.errorMessage } }
                  : {
                      id: request.id,
                      result: request.method === 'config/read'
                        ? { config: { cli_auth_credentials_store: h.authStore } }
                        : request.method === 'account/login/start' ? { type: 'chatgptAuthTokens' }
                        : h.accountResult ?? {
                        account: {
                          type: 'chatgpt',
                          email: options.env.CODEX_HOME + '@example.test',
                          planType: 'plus',
                        },
                      },
                    },
            ) + '\n',
          ),
        );
      });
    });
    children.push(child);
    if (args[0] === 'login' && !h.hold) queueMicrotask(() => child.emit('close', 0));
    return child;
  });
});
afterEach(() => vi.useRealTimers());
// Standard: expiry and renewal belong to the selected native profile, never the
// system default. Previous coverage exercised only Codex's RPC account reader.
describe('Claude profile renewal', () => {
  it('reads the selected profile expiry and forwards a verified renewal request', async () => {
    vi.mocked(refreshClaudeCliLoginStatus).mockResolvedValueOnce({ loggedIn: true,
      email: 'second@example.test', loginExpiresAt: '2030-01-05T00:00:00.000Z',
      subscriptionType: 'pro', planTier: 'pro', planDisplayName: 'Ultra' });
    expect(await readNativeAccount('anthropic', '/fixture/claude-second', { force: true })).toMatchObject({
      authenticated: true, identity: 'second@example.test', loginExpiresAt: '2030-01-05T00:00:00.000Z',
      plan: 'pro', planTier: 'pro', planDisplayName: 'Ultra',
    });
    expect(refreshClaudeCliLoginStatus).toHaveBeenLastCalledWith({ configDir: '/fixture/claude-second', force: true, requireFresh: true });
    const signal = new AbortController().signal;
    vi.mocked(runClaudeCliLogin).mockResolvedValueOnce({ ok: true, status: { loggedIn: true, email: 'second@example.test' } });
    await loginNativeAccount('anthropic', '/fixture/claude-second', signal, { renew: true, expectedEmail: 'second@example.test' });
    expect(runClaudeCliLogin).toHaveBeenLastCalledWith(signal, '/fixture/claude-second', { renew: true, expectedEmail: 'second@example.test' });
    vi.mocked(runClaudeCliLogin).mockResolvedValueOnce({ ok: false, reason: 'account_mismatch' });
    await expect(loginNativeAccount('anthropic', '/fixture/claude-second', signal, { renew: true, expectedEmail: 'second@example.test' }))
      .rejects.toThrow('account_mismatch');
  });
});
describe('official Codex profiles', () => {
  // External-auth's reverse RPC is also needed when discovery encounters an expired
  // access token. Renewal may replace auth.json, but must never adopt another account.
  it.each([false, true])('handles discovery renewal without adopting a replaced account (replaced=%s)', async replaced => {
    const native = await mkdtemp(path.join(tmpdir(), 'cindy-model-renew-'));
    const authPath = path.join(native, 'auth.json');
    const auth = (accessToken: string, accountId = 'fixture-account') => JSON.stringify({
      tokens: { access_token: accessToken, account_id: accountId },
    });
    let isolated = '';
    try {
      await writeFile(authPath, auth('fixture-token-old'));
      h.modelRefresh = true;
      h.accountResult = { data: [{ id: 'gpt-6.2' }] };
      h.renew = () => writeFile(authPath, auth('fixture-token-renewed', replaced ? 'other-account' : undefined));
      const pending = withCodexModelDiscovery(native, () => true, async (request, cacheDirectory, canPublish) => {
        isolated = cacheDirectory;
        const result = await request({ cursor: null });
        expect(canPublish()).toBe(true);
        return result;
      });
      if (replaced) await expect(pending).rejects.toThrow('authentication is unavailable or has changed');
      else await expect(pending).resolves.toEqual({ data: [{ id: 'gpt-6.2' }] });
      const response = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line))
        .find(message => message.id === 2 && message.result);
      expect(response?.result).toEqual(replaced ? undefined : {
        accessToken: 'fixture-token-renewed', chatgptAccountId: 'fixture-account',
      });
      expect(h.spawn.mock.calls[1][2].env.CODEX_HOME).toBe(native);
      expect(h.spawn.mock.calls[1][1]).toEqual(['app-server', '-c', 'model_provider="openai"',
        '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"']);
      await expect(access(isolated)).rejects.toThrow();
    } finally { await rm(native, { recursive: true, force: true }); }
  });

  // Magpie regression, unit: the real discovery entry must isolate config/cache and use
  // only the selected account's in-memory tokens. Existing cases exercised account RPCs
  // in native homes, never a home with model_catalog_json or a non-OpenAI provider.
  it('discovers official models in an empty temporary home and leaves the native profile intact', async () => {
    const native = await mkdtemp(path.join(tmpdir(), 'cindy-magpie-fixture-'));
    const config = 'model_provider="magpie"\nmodel_catalog_json="mixed.json"\n';
    const auth = JSON.stringify({ tokens: { access_token: 'fixture-token', account_id: 'fixture-account' } });
    let isolated = '';
    try {
      await writeFile(path.join(native, 'config.toml'), config);
      await writeFile(path.join(native, 'auth.json'), auth);
      await writeFile(path.join(native, 'models_cache.json'), '{"models":[{"slug":"grok-4.7"}]}');
      h.accountResult = { data: [{ id: 'gpt-6.2' }] };
      const result = await withCodexModelDiscovery(native, () => true, async (request, cacheDirectory, canPublish) => {
        isolated = cacheDirectory;
        expect(isolated).not.toBe(native);
        await expect(access(path.join(isolated, 'config.toml'))).rejects.toThrow();
        await expect(access(path.join(isolated, 'auth.json'))).rejects.toThrow();
        await expect(access(path.join(isolated, 'models_cache.json'))).rejects.toThrow();
        const page = await request({ cursor: null, limit: 100 });
        expect(canPublish()).toBe(true);
        return page;
      });
      expect(result).toEqual({ data: [{ id: 'gpt-6.2' }] });
      expect(h.spawn.mock.calls[0][2]).toMatchObject({ cwd: isolated, env: { CODEX_HOME: isolated } });
      expect(h.spawn.mock.calls[0][1]).toEqual(['app-server',
        '-c', 'model_provider="openai"', '-c', 'chatgpt_base_url="https://chatgpt.com/backend-api/"',
        '-c', 'cli_auth_credentials_store="ephemeral"']);
      const requests = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line));
      expect(requests.map(request => request.method)).toEqual([
        'initialize', 'initialized', 'config/read', 'account/login/start', 'model/list',
      ]);
      expect(requests[3].params).toEqual({ type: 'chatgptAuthTokens', accessToken: 'fixture-token', chatgptAccountId: 'fixture-account' });
      expect(children[0].kill).toHaveBeenCalledWith('SIGKILL');
      await expect(access(isolated)).rejects.toThrow();
      expect(await readFile(path.join(native, 'config.toml'), 'utf8')).toBe(config);
      expect(await readFile(path.join(native, 'auth.json'), 'utf8')).toBe(auth);
    } finally { await rm(native, { recursive: true, force: true }); }
  });

  // Credentials-and-local-storage: config verification and source proofs must run
  // before secrets or model requests are dispatched. Also prove cleanup on rejection.
  it.each(['file-store', 'switched-account', 'rpc-error'])(
    'fails closed and cleans isolated discovery after %s', async failure => {
      const native = await mkdtemp(path.join(tmpdir(), 'cindy-model-failure-'));
      let isolated = '';
      let current = true;
      try {
        await writeFile(path.join(native, 'auth.json'), JSON.stringify({
          tokens: { access_token: 'fixture-token', account_id: 'fixture-account' },
        }));
        if (failure === 'file-store') h.authStore = 'file';
        if (failure === 'rpc-error') h.error = true;
        await expect(withCodexModelDiscovery(native, () => current, async (request, cacheDirectory) => {
          isolated = cacheDirectory;
          if (failure === 'switched-account') current = false;
          return request({ cursor: null });
        })).rejects.toThrow();
        const requests = children[0].stdin.write.mock.calls.map(([line]) => JSON.parse(line));
        expect(requests.some(request => request.method === 'account/login/start')).toBe(false);
        expect(requests.some(request => request.method === 'model/list')).toBe(false);
        await expect(access(isolated)).rejects.toThrow();
      } finally { await rm(native, { recursive: true, force: true }); }
    },
  );

  // #10110 review, unit: legacy auth has no plan. Keep the plan returned by the
  // selected profile's quota RPC; the old test fixtures only read account/read.
  it('preserves the selected profile plan alongside its sanitized Codex quota', async () => {
    h.accountResult = { rateLimits: { planType: 'pro', primary: {
      usedPercent: 20, windowDurationMins: 300, resetsAt: Date.now() / 1000 + 3600,
    } } };
    expect(await readNativeAccountUsage('openai', '/fixture/legacy')).toMatchObject({
      codexPlan: 'pro', codexUsage: { appServerBuckets: { __default__: { primary: { usedPercent: 20 } } } },
    });
    expect(h.spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/fixture/legacy');
  });
  // Upgrade 2026-11-11, standard: a revoked imported login cannot be resurrected
  // by reading its still-present token file; successful reads keep the old native profile.
  it('honors the old connection revocation before reading its native account', async () => {
    expect(await readLegacyCodexProviderAccount('openai-old', '/fixture/imported')).toMatchObject({ authenticated: false, errorReason: 'oauth_expired' });
    expect(h.spawn).not.toHaveBeenCalled();
    h.oldAuthenticated = true;
    expect(await readLegacyCodexProviderAccount('openai-old', '/fixture/imported')).toMatchObject({ authenticated: true, plan: 'plus' });
    expect(h.spawn.mock.calls[0][2].env.CODEX_HOME).toBe('/fixture/imported');
  });

  // 2026-11-18 personal restart, unit: an interrupted task's automatic resume failed with
  // "requires login" because the account was read before custom providers reached the catalog.
  // Entry: readLegacyCodexProviderAccount, whose rejection the pool caches for seconds as
  // unavailable (runtime.test "re-reads a failed account snapshot"); a returned signed-out state
  // is cached for 30 s as LOGIN_REQUIRED. Minimal input: catalog lookup reports provider_unavailable.
  it('reports a connection missing from the catalog as a failed read, not a signed-out account', async () => {
    h.oldReason = 'provider_unavailable';
    await expect(readLegacyCodexProviderAccount('openai-old', '/fixture/imported')).rejects.toThrow('not loaded');
    expect(h.spawn).not.toHaveBeenCalled();
  });

  it('uses the original login cancellation path for an imported connection', async () => {
    const controller = new AbortController();
    h.oldLogin.mockImplementation(async (_id, isCurrent) => {
      controller.abort();
      expect((isCurrent as () => boolean)()).toBe(false);
      return { ok: true };
    });
    await expect(loginLegacyCodexProviderAccount('openai-old', controller.signal)).rejects.toThrow('login_cancelled');
    expect(h.oldCancel).toHaveBeenCalledWith('openai-old');
  });
  // #9517, unit: the real account reader must distinguish provider-managed
  // authentication from a signed-out ChatGPT account; older tests only returned ChatGPT.
  it.each([
    { account: null, requiresOpenaiAuth: false, reason: 'codex_provider_managed_auth' },
    { account: null, requiresOpenaiAuth: true, reason: undefined },
    { account: null, requiresOpenaiAuth: undefined, reason: undefined },
    { account: { type: 'chatgpt' }, requiresOpenaiAuth: false, reason: undefined },
  ])('classifies account=$account with requiresOpenaiAuth=$requiresOpenaiAuth', async ({ account, requiresOpenaiAuth, reason }) => {
    h.accountResult = { account, requiresOpenaiAuth };
    const result = await readNativeAccount('openai', '/fixture/custom-provider');
    expect(result.authenticated).toBe(account?.type === 'chatgpt');
    expect(result.errorReason).toBe(reason);
  });

  it('keeps the provider diagnosis if configuration changes while browser login is open', async () => {
    h.accountResult = { account: null, requiresOpenaiAuth: false };
    await expect(loginNativeAccount('openai', '/fixture/second', new AbortController().signal))
      .rejects.toThrow('codex_provider_managed_auth');
  });

  it('expires a selected-profile dispatch proof when that profile is replaced or removed', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'cindy-subscription-proof-'));
    const authPath = path.join(dir, 'auth.json');
    try {
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-token-a', account_id: 'fixture-account-a' },
        }),
      );
      const [first, concurrent] = await Promise.all([
        readNativeCodexTokens(dir, true),
        readNativeCodexTokens(dir, true),
      ]);
      expect(h.spawn).toHaveBeenCalledTimes(1);
      expect(concurrent.accessToken).toBe(first.accessToken);
      expect(first.chatgptAccountId).toBe('fixture-account-a');
      expect(first.canDispatch()).toBe(true);
      await writeFile(
        authPath,
        JSON.stringify({
          tokens: { access_token: 'fixture-longer-token-b', account_id: 'fixture-account-b' },
        }),
      );
      expect(first.canDispatch()).toBe(false);
      const second = await readNativeCodexTokens(dir);
      expect(second.chatgptAccountId).toBe('fixture-account-b');
      await rm(authPath);
      expect(second.canDispatch()).toBe(false);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
  it('queries separate homes concurrently without changing process.env or passing API credentials', async () => {
    const inherited = process.env.CODEX_HOME;
    const result = await Promise.all([
      readNativeAccount('openai', '/fixture/default'),
      readNativeAccount('openai', '/fixture/second'),
    ]);
    expect(result.map((r) => r.identity)).toEqual([
      '/fixture/default@example.test',
      '/fixture/second@example.test',
    ]);
    expect(result.every((r) => r.authenticated)).toBe(true);
    expect(process.env.CODEX_HOME).toBe(inherited);
    expect(h.spawn.mock.calls.map((c) => c[2].env)).toEqual([
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/default' },
      { PATH: '/fixture/bin', CODEX_HOME: '/fixture/second' },
    ]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
  it('never returns CLI response details in errors and closes failed control processes', async () => {
    h.error = true;
    await expect(codexAccountRpc('/fixture/second', 'account/read', {})).rejects.toThrow(
      'Codex account request failed',
    );
    expect(children[0].kill).toHaveBeenCalledTimes(1);
  });
  // 2026-11-18 user report, unit: Codex answered `workspace routing discovery timed out` because
  // chatgpt.com resolved to a wrong address. It surfaced as a generic failure, so a valid login
  // looked lost. The earlier case only covers a non-network error. Classify, never forward text.
  it.each([
    { message: 'workspace routing discovery timed out', unreachable: true },
    { message: 'error sending request for url (https://chatgpt.com/backend-api/x)', unreachable: true },
    { message: 'fixture-secret-must-not-leak', unreachable: false },
  ])('classifies a CLI account error as unreachable=$unreachable', async ({ message, unreachable }) => {
    h.error = true;
    h.errorMessage = message;
    const error = await codexAccountRpc('/fixture/second', 'account/read', {}).catch((e: unknown) => e);
    expect(isAccountServiceUnreachable(error)).toBe(unreachable);
    expect((error as Error).message).toBe('Codex account request failed');
  });

  // Same report: the browser login finished, then its confirming read hit the network failure and
  // the whole sign-in was reported as failed. The caller re-reads and shows the account as unknown.
  it('does not fail a finished browser login when only the confirming read is unreachable', async () => {
    h.error = true;
    h.errorMessage = 'workspace routing discovery timed out';
    await expect(loginNativeAccount('openai', '/fixture/second', new AbortController().signal)).resolves.toBeUndefined();
    h.errorMessage = 'fixture-secret-must-not-leak';
    await expect(loginNativeAccount('openai', '/fixture/second', new AbortController().signal))
      .rejects.toThrow('Codex account request failed');
  });

  it('bounds a stalled CLI read and cancels a browser login without querying another profile', async () => {
    vi.useFakeTimers();
    h.hold = true;
    const pending = codexAccountRpc('/fixture/second', 'account/read', {}).catch((e: unknown) => e);
    await vi.advanceTimersByTimeAsync(15_000);
    const stalled = await pending;
    expect((stalled as Error).message).toMatch('timed out');
    expect(isAccountServiceUnreachable(stalled)).toBe(true);
    const abort = new AbortController();
    const login = expect(
      loginNativeAccount('openai', '/fixture/second', abort.signal),
    ).rejects.toThrow('login_cancelled');
    abort.abort();
    await login;
    expect(h.spawn.mock.calls.map((c) => c[1])).toEqual([['app-server'], ['login']]);
    expect(children.every((c) => c.kill.mock.calls.length === 1)).toBe(true);
  });
});
