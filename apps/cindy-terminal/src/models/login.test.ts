import {TerminalTaskHost} from '../tasks/host.js';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { afterEach, expect, it, vi } from 'vitest';
import { RemoteResourceRegistry } from '@cindy/device-link';
import { TerminalSecretStore } from '../secrets.js';
import { TerminalModelConfig, modelFixtureDatabase, closeModelFixtureDatabases } from '../testing/model-config.js';
import { TerminalProviderLogin, type ProviderLoginState } from './login.js';
import { TerminalConfiguration } from '../configuration.js';
import { TerminalCapabilities } from '../tasks/capabilities.js';
import { TerminalProtectedInput } from '../protected-input.js';
import { registerModelConfigurationResources } from './resources.js';
import { createProviderProxy } from './proxy.js';
import * as platform from '../platform.js';
import { TerminalClaudeLogin } from './claude-login.js';
import { encodeCatalogModelPin } from '@cindy/model-providers/catalogModelPin';
import { TerminalUtilityModels } from './utility.js';
import { TerminalSubscriptions } from './subscriptions.js';
import { TerminalNativeAccounts } from './native-accounts.js';
import { runNative } from '../engines/native.js';
import { TerminalClaudeAuthorization, type ProviderTerminalFrame } from './claude-terminal.js';
import type { IPty } from 'node-pty';
import type { PtySpawnFn } from '@cindy/terminal-core';
import { TerminalGrokLogin } from './grok-login.js';
import { createChatgptProxy, createGrokProxy } from './subscription-proxy.js';

const cleanup: Array<() => Promise<unknown>> = [];
const roots: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const close of cleanup.splice(0).reverse()) await close();
  await closeModelFixtureDatabases();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

// Integration: headless provider login must survive another computer's browser
// callback without putting the code/token on the generic remote wire. Use the
// actual controller cryptography, PKCE, encrypted vault and request proxy.
async function fixture(grokFetch?: typeof fetch, claudeSetup?: { run: typeof runNative; spawn: PtySpawnFn }, independent = false) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-provider-login-'));
  roots.push(root);
  const secrets = new TerminalSecretStore(root);
  await secrets.initialize('machine');
  const requests: Array<{
    path: string;
    body: string;
    authorization?: string;
  }> = [];
  let beforeToken: (() => Promise<void>) | undefined;
  const api = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    requests.push({
      path: req.url!,
      body,
      authorization: req.headers.authorization,
    });
    res.setHeader('content-type', 'application/json');
    if (req.url === '/token') {
      await beforeToken?.();
      res.end(
        JSON.stringify({
          access_token: body.includes('grant_type=refresh_token')
            ? 'synthetic-refreshed-token'
            : 'synthetic-private-access',
          refresh_token: 'synthetic-private-refresh',
          expires_in: 3600,
        }),
      );
    } else if (req.url === '/chat/completions')
      res.end(
        JSON.stringify({
          choices: [{ message: { content: 'OAUTH_ROUTE_OK' } }],
        }),
      );
    else res.writeHead(404).end('{}');
  });
  await new Promise<void>((resolve) => api.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => {
    api.closeAllConnections();
    await new Promise<void>((resolve) => api.close(() => resolve()));
  });
  const endpoint = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  let active = true;
  const guard = () => {
    if (!active) throw new Error('OWNER_CHANGED');
  };
  const models = new TerminalModelConfig(root, secrets, async () => ({
    authenticated: false,
  }));
  await models.open();
  await models.saveProvider(
    {
      id: 'fixture',
      name: 'Fixture OAuth',
      auth: {
        method: 'oauth',
        oauth: {
          authorizeUrl: 'https://idp.example/authorize',
          tokenUrl: 'https://idp.example/token',
          clientId: 'public-fixture',
          scopes: 'inference offline_access',
        },
      },
      runtimes: {
        codex: {
          baseUrl: endpoint,
          wireProtocol: 'openai-chat',
          models: [{ id: 'fixture-model', name: 'Fixture' }],
        },
      },
    },
    {},
    true,
  );

  const subscriptions = independent ? new TerminalSubscriptions({ root, models, secrets, binary: async () => process.execPath, assertCurrent: guard, changed: () => models.gatewayChanged(), fetch: grokFetch }) : undefined;
  const grok = subscriptions ? subscriptions.grokAccount() : grokFetch ? new TerminalGrokLogin({ root, models, secrets, assertCurrent: guard, changed: () => models.gatewayChanged(), fetch: grokFetch }) : undefined;
  const claudeAuth = claudeSetup ? new TerminalClaudeLogin({ owner: 'owner', binary: async () => process.execPath,
    readBinding: () => secrets.getSync('terminal:native:anthropic-binding'),
    writeBinding: value => value === null ? secrets.deleteSync('terminal:native:anthropic-binding') : secrets.setSync('terminal:native:anthropic-binding', value),
    assertCurrent: guard, changed: () => models.gatewayChanged(), run: claudeSetup.run,
  }) : undefined;
  if (claudeAuth) models.nativeClaude = claudeAuth;
  const claude = claudeAuth ? new TerminalClaudeAuthorization({ auth: claudeAuth, binary: async () => process.execPath, assertCurrent: guard, spawn: claudeSetup!.spawn }) : undefined;
  const login = new TerminalProviderLogin({
    grok, claude, subscriptions,
    models,
    secrets,
    assertCurrent: guard,
    changed: () => models.gatewayChanged(),
    log: { info() {}, warn() {} },
    fetch: (url, init) => {
      if (String(url) !== 'https://idp.example/token')
        throw new Error('UNEXPECTED_FIXTURE_REQUEST');
      return fetch(endpoint + '/token', init);
    },
  });
  cleanup.push(() => login.close());
  const runtimeLogger:import('@cindy/maker-core').Logger={trace(){},debug(){},info(){},warn(){},error(){},fatal(){},child(){return this;}};

  const taskHost=new TerminalTaskHost({profileDir:root,database:await modelFixtureDatabase(root),secretStore:secrets,logger:runtimeLogger,emit(){},nativeStatus:async()=>({authenticated:false})});
  cleanup.push(()=>taskHost.close());
  await taskHost.ready;
  const capabilities=taskHost.capabilities;
  const configuration = new TerminalConfiguration(capabilities, {
    login,
    revision: () => models.revision(),
    save: (action, config, keys, context) =>
      models.saveProvider(
        config,
        keys,
        action === 'create',
        context.assertCurrent,
      ),
  });
  const registry = new RemoteResourceRegistry();
  registerModelConfigurationResources(
    registry,
    models,
    configuration,
    async () => {
      throw new Error('UNEXPECTED_MUTATION');
    },
  );
  const wire: unknown[] = [],
    events: unknown[] = [];
  const make = (deviceId: string): TerminalProtectedInput =>
    new TerminalProtectedInput({
      root: path.join(root, deviceId),
      secrets,
      scope: () => ({ realm: 'global', membershipId: 'owner', deviceId }),
      assertCurrent: guard,
      remoteEnabled: () => true,
      taskExists: async () => true,
      emit: (channel, payload) => events.push({ channel, payload }),
      invoke: async (_device, channel, args) => {
        wire.push({ channel, args });
        const result =
          channel === 'maker:remote-resources:invoke'
            ? await registry.invoke(
                { controllerDeviceId: deviceId, assertCurrent: guard },
                args[0] as Parameters<typeof registry.invoke>[1],
              )
            : await host.request(deviceId, args[0]);
        wire.push({ result });
        return { ok: true, result };
      },
    });
  const host = make('host'),
    controller = make('controller');
  host.configureSettings(configuration);
  cleanup.push(async () => {
    active = true;
    await controller.close();
    await host.close();
  });
  async function begin() {
    const { id } = await controller.channelRegistration(
      { command: 'begin', providerId: 'fixture', deviceId: 'host' },
      'providers',
    );
    let state: ProviderLoginState = { status: 'pending' };
    await vi.waitFor(
      async () => {
        state = (
          await controller.channelRegistration(
            { command: 'read', id },
            'providers',
          )
        ).state!;
        expect(state.verificationUrl).toBeTruthy();
      },
      { interval: 5 },
    );
    const url = new URL(state.verificationUrl!);
    const callback = new URL(url.searchParams.get('redirect_uri')!);
    callback.searchParams.set('state', url.searchParams.get('state')!);
    callback.searchParams.set('code', 'synthetic-private-code');
    return { id, url, callback };
  }
  return {
    root,
    secrets,
    grok,
    subscriptions,
    claudeAuth,
    login,
    models,
    controller,
    wire,
    events,
    requests,
    begin,
    revoke: () => {
      active = false;
    },
    intercept: (fn: () => Promise<void>) => {
      beforeToken = fn;
    },
  };
}

