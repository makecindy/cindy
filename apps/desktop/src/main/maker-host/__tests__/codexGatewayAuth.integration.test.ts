import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { buildUserProvider } from '@cindy/model-providers';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import type { AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

const fixture = vi.hoisted(() => ({ userData: '', home: '', gatewayKey: 'synthetic-gateway-key' }));
vi.mock('electron', () => ({ app: {
  isPackaged: true,
  getPath: (name: string) => name === 'home' ? fixture.home : fixture.userData,
  getAppPath: () => fixture.userData,
}, safeStorage: { isEncryptionAvailable: () => false } }));
vi.mock('../../appCapabilities.js', () => ({ getAppCapabilities: () => ({ canUseCindyGateway: true }) }));
vi.mock('../../secrets/providerSecretStore.js', () => ({ getProviderSecretStore: () => ({ get: () => fixture.gatewayKey }) }));
vi.mock('../../appSessionState.js', async (original) => ({
  ...await original<typeof import('../../appSessionState.js')>(),
  getActiveAppSession: () => ({ mode: 'cloud', dataOwnerId: 'synthetic-owner', generation: 1 }),
  activeOwnerScopeKey: () => 'cloud:synthetic-owner:1',
  isAppSessionBoundaryPending: () => false,
}));

const binary = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger };

describe.skipIf(!binary)('first-profile gateway/API startup with native Codex', () => {
  it.each(['none', 'fresh-revoked', 'expired-refreshable', 'expired-revoked', 'healthy-concurrent', 'revoked-concurrent'].flatMap((auth) =>
    ['xd', 'cprov-key'].map((providerId) => ({ auth, providerId })),
  ))('$providerId remains independent of $auth local OAuth across startup/resume/401', async ({ auth, providerId }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-gateway-native-'));
    fixture.home = path.join(root, 'home');
    fixture.userData = path.join(root, 'profile');
    fixture.gatewayKey = providerId === 'xd' ? 'synthetic-gateway-key' : '';
    fs.mkdirSync(path.join(fixture.home, '.codex'), { recursive: true });
    fs.mkdirSync(fixture.userData, { recursive: true });
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(fixture.home);
    const calls: string[] = [];
    let rejectApi = false;
    let officialAccessToken = '';
    const concurrent = auth.endsWith('-concurrent');
    let sequence = 0;
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls.push(`${req.method} ${req.url}`);
      if (auth === 'healthy-concurrent' && req.url?.startsWith('/models')) {
        res.writeHead(200, { 'content-type': 'application/json' }).end('{"models":[]}');
        return;
      }
      if (req.url?.endsWith('/responses')) {
        expect([`Bearer ${providerId === 'xd' ? fixture.gatewayKey : 'synthetic-custom-key'}`, ...(concurrent ? [`Bearer ${officialAccessToken}`] : [])]).toContain(req.headers.authorization);
        if (rejectApi && req.headers.authorization !== `Bearer ${officialAccessToken}`) {
          res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"message":"synthetic API rejection"}}');
          return;
        }
        const id = `fixture-${++sequence}`;
        const events = [
          { type: 'response.created', response: { id } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: `msg-${id}`, content: [{ type: 'output_text', text: 'synthetic complete' }] } },
          { type: 'response.completed', response: { id, usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
        return;
      }
      if (req.url === '/oauth/token' && auth === 'expired-refreshable') {
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ access_token: 'synthetic-refreshed', refresh_token: 'synthetic-refresh' }));
        return;
      }
      if (auth === 'healthy-concurrent') {
        res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":{"message":"No optional MCP endpoint in fixture"}}');
        return;
      }
      res.writeHead(401, { 'content-type': 'application/json' }).end('{"error":{"code":"refresh_token_invalidated","message":"synthetic revoked token"}}');
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const systemAuth = path.join(fixture.home, '.codex', 'auth.json');
    let originalAuth: string | undefined;
    if (auth !== 'none') {
      const claims = { sub: 'synthetic-user', exp: Math.floor(Date.now() / 1000) + (auth.startsWith('expired') ? -3600 : 3600), 'https://api.openai.com/auth': { chatgpt_plan_type: auth === 'healthy-concurrent' ? 'plus' : 'business', chatgpt_account_id: 'synthetic-account' } };
      const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.synthetic`;
      officialAccessToken = token;
      originalAuth = JSON.stringify({ auth_mode: 'chatgpt', tokens: { access_token: token, id_token: token, refresh_token: 'synthetic-invalid-refresh', account_id: 'synthetic-account' }, last_refresh: new Date(auth.startsWith('expired') ? 0 : Date.now()).toISOString() });
      fs.writeFileSync(systemAuth, originalAuth, { mode: 0o600 });
    }
    const { DesktopCodexAuthAdapter, getCodexHome } = await import('../auth-adapters.js');
    const { captureCodexLocalAuthPolicy } = await import('../provider-route.js');
    const { setCustomProviders } = await import('../active-catalog.js');
    const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');
    const diagnostics: unknown[] = [];
    const testLogger: Logger = { ...logger, debug: (...args) => { diagnostics.push(args); }, warn: (...args) => { diagnostics.push(args); }, error: (...args) => { diagnostics.push(args); }, child: () => testLogger };
    const adapter = new DesktopCodexAuthAdapter();
    let agent: CodexAgent | undefined;
    try {
      // This is the production first-profile reconcile, not an auth-state stub.
      const detected = await adapter.getState();
      if (originalAuth) expect(detected).toMatchObject({ authenticated: true, authSource: 'oauth' });
      const codexHome = getCodexHome();
      fs.mkdirSync(codexHome, { recursive: true });
      if (originalAuth) expect(fs.readFileSync(path.join(codexHome, 'auth.json'), 'utf8')).toBe(originalAuth);
      fs.writeFileSync(path.join(codexHome, 'config.toml'), `chatgpt_base_url="${endpoint}"\ncheck_for_update_on_startup=false\n[analytics]\nenabled=false\n[mcp_servers.cindy_memory]\ncommand="/usr/bin/false"\nenabled=false\n`);
      setCustomProviders([buildUserProvider({ id: 'cprov-key', name: 'Synthetic', runtimes: { codex: { baseUrl: endpoint, wireProtocol: 'openai-responses', models: [{ id: 'fixture-model', name: 'Fixture' }] } } })]);
      const modes: string[] = [];
      agent = new CodexAgent({
        binaryPath: binary!, auth: adapter, logger: testLogger,
        isolateCodexAccountSessions: true,
        resolveCodexLocalAuthPolicy: captureCodexLocalAuthPolicy,
        runtimeConfig: { behaviorFlags: { HOME: fixture.home, TMPDIR: root, CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token`, HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost' } },
        prepareCodexExtraSpawnConfig: async (_providers, ctx) => {
          modes.push(ctx.credentialMode ?? 'fallback');
          if (ctx.credentialMode !== 'oauth-bearer') expect(ctx.localAuthPolicy).toBe('isolated');
          return { extraArgs: buildCodexProxySpawnArgs(endpoint, ctx.credentialMode === 'oauth-bearer' ? 'oauth-bearer' : ctx.credentialMode === 'gateway-key' ? 'env-key' : 'provider-oauth'), extraEnv: { ...(providerId !== 'xd' ? { XDT_CODEX_API_KEY: 'synthetic-custom-key' } : {}) }, codexProxyActive: true };
        },
      });
      const send = async (handle: AgentSessionHandle, fail = false) => {
        const events = (async () => {
          for await (const event of handle.events()) {
            if (event.type === 'error') { if (fail) return 'error'; throw new Error('unexpected synthetic turn failure'); }
            if (event.type === 'done') return 'done';
          }
        })();
        await handle.send({ type: 'user', content: 'return synthetic complete' }, { throwOnStartFailure: true });
        expect(await events).toBe(fail ? 'error' : 'done');
      };
      const options = { sessionId: 'same-task', providerId, model: 'fixture-model', workingDir: root };
      if (concurrent) {
        // Exercise concurrent hosts against an existing native history database.
        // Empty-database migration concurrency is a separate native startup boundary;
        // the non-concurrent cases above cover first-profile OAuth reconciliation.
        const seed = await agent.startSession({ ...options, sessionId: 'initial-native-profile' });
        await seed.close();
      }
      const officialStart = concurrent
        ? agent.startSession({ ...options, sessionId: 'official-task', providerId: 'openai' }).then((handle) => ({ handle }), (error: unknown) => ({ error }))
        : undefined;
      const handle = await agent.startSession(options);
      const official = await officialStart;
      if (auth === 'healthy-concurrent') expect(official).toHaveProperty('handle');
      if (auth === 'revoked-concurrent') expect(official).toHaveProperty('error');
      const oauthCalls = calls.filter((call) => call.includes('/oauth/token') || call.includes('/config/bundle'));
      if (official && 'handle' in official) await send(official.handle);
      await send(handle); await send(handle);
      const threadId = handle.id;
      await handle.close();
      const resumed = await agent.startSession({ ...options, resumeSessionId: threadId });
      expect(resumed.id).toBe(threadId);
      await send(resumed);
      rejectApi = true;
      await send(resumed, true);
      await resumed.close();
      if (official && 'handle' in official) { await send(official.handle); await official.handle.close(); }
      expect(modes.filter(mode => mode !== 'oauth-bearer').every((mode) => mode === (providerId === 'xd' ? 'gateway-key' : 'provider-oauth'))).toBe(true);
      expect(calls.filter((call) => call.includes('/oauth/token') || call.includes('/config/bundle'))).toEqual(oauthCalls);
      if (!concurrent) expect(oauthCalls).toEqual([]);
      if (auth === 'revoked-concurrent') expect(oauthCalls.length).toBeGreaterThan(0);
      if (originalAuth) expect(fs.readFileSync(systemAuth, 'utf8')).toBe(originalAuth);
    } catch (error) {
      throw new Error(`${String(error)}\n${JSON.stringify(diagnostics)}`, { cause: error });
    } finally {
      await agent?.dispose();
      setCustomProviders([]);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      homeSpy.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