it('seals callback input, validates PKCE, refreshes the live proxy and disconnects without leaking credentials', async () => {
  vi.useFakeTimers({ toFake: ['Date'] });
  const f = await fixture();
  const { id, url, callback } = await f.begin();
  const invalid = new URL(callback);
  invalid.searchParams.set('state', 'wrong-state');
  await expect(
    f.controller.channelRegistration(
      { command: 'submit', id, callback: invalid.href },
      'providers',
    ),
  ).rejects.toThrow('REGISTRATION_FAILED');
  expect(f.login.connected('fixture')).toBe(false);
  await f.controller.channelRegistration(
    { command: 'submit', id, callback: callback.href },
    'providers',
  );
  await vi.waitFor(
    async () =>
      expect(
        (
          await f.controller.channelRegistration(
            { command: 'read', id },
            'providers',
          )
        ).state?.status,
      ).toBe('success'),
    { interval: 5 },
  );
  const tokenRequest = new URLSearchParams(f.requests[0].body);
  expect(
    createHash('sha256')
      .update(tokenRequest.get('code_verifier')!)
      .digest('base64url'),
  ).toBe(url.searchParams.get('code_challenge'));
  expect(tokenRequest.get('code')).toBe('synthetic-private-code');
  expect(tokenRequest.get('redirect_uri')).toBe(
    url.searchParams.get('redirect_uri'),
  );

  const chosen = await f.models.select({
    providerId: 'fixture',
    agentKind: 'codex',
    model: 'fixture-model',
  });
  const bound = await createProviderProxy(
    chosen.route,
    'codex',
    await f.models.credential('fixture', 'codex'),
    {},
    undefined,
    undefined,
    () => f.models.credential('fixture', 'codex'),
  );
  cleanup.push(() => bound.close());
  const request = async () =>
    fetch(bound.url + '/responses', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${bound.token}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        model: 'fixture-model',
        input: 'probe',
        stream: false,
      }),
    });
  expect((await request()).status).toBe(200);
  expect(f.requests.at(-1)?.authorization).toBe(
    'Bearer synthetic-private-access',
  );
  vi.setSystemTime(Date.now() + 3600_000);
  expect((await request()).status).toBe(200);
  expect(f.requests.at(-1)?.authorization).toBe(
    'Bearer synthetic-refreshed-token',
  );
  const reopened = new TerminalSecretStore(f.root);
  await reopened.open();
  expect(await reopened.get('terminal:provider-oauth:fixture')).toContain(
    'synthetic-refreshed-token',
  );
  const saved = f.models.snapshot().providers[0];

  const ownerDb = (await f.models.fixtureDatabase).getDbClient();
  await ownerDb.exec("CREATE TRIGGER reject_provider_update BEFORE UPDATE ON custom_providers BEGIN SELECT RAISE(ABORT, 'EIO'); END");
  try {await expect(f.models.saveProvider({...saved, auth: {method: 'apiKey'}}, {}, false)).rejects.toThrow('EIO');}
  finally {await ownerDb.exec('DROP TRIGGER reject_provider_update');}
  expect(await f.models.credential('fixture', 'codex')).toBe(
    'synthetic-refreshed-token',
  );
  expect(f.models.snapshot().providers[0].auth?.method).toBe('oauth');
  for (const secret of [
    'synthetic-private-code',
    'synthetic-private-access',
    'synthetic-private-refresh',
    'synthetic-refreshed-token',
  ]) {
    expect(
      JSON.stringify({
        wire: f.wire,
        events: f.events,
        views: await f.models.views(),
      }),
    ).not.toContain(secret);
    expect(
      await readFile(path.join(f.root, 'secrets.enc'), 'utf8'),
    ).not.toContain(secret);
    expect(
      await readFile(path.join(f.root, 'models.json'), 'utf8'),
    ).not.toContain(secret);
  }
  f.login.disconnect('fixture');
  expect((await request()).status).toBe(403);
  expect(f.login.connected('fixture')).toBe(false);
});

it('discards a token response that arrives after the owner is revoked', async () => {
  const f = await fixture();
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  f.intercept(async () => {
    entered();
    await new Promise<void>((resolve) => {
      release = resolve;
    });
  });
  const { id, callback } = await f.begin();
  await f.controller.channelRegistration(
    { command: 'submit', id, callback: callback.href },
    'providers',
  );
  await started;
  f.revoke();
  release();
  await f.login.close();
  expect(await f.secrets.get('terminal:provider-oauth:fixture')).toBeNull();
  await expect(
    f.controller.channelRegistration({ command: 'read', id }, 'providers'),
  ).rejects.toThrow('OWNER_CHANGED');
});

function deferred<T = void>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const nativeToken = (expires: number, signature = 'synthetic-signature') => `header.${Buffer.from(JSON.stringify({ exp: expires })).toString('base64url')}.${signature}`;

async function nativeFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'cindy-native-login-'));
  roots.push(root);
  const vault = new TerminalSecretStore(root); await vault.initialize('machine');
  const grant = deferred(), visible = deferred(), changed = deferred();
  const expires = Math.floor(Date.now() / 1000) + 3600;
  const token = nativeToken(expires);
  const calls: Array<{ url: string; headers: import('node:http').IncomingHttpHeaders; body: Record<string, unknown> }> = [];
  let refreshes = 0;
  let beforeRefresh: (() => Promise<void>) | undefined;
  let authFailure: { status: number; body: string } | undefined;
  const api = createServer(async (req, res) => {
    if (req.url === '/models') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ models: [{ slug: 'gpt-fixture', display_name: 'GPT Fixture', visibility: 'list', supported_in_api: true, context_window: 128000, supported_reasoning_levels: [] }] })); return; }
    if (req.url === '/grant') { await grant.promise; res.end('{}'); return; }
    let raw = ''; for await (const chunk of req) raw += chunk;
    if (req.url === '/token') {
      refreshes++; await beforeRefresh?.();
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ access_token: nativeToken(Math.floor(Date.now() / 1000) + 3600, 'rotated'), refresh_token: 'rotated-private-refresh' })); return;
    }
    calls.push({ url: req.url!, headers: req.headers, body: JSON.parse(raw) });
    if (authFailure) { res.writeHead(authFailure.status, {'content-type':'application/json'}).end(authFailure.body); return; }
    const item = { type: 'message', id: 'msg', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'NATIVE_BRIDGE_OK', annotations: [] }] };
    const events = [
      { type: 'response.created', response: { id: 'r', status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: { ...item, status: 'in_progress', content: [] } },
      { type: 'response.content_part.added', output_index: 0, content_index: 0, item_id: 'msg', part: { type: 'output_text', text: '', annotations: [] } },
      { type: 'response.output_text.delta', output_index: 0, content_index: 0, item_id: 'msg', delta: 'NATIVE_BRIDGE_OK' },
      { type: 'response.output_item.done', output_index: 0, item },
      { type: 'response.completed', response: { id: 'r', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1 } } },
    ];
    res.setHeader('content-type', 'text/event-stream'); res.end(events.map(event => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
  });
  await new Promise<void>(resolve => api.listen(0, '127.0.0.1', resolve));
  cleanup.push(async () => { grant.resolve(); api.closeAllConnections(); await new Promise<void>(resolve => api.close(() => resolve())); });
  const endpoint = `http://127.0.0.1:${(api.address() as { port: number }).port}`;
  const runner = path.join(root, 'official-cli-fixture.mjs');
  await writeFile(runner, `import fs from 'node:fs/promises';import path from 'node:path';
    console.log('https://auth.openai.com/codex/device\\nABCD-12345');
    await fetch(${JSON.stringify(endpoint + '/grant')});
    await fs.writeFile(path.join(process.env.CODEX_HOME,'auth.json'),JSON.stringify(${JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, refresh_token: 'private-refresh', account_id: 'synthetic-workspace' } })}),{mode:0o600});`);
  let active = true;
  const guard = () => { if (!active) throw new Error('OWNER_CHANGED'); };
  const fetchLocal: typeof fetch = (url, init) => fetch(endpoint + (String(url).endsWith('/oauth/token') ? '/token' : String(url).includes('/models?') ? '/models' : '/responses'), init);
  const accounts = new TerminalNativeAccounts({ root, secrets: vault, binary: async () => process.execPath, assertCurrent: guard, changed: () => changed.resolve(), fetch: fetchLocal,
    run: async (_binary, args, opts) => {
      expect(args).toEqual(['login', '--device-auth']); expect(opts?.env?.CODEX_HOME).not.toBe(process.env.CODEX_HOME);
      return runNative(process.execPath, [runner], { ...opts, onOutput: text => { opts?.onOutput?.(text); visible.resolve(); } });
    },
  });
  cleanup.push(() => accounts.close());
  return { root, vault, token, expires, calls, accounts, grant, visible, changed, fetchLocal, guard, runner,
    failAuth: (failure?: {status:number;body:string}) => {authFailure=failure;},
    refreshes: () => refreshes, beforeRefresh: (fn: () => Promise<void>) => { beforeRefresh = fn; }, revoke: () => { active = false; } };
}

// Integration: use a real native child and temporary auth file, encrypted vault,
// actual shared refresh serializer and all three HTTP dispatch protocols.
it('isolates official CLI sign-in and refresh across the three native model routes', async () => {
  const f = await nativeFixture();
  f.accounts.begin('native-login', f.guard, Date.now() + 60_000);
  await f.visible.promise;
  expect(f.accounts.state('native-login')).toMatchObject({ status: 'pending', verificationUrl: 'https://auth.openai.com/codex/device', userCode: 'ABCD-12345' });
  f.grant.resolve(); await f.changed.promise;
  expect(f.accounts.state('native-login').status).toBe('success');
  expect(await readdir(path.join(f.root, 'provider-login'))).toEqual([]);
  expect(await readFile(path.join(f.root, 'secrets.enc'), 'utf8')).not.toContain(f.token);
  const models = new TerminalModelConfig(f.root, f.vault, async () => ({ authenticated: false }));
  await models.open(); models.connectNative(f.accounts);
  for (const kind of ['codex', 'claude-code', 'pi'] as const) {
    const provider = (await models.views()).find(p => p.id === 'openai')!;
    const model = provider.models[kind]!.find(m => !m.disabled)!;
    const { route } = await models.select({ agentKind: kind, providerId: 'openai', model: model.id });
    const proxy = await createChatgptProxy({ route, kind, taskId: 'native-route', accounts: f.accounts, fetch: f.fetchLocal });
    cleanup.push(() => proxy.close());
    const response = await fetch(proxy.url + (kind === 'claude-code' ? '/v1/messages' : kind === 'pi' ? '/codex/responses' : '/responses'), {
      method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'claude-code' ? { model: model.id, stream: true, max_tokens: 32, messages: [{ role: 'user', content: 'hello' }] } : { model: model.id.replace(/^chatgpt\//, ''), input: [], stream: true, store: false }),
    });
    expect(response.status).toBe(200); expect(await response.text()).toContain('NATIVE_BRIDGE_OK');
  }
  expect(f.calls).toHaveLength(3);
  for (const call of f.calls) {
    expect(call.headers.authorization).toBe(`Bearer ${f.token}`); expect(call.headers['chatgpt-account-id']).toBe('synthetic-workspace');
    expect(call.body.model).not.toMatch(/^chatgpt\//);
  }
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((f.expires + 1) * 1000);
  const refreshed = await Promise.all([f.accounts.credential(), f.accounts.credential(), f.accounts.credential()]);
  expect(f.refreshes()).toBe(1); expect(refreshed.every(value => value.accessToken.endsWith('.rotated'))).toBe(true);
  const retained = refreshed[0]; f.accounts.disconnect(); expect(retained.canDispatch()).toBe(false);
  await expect(f.accounts.credential()).rejects.toThrow('PROVIDER_LOGIN_REQUIRED');
  expect((await models.views()).find(p => p.id === 'openai')?.connected).toBe(false);
});

it('discards a late native grant and a late refresh after the owner disconnects', async () => {
  const f = await nativeFixture();
  f.accounts.begin('cancelled-native', f.guard, Date.now() + 60_000); await f.visible.promise;
  f.accounts.cancel('cancelled-native'); f.grant.resolve(); await f.accounts.close();
  expect(f.vault.getSync('terminal:native:openai')).toBeNull();
  expect(await readdir(path.join(f.root, 'provider-login'))).toEqual([]);
  const g = await nativeFixture();
  g.accounts.begin('native-refresh', g.guard, Date.now() + 60_000); await g.visible.promise; g.grant.resolve(); await g.changed.promise;
  const refreshing = deferred(), finish = deferred(); g.beforeRefresh(async () => { refreshing.resolve(); await finish.promise; });
  vi.useFakeTimers({ toFake: ['Date'] }); vi.setSystemTime((g.expires + 1) * 1000);
  const pending = g.accounts.credential(); const rejected = expect(pending).rejects.toThrow('PROVIDER_AUTHORIZATION_CHANGED');
  await refreshing.promise; g.accounts.disconnect(); finish.resolve(); await rejected;
  expect(g.vault.getSync('terminal:native:openai')).toBeNull();
});

// Integration: account quota/reset RPCs require the selected account's native
// authentication, but their temporary auth file must never survive completion
// or a disconnect. Only synthetic credentials and the public control entry run.
it('cleans native account control credentials and rejects a result after disconnect', async () => {
  const f = await nativeFixture();
  f.accounts.begin('account-control', f.guard, Date.now() + 60_000);
  await f.visible.promise; f.grant.resolve(); await f.changed.promise;
  const logger: import('@cindy/maker-core').Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };
  expect(await f.accounts.withAccountControl(logger, async agent => {
    expect(await agent.getAuthState()).toMatchObject({ authenticated: true, authSource: 'oauth' });
    const staging = await readdir(path.join(f.root, 'provider-login'));
    expect(staging).toHaveLength(1);
    expect(JSON.parse(await readFile(path.join(f.root, 'provider-login', staging[0], 'auth.json'), 'utf8')).tokens.access_token).toBe(f.token);
    return 'account-result';
  })).toBe('account-result');
  expect(await readdir(path.join(f.root, 'provider-login'))).toEqual([]);
  const entered = deferred(), release = deferred();
  const pending = f.accounts.withAccountControl(logger, async () => { entered.resolve(); await release.promise; return 'stale-result'; });
  const rejected = expect(pending).rejects.toThrow('PROVIDER_AUTHORIZATION_CHANGED');
  await entered.promise; f.accounts.disconnect(); release.resolve(); await rejected;
  expect(await readdir(path.join(f.root, 'provider-login'))).toEqual([]);
});


// Authorization boundary: the same OS CLI login may be used only by its
// explicitly connected Cindy owner. Disconnect never logs out the native CLI.
it('binds Claude usage to one owner and rejects a stale or non-subscription grant', async () => {
  let binding: string | null = null;
  let status: Record<string, unknown> = { loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'fixture@example.invalid' };
  let beforeRead: (() => Promise<void>) | undefined;
  const calls: string[][] = [];
  const make = (owner: string) => new TerminalClaudeLogin({ owner, readBinding: () => binding, writeBinding: value => { binding = value; }, binary: async () => '/native/claude', assertCurrent() {}, changed() {},
    run: async (_binary, args, options) => {
      calls.push(args);
      expect(options?.env).not.toHaveProperty('CLAUDE_CONFIG_DIR'); expect(options?.env).not.toHaveProperty('CLAUDE_CODE_OAUTH_TOKEN');
      await beforeRead?.(); return { code: 0, stdout: JSON.stringify(status), stderr: '' };
    },
  });
  const first = make('owner-a'), second = make('owner-b');
  cleanup.push(() => first.close(), () => second.close());
  expect(await first.state()).toEqual({ authenticated: false }); expect(calls).toEqual([]);
  const firstTicket = await first.begin(); expect(firstTicket.needsLogin).toBe(false); await first.finish(firstTicket.id);
  expect(await first.state()).toMatchObject({ authenticated: true }); expect(await second.state()).toMatchObject({ authenticated: false });
  const secondTicket = await second.begin(); await second.finish(secondTicket.id);
  expect(await first.state()).toMatchObject({ authenticated: false }); expect(await second.state()).toMatchObject({ authenticated: true });
  second.disconnect(); expect(await second.state()).toMatchObject({ authenticated: false });
  const stale = await second.begin(), reading = deferred(), finish = deferred();
  beforeRead = async () => { reading.resolve(); await finish.promise; };
  const result = second.finish(stale.id); const rejected = expect(result).rejects.toThrow('PROVIDER_LOGIN_STALE');
  await reading.promise; second.disconnect(); finish.resolve(); await rejected; beforeRead = undefined;
  expect(binding).toBeNull();
  status = { loggedIn: true, authMethod: 'claude.ai', apiKeySource: 'console' };
  const consoleTicket = await second.begin(); expect(consoleTicket.needsLogin).toBe(true);
  await expect(second.finish(consoleTicket.id)).rejects.toThrow('NATIVE_SUBSCRIPTION_LOGIN_REQUIRED');
  expect(binding).toBeNull(); expect(calls.every(args => args.join(' ') === 'auth status --json')).toBe(true);
});

// Integration: SuperGrok must keep device and refresh credentials in the
// encrypted owner vault while all three engine protocols retain native search.
it('authorizes SuperGrok through a protected remote controller and revokes every engine route', async () => {
  const calls: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
  let reject = false, refreshes = 0;
  const upstream: typeof fetch = async (url, init) => {
    const address = String(url);
    if (address.includes('openid-configuration')) return Response.json({});
    if (address.endsWith('/device/code')) return Response.json({ device_code: 'grok-private-device', user_code: 'ABCD-EFGH', verification_uri: 'https://auth.x.ai/device', expires_in: 120, interval: 5 });
    if (address.endsWith('/oauth2/token')) {
      if (String(init?.body).includes('refresh_token')) refreshes++;
      return Response.json({ access_token: refreshes ? 'grok-private-refreshed' : 'grok-private-access', refresh_token: 'grok-private-refresh', expires_in: 3600 });
    }
    if (address.includes('/v1/user')) return Response.json({ userId: 'synthetic-grok-user' });
    if (address.endsWith('/v1/models')) return Response.json({ data: ['grok-fixture','grok-4.7','grok-4.7-build-fast'].map(id=>({id,name:id,context_window:128000,max_completion_tokens:4096})) });
    const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    calls.push({ url: address, headers: new Headers(init?.headers), body });
    if (reject) return Response.json({ code: 'unauthenticated:bad-credentials' }, { status: 403 });
    return Response.json({ id: 'response-fixture', object: 'response', status: 'completed', model: 'grok-fixture', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'GROK_OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const f = await fixture(upstream);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const { id } = await f.controller.channelRegistration({ command: 'begin', providerId: 'xai', deviceId: 'host' }, 'providers');
  await vi.waitFor(async () => expect((await f.controller.channelRegistration({ command: 'read', id }, 'providers')).state).toMatchObject({ status: 'pending', userCode: 'ABCD-EFGH' }));
  await vi.advanceTimersByTimeAsync(5000);
  await vi.waitFor(async () => expect((await f.controller.channelRegistration({ command: 'read', id }, 'providers')).state).toMatchObject({ status: 'success' }));
  vi.useRealTimers();
  expect(f.grok!.connected()).toBe(true);
  const views = await f.models.views();
  const provider = views.find(p => p.id === 'xai')!;
  expect(provider.connected).toBe(true);
  const handles: Array<Awaited<ReturnType<typeof createGrokProxy>>> = [];
  for (const kind of ['claude-code', 'codex', 'pi'] as const) {
    const model = provider.models[kind]!.find(m => m.id.endsWith('grok-fixture'))!;
    const chosen = await f.models.select({ providerId: 'xai', agentKind: kind, model: model.id });
    const prefs = { fast: false, reasoningEffort: 'low' };
    const proxy = await createGrokProxy({ route: chosen.route, kind, taskId: 'grok-task', accounts: f.grok!, fetch: upstream, preferences:()=>prefs });
    cleanup.push(() => proxy.close()); handles.push(proxy);
    const response = await fetch(proxy.url + (kind === 'claude-code' ? '/v1/messages' : '/responses'), {
      method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(kind === 'claude-code' ? { model: model.id, max_tokens: 512, messages: [{ role: 'user', content: 'probe' }] } : { model: model.id, input: 'probe' }),
    });
    expect(response.status).toBe(200); await response.text();
    expect(calls.at(-1)!.headers.get('authorization')).toBe('Bearer grok-private-access');
    expect(calls.at(-1)!.body.model).toBe('grok-fixture');
    expect(calls.at(-1)!.body.tools).toContainEqual({ type: 'x_search' });
    const fastParent=provider.models[kind]!.find(m=>m.id.endsWith('grok-4.7'))!;
    for(const enabled of [true,false]){
      prefs.fast=enabled;
      const response=await fetch(proxy.url+(kind==='claude-code'?'/v1/messages':'/responses'),{
        method:'POST',headers:{authorization:`Bearer ${proxy.token}`,'content-type':'application/json'},
        body:JSON.stringify(kind==='claude-code'?{model:fastParent.id,max_tokens:512,messages:[{role:'user',content:'fast probe'}]}:{model:fastParent.id,input:'fast probe'}),
      });
      expect(response.status).toBe(200);await response.text();
      expect(calls.at(-1)!.body.model).toBe(enabled?'grok-4.7-build-fast':'grok-4.7');
      expect(calls.at(-1)!.body.service_tier).toBeUndefined();
    }
  }
  const request = () => fetch(handles[1].url + '/responses', { method: 'POST', headers: { authorization: `Bearer ${handles[1].token}`, 'content-type': 'application/json' }, body: JSON.stringify({ model: provider.models.codex![0].id, input: 'probe' }) });
  reject = true; const rejected = await request(); expect(rejected.status).toBe(403); await rejected.text();
  expect(refreshes).toBe(1); expect(f.grok!.peek()).toBe('grok-private-refreshed');
  reject = false; const recovered = await request(); expect(recovered.status).toBe(200); await recovered.text();
  const reopened = new TerminalSecretStore(f.root); await reopened.open();
  expect(reopened.getSync('terminal:native:xai')).toContain('grok-private-refreshed'); reopened.lock();
  for (const secret of ['grok-private-device','grok-private-access','grok-private-refresh','grok-private-refreshed','ABCD-EFGH']) expect(JSON.stringify({ wire: f.wire, events: f.events, views })).not.toContain(secret);
  expect(await readFile(path.join(f.root, 'secrets.enc'), 'utf8')).not.toContain('grok-private');
  const auth = await f.grok!.credential();
  await f.models.disconnect('xai', () => {});
  expect(auth.canDispatch()).toBe(false); expect(f.grok!.connected()).toBe(false);
  const denied = await request(); expect(denied.status).toBe(403); await denied.text();
});

// Integration: a remote native CLI login must use the original credential home,
// keep every PTY byte encrypted, and fence cancellation during its final status read.
it('runs the original Claude login on the selected host over its protected controller', async () => {
  let output!: (data: string) => void, exit!: (value: { exitCode: number; signal?: number }) => void;
  let loggedIn = false, killed = 0;
  const sent: string[] = [], commands: string[][] = [];
  let gate: ReturnType<typeof deferred> | undefined, statusEntered: ReturnType<typeof deferred> | undefined;
  const f = await fixture(undefined, {
    run: async (_binary, args) => {
      expect(args).toEqual(['auth', 'status', '--json']);
      if (loggedIn && gate) { statusEntered?.resolve(undefined); await gate.promise; }
      return { code: 0, stdout: JSON.stringify({ loggedIn, authMethod: loggedIn ? 'claude.ai' : undefined, email: 'fixture@example.invalid' }), stderr: '' };
    },
    spawn: (command, args, options) => {
      expect(command).toBe(process.execPath); expect(args).toEqual(['auth', 'login', '--claudeai']); commands.push(args);
      expect(Object.keys(options.env ?? {}).some(key => ['CLAUDE_CONFIG_DIR','CLAUDE_CODE_OAUTH_TOKEN','ANTHROPIC_API_KEY'].includes(key.toUpperCase()))).toBe(false);
      return { pid: 1, write: (data: string) => sent.push(data), resize() {}, kill() { killed++; }, onData(callback: typeof output) { output = callback; return { dispose() {} }; }, onExit(callback: typeof exit) { exit = callback; return { dispose() {} }; } } as unknown as IPty;
    },
  });
  const begin = async () => {
    const { id } = await f.controller.channelRegistration({ command: 'begin', providerId: 'anthropic', deviceId: 'host' }, 'providers');
    await vi.waitFor(async () => expect((await f.controller.channelRegistration({ command: 'read', id }, 'providers')).state).toMatchObject({ status: 'pending', terminal: true }), { interval: 5 });
    return id;
  };
  const submit = async (id: string, callback: Record<string, unknown>) => (await f.controller.channelRegistration({ command: 'submit', id, callback }, 'providers')).state as unknown as ProviderTerminalFrame;
  const id = await begin();
  output('https://claude.ai/oauth/authorize?code=native-private-code');
  const frame = await submit(id, { op: 'read', after: 0 }); expect(frame.chunks[0].data).toContain('native-private-code');
  await submit(id, { op: 'write', data: 'native-private-input', requestId: 'write-one' });
  await submit(id, { op: 'write', data: 'native-private-input', requestId: 'write-one' });
  expect(sent).toEqual(['native-private-input']);
  loggedIn = true; exit({ exitCode: 0 });
  expect((await submit(id, { op: 'read', after: frame.cursor })).state.status).toBe('success');
  expect((await f.claudeAuth!.state()).authenticated).toBe(true);
  await f.controller.channelRegistration({ command: 'cancel', id }, 'providers');
  f.claudeAuth!.disconnect(); loggedIn = false;
  const late = await begin(); gate = deferred(); statusEntered = deferred();
  loggedIn = true; exit({ exitCode: 0 });
  const finishing = submit(late, { op: 'read', after: 0 });
  const settled = finishing.catch(() => undefined);
  await statusEntered.promise;
  await f.controller.channelRegistration({ command: 'cancel', id: late }, 'providers');
  gate.resolve(undefined); await settled;
  expect(f.secrets.getSync('terminal:native:anthropic-binding')).toBeNull();
  loggedIn = false; gate = undefined;
  const pending = await begin();
  await f.controller.channelRegistration({ command: 'cancel', id: pending }, 'providers');
  expect(killed).toBe(1); expect(commands).toHaveLength(3);
  const publicData = JSON.stringify({ wire: f.wire, events: f.events, files: await readFile(path.join(f.root, 'secrets.enc'), 'utf8') });
  expect(publicData).not.toContain('native-private-code'); expect(publicData).not.toContain('native-private-input');
});

// Integration: account selection is an authorization boundary. Real native
// staging, encrypted persistence and dispatch must keep two connections apart,
// including a failed config write and a daemon restart.
it('keeps independent ChatGPT accounts isolated through login, rollback, removal and restart', async () => {
  const f = await nativeFixture();
  const models = new TerminalModelConfig(f.root, f.vault, async () => ({ authenticated: false }));
  await models.open();
  for (const id of ['openai-a', 'openai-b']) await models.saveProvider({ id, name: id,
    auth: { method: 'oauth', native: 'codex' },
    runtimes: { codex: { baseUrl: 'https://chatgpt.com/backend-api/codex', wireProtocol: 'openai-responses', models: [] } },
  }, {}, true);
  const create = (models: TerminalModelConfig) => new TerminalSubscriptions({ root: f.root, models, secrets: f.vault,
    binary: async () => process.execPath, assertCurrent: f.guard, changed: () => models.gatewayChanged(), fetch: f.fetchLocal,
    run: async (_binary, args, opts) => {
      expect(args).toEqual(['login', '--device-auth']);
      const result = await runNative(process.execPath, [f.runner], opts);
      const file = path.join(opts!.env!.CODEX_HOME!, 'auth.json');
      const auth = JSON.parse(await readFile(file, 'utf8'));
      const providerId = path.basename(path.dirname(path.dirname(opts!.cwd!)));
      expect(['openai-a', 'openai-b']).toContain(providerId);
      auth.tokens.account_id = providerId === 'openai-a' ? 'workspace-a' : 'workspace-b';
      await writeFile(file, JSON.stringify(auth), { mode: 0o600 });
      return result;
    },
  });
  const subscriptions = create(models);
  const login = new TerminalProviderLogin({ subscriptions, models, secrets: f.vault, assertCurrent: f.guard,
    changed: () => models.gatewayChanged(), log: { info() {}, warn() {} } });
  cleanup.push(() => login.close());
  for (const id of ['openai-a', 'openai-b']) login.begin(id, id, f.guard, Date.now() + 60_000);
  await vi.waitFor(() => { for (const id of ['openai-a', 'openai-b']) expect(login.read(id)).toMatchObject({ userCode: 'ABCD-12345' }); });
  f.grant.resolve();
  await vi.waitFor(() => { for (const id of ['openai-a', 'openai-b']) expect(login.read(id).status).toBe('success'); });
  expect((await models.views()).filter(p => p.connected).map(p => p.id)).toEqual(expect.arrayContaining(['openai-a', 'openai-b']));
  expect(models.openAiAccount()!.connected()).toBe(false);
  const a = models.openAiAccount('openai-a')!, b = models.openAiAccount('openai-b')!;
  expect((await a.credential()).accountId).toBe('workspace-a');
  expect((await b.credential()).accountId).toBe('workspace-b');
  for (const id of ['openai-a', 'openai-b']) {
    expect(await readdir(path.join(f.root, 'provider-accounts', id, 'provider-login'))).toEqual([]);
    for (const kind of ['claude-code', 'codex', 'pi'] as const) {
      const provider = (await models.views()).find(p => p.id === id)!;
      const model = provider.models[kind]!.find(m => m.id.endsWith('gpt-fixture'))!;
      const { route } = await models.select({ providerId: id, agentKind: kind, model: model.id });
      const proxy = await createChatgptProxy({ route, kind, taskId: id, accounts: models.openAiAccount(id)!, fetch: f.fetchLocal });
      cleanup.push(() => proxy.close());
      const response = await fetch(proxy.url + (kind === 'claude-code' ? '/v1/messages' : '/responses'), {
        method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'claude-code' ? { model: model.id, max_tokens: 16, messages: [{ role: 'user', content: 'probe' }] } : { model: model.id.replace(/^chatgpt\//, ''), input: 'probe' }),
      });
      expect(response.status).toBe(200); await response.text();
      expect(f.calls.at(-1)!.headers['chatgpt-account-id']).toBe(id === 'openai-a' ? 'workspace-a' : 'workspace-b');
    }
  }
  const utility = new TerminalUtilityModels({ root: f.root, models, assertCurrent: f.guard, changed() {},
    log: { debug() {}, info() {}, warn() {} }, fetch: f.fetchLocal,
    native: { listAvailableAgents: () => [], getAgentAuthState: async () => ({ authenticated: false }), oneShot: async () => { throw new Error('NATIVE_FALLBACK_NOT_EXPECTED'); } },
  }); cleanup.push(() => utility.close());
  utility.configureConnections(subscriptions.utilityConnections());
  await utility.update({ models: [encodeCatalogModelPin({ providerId: 'openai-b', agentKind: 'codex', model: 'gpt-fixture' })] });
  expect(await utility.request('Short auxiliary request')).toMatchObject({ ok: true, text: 'NATIVE_BRIDGE_OK' });
  expect(f.calls.at(-1)!.headers['chatgpt-account-id']).toBe('workspace-b');
  const write = vi.spyOn(platform, 'atomicPrivateWrite').mockRejectedValueOnce(new Error('SYNTHETIC_DISK_FAILURE'));
  try { await expect(models.deleteProvider('openai-a')).rejects.toThrow('SYNTHETIC_DISK_FAILURE'); } finally { write.mockRestore(); }
  expect(a.connected()).toBe(true); expect(b.connected()).toBe(true);
  const retainedB = await b.credential();
  await models.deleteProvider('openai-a');
  expect(retainedB.canDispatch()).toBe(true);
  expect(f.vault.getSync('terminal:subscription:openai-a:terminal:native:openai')).toBeNull();
  await expect(a.credential()).rejects.toThrow('PROVIDER_AUTHORIZATION_CHANGED');
  await login.close();
  const reopened = new TerminalModelConfig(f.root, f.vault, async () => ({ authenticated: false })); await reopened.open();
  const restored = create(reopened); cleanup.push(() => restored.close());
  expect(restored.openAiAccount('openai-a')).toBeUndefined();
  expect((await restored.openAiAccount('openai-b')!.credential()).accountId).toBe('workspace-b');
  expect(await readFile(path.join(f.root, 'models.json'), 'utf8')).not.toContain(f.token);
  expect(await readFile(path.join(f.root, 'secrets.enc'), 'utf8')).not.toContain('workspace-b');
});

// Integration: remote device-code leases must select the saved account id,
// including its discovery snapshot and auth-rejection/revocation boundary.
it('keeps two protected SuperGrok device logins and model catalogs independent', async () => {
  let code = 0;
  const dispatches: string[] = [];
  const upstream: typeof fetch = async (url, init) => {
    const address = String(url), authorization = new Headers(init?.headers).get('authorization') ?? '';
    if (address.includes('openid-configuration')) return Response.json({});
    if (address.endsWith('/device/code')) { const id = ++code; return Response.json({ device_code: `private-${id}`, user_code: `CODE-${id}`, verification_uri: 'https://auth.x.ai/device', expires_in: 120, interval: 5 }); }
    if (address.endsWith('/oauth2/token')) {
      const id = new URLSearchParams(String(init?.body)).get('device_code')!.slice(-1);
      return Response.json({ access_token: `grok-private-${id}`, refresh_token: `grok-refresh-${id}`, expires_in: 3600 });
    }
    if (address.includes('/v1/user')) return Response.json({ userId: authorization });
    if (address.endsWith('/v1/models')) return Response.json({ data: [{ id: `grok-account-${authorization.slice(-1)}`, context_window: 128000 }] });
    dispatches.push(authorization);
    return Response.json({ id: 'r', object: 'response', status: 'completed', output: [{ type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'ACCOUNT_OK' }] }], usage: { input_tokens: 1, output_tokens: 1 } });
  };
  const f = await fixture(upstream, undefined, true);
  for (const id of ['xai-a', 'xai-b']) await f.models.saveProvider({ id, name: id, auth: { method: 'oauth', native: 'xai' },
    runtimes: { codex: { baseUrl: 'https://api.x.ai/v1', wireProtocol: 'openai-responses', models: [] } },
  }, {}, true);
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  const leases: string[] = [];
  for (const providerId of ['xai-a', 'xai-b']) {
    const { id } = await f.controller.channelRegistration({ command: 'begin', providerId, deviceId: 'host' }, 'providers'); leases.push(id);
    await vi.waitFor(async () => expect((await f.controller.channelRegistration({ command: 'read', id }, 'providers')).state).toMatchObject({ status: 'pending', userCode: `CODE-${leases.length}` }));
  }
  await vi.advanceTimersByTimeAsync(5000);
  for (const id of leases) await vi.waitFor(async () => expect((await f.controller.channelRegistration({ command: 'read', id }, 'providers')).state).toMatchObject({ status: 'success' }));
  vi.useRealTimers();
  expect(f.models.grokAccount()!.connected()).toBe(false);
  for (const [index, id] of ['xai-a', 'xai-b'].entries()) {
    const provider = (await f.models.views()).find(p => p.id === id)!;
    expect(provider.connected).toBe(true);
    for (const kind of ['claude-code', 'codex', 'pi'] as const) {
      const members = provider.models[kind]!.filter(m => m.id.includes('grok-account-'));
      expect(members.map(m => m.id)).toEqual([expect.stringMatching(`grok-account-${index + 1}$`)]);
      const model = members[0];
      const chosen = await f.models.select({ agentKind: kind, providerId: id, model: model.id });
      const proxy = await createGrokProxy({ route: chosen.route, kind, taskId: id, accounts: f.models.grokAccount(id)!, fetch: upstream }); cleanup.push(() => proxy.close());
      const response = await fetch(proxy.url + (kind === 'claude-code' ? '/v1/messages' : '/responses'), { method: 'POST', headers: { authorization: `Bearer ${proxy.token}`, 'content-type': 'application/json' },
        body: JSON.stringify(kind === 'claude-code' ? { model: model.id, max_tokens: 16, messages: [{ role: 'user', content: 'probe' }] } : { model: model.id, input: 'probe' }),
      });
      expect(response.status).toBe(200); await response.text(); expect(dispatches.at(-1)).toBe(`Bearer grok-private-${index + 1}`);
    }
  }
  const utility = new TerminalUtilityModels({ root: f.root, models: f.models, assertCurrent() {}, changed() {},
    log: { debug() {}, info() {}, warn() {} }, fetch: upstream,
    native: { listAvailableAgents: () => [], getAgentAuthState: async () => ({ authenticated: false }), oneShot: async () => { throw new Error('NATIVE_FALLBACK_NOT_EXPECTED'); } },
  }); cleanup.push(() => utility.close());
  utility.configureConnections(f.subscriptions!.utilityConnections());
  const auxiliaryModel = (await f.models.views()).find(p => p.id === 'xai-b')!.models.codex!.find(m => m.id.endsWith('grok-account-2'))!.id;
  await utility.update({ models: [encodeCatalogModelPin({ providerId: 'xai-b', agentKind: 'codex', model: auxiliaryModel })] });
  expect(await utility.request('Short auxiliary request')).toMatchObject({ ok: true, text: 'ACCOUNT_OK' });
  expect(dispatches.at(-1)).toBe('Bearer grok-private-2');
  const b = f.models.grokAccount('xai-b')!, retained = await b.credential();
  const write = vi.spyOn(platform, 'atomicPrivateWrite').mockRejectedValueOnce(new Error('SYNTHETIC_DISK_FAILURE'));
  try { await expect(f.models.deleteProvider('xai-a')).rejects.toThrow('SYNTHETIC_DISK_FAILURE'); } finally { write.mockRestore(); }
  expect(f.models.grokAccount('xai-a')!.connected()).toBe(true);
  await f.models.deleteProvider('xai-a');
  expect(b.connected()).toBe(true); expect(retained.canDispatch()).toBe(true);
  expect(f.secrets.getSync('terminal:subscription:xai-a:terminal:native:xai')).toBeNull();
  const wire = JSON.stringify({ wire: f.wire, events: f.events });
  expect(wire).not.toContain('grok-private-'); expect(wire).not.toContain('CODE-');
  f.revoke(); expect(retained.canDispatch()).toBe(false);
});

// Native Linux CI: a fresh independent account raced its directory recovery,
// so successful discovery failed while publishing openai-models.json. Behavior
// tier: delay the real directory creation, without timers or a native login.
it('waits for new account storage before publishing model discovery', async () => {
  const parent = await mkdtemp(path.join(os.tmpdir(), 'cindy-account-discovery-'));
  const root = path.join(parent, 'new-account'), entered = deferred(), release = deferred();
  const original = platform.privateDirectory;
  const mkdir = vi.spyOn(platform, 'privateDirectory').mockImplementation(async directory => {
    if (directory === path.join(root, 'provider-login')) { entered.resolve(); await release.promise; }
    return original(directory);
  });
  const discovery = vi.fn(async () => new Response(JSON.stringify({models:[{slug:'gpt-5.4-mini',display_name:'Fixture',visibility:'list',supported_in_api:true,context_window:128000}]}), {headers:{'content-type':'application/json'}}));
  const account = new TerminalNativeAccounts({root,assertCurrent(){},changed(){},binary:async()=>null,fetch:discovery,
    secrets:{getSync:()=>JSON.stringify({tokens:{access_token:'synthetic-account',account_id:'fixture-owner'}}),setSync(){},deleteSync(){}}});
  const result=account.models();
  void result.catch(()=>{});
  try{
    await entered.promise;await new Promise<void>(resolve=>setImmediate(resolve));
    expect(discovery).not.toHaveBeenCalled();
    release.resolve();
    expect(await result).toEqual(expect.arrayContaining([expect.objectContaining({id:'gpt-5.4-mini'})]));
    expect(JSON.parse(await readFile(path.join(root,'openai-models.json'),'utf8')).models).toEqual(await result);
  }finally{release.resolve();await result.catch(()=>{});await account.close();mkdir.mockRestore();await rm(parent,{recursive:true,force:true});}
});

// Integration: a generic bridge 401 used to erase the subscription. Exercise the
// actual Node proxy: only explicit revocation of its current token signs it out.
it('preserves a native subscription on a generic 401 and invalidates an explicit revocation', async () => {
  const f = await nativeFixture();
  await f.accounts.ready;
  f.vault.setSync('terminal:native:openai', JSON.stringify({auth_mode:'chatgpt',tokens:{access_token:f.token,refresh_token:'synthetic-refresh',account_id:'synthetic-workspace'}}));
  const models = new TerminalModelConfig(f.root, f.vault, async () => ({authenticated:false}));
  await models.open(); models.connectNative(f.accounts);
  const provider = (await models.views()).find(p => p.id === 'openai')!;
  const model = provider.models.codex!.find(m => !m.disabled)!;
  const {route} = await models.select({agentKind:'codex',providerId:'openai',model:model.id});
  const proxy = await createChatgptProxy({route,kind:'codex',taskId:'revocation-fixture',accounts:f.accounts,fetch:f.fetchLocal});
  cleanup.push(() => proxy.close());
  const send = async () => {
    const response = await fetch(proxy.url+'/responses',{method:'POST',headers:{authorization:`Bearer ${proxy.token}`,'content-type':'application/json'},body:JSON.stringify({model:model.id,input:[],stream:false,store:false})});
    await response.text(); return response.status;
  };
  f.failAuth({status:401,body:JSON.stringify({error:{message:'This account cannot access this route'}})});
  expect(await send()).toBe(401);
  expect(f.accounts.connected()).toBe(true);
  f.failAuth({status:403,body:JSON.stringify({error:{code:'token_revoked'}})});
  expect(await send()).toBe(403);
  expect(f.accounts.connected()).toBe(false);
});
