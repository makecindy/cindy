import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../interfaces/logger.js';
import { CodexAgent } from './index.js';

// Explicit opt-in: never discover a user's installed runtime or credentials.
const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = {
  trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
  child: () => logger,
};

describe.skipIf(!binaryPath)('CodexAgent disk OAuth isolation with real app-server', () => {
  it.each([false, true])('completes a custom Responses turn with revoked OAuth=%s', async (revoked) => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-codex-host-auth-'));
    const home = path.join(root, 'codex');
    const workingDir = path.join(root, 'work');
    await mkdir(home);
    await mkdir(workingDir);
    const calls: string[] = [];
    const server = createServer(async (req, res) => {
      for await (const chunk of req) void chunk;
      calls.push(`${req.method} ${req.url}`);
      if (req.url === '/provider/responses') {
        expect(req.headers.authorization).toBe('Bearer synthetic-invalid-api-key');
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        const events = [
          { type: 'response.created', response: { id: 'response-fixture' } },
          { type: 'response.output_item.done', item: { type: 'message', role: 'assistant', id: 'message-fixture', content: [{ type: 'output_text', text: 'fixture complete' }] } },
          { type: 'response.completed', response: { id: 'response-fixture', usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
        ];
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      } else {
        res.writeHead(401, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: { code: req.url === '/oauth/token' ? 'refresh_token_invalidated' : 'unauthorized', message: 'synthetic revoked token' } }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const authPath = path.join(home, 'auth.json');
    let authFixture: string | undefined;
    if (revoked) {
      const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
      authFixture = JSON.stringify({
        auth_mode: 'chatgpt', OPENAI_API_KEY: null,
        tokens: {
          id_token: `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ email: 'fixture@example.invalid', 'https://api.openai.com/auth': { chatgpt_plan_type: 'business', chatgpt_user_id: 'fixture-user', chatgpt_account_id: 'fixture-account' } })}.c3ludGhldGlj`,
          access_token: 'synthetic-invalid-access-token', refresh_token: 'synthetic-invalid-refresh-token', account_id: 'fixture-account',
        }, last_refresh: new Date().toISOString(),
      });
      await writeFile(authPath, authFixture, { mode: 0o600 });
    }
    await writeFile(path.join(home, 'config.toml'), [
      'model="fixture-model"', 'model_provider="fixture"', 'cli_auth_credentials_store="file"',
      `chatgpt_base_url="${endpoint}"`, 'check_for_update_on_startup=false',
      '[analytics]', 'enabled=false',
      '[mcp_servers.cindy_memory]', 'command="/usr/bin/false"', 'enabled=false',
      '[model_providers.fixture]', 'name="Fixture"', `base_url="${endpoint}/provider"`,
      'wire_api="responses"', 'env_key="FIXTURE_API_KEY"', 'requires_openai_auth=false', 'supports_websockets=false', 'request_max_retries=0',
    ].join('\n'));
    const agent = new CodexAgent({
      binaryPath: binaryPath!, logger, runtimeConfig: {},
      resolveCodexOfficialOAuthDependency: (providerId) => providerId === 'cprov-fixture' ? false : undefined,
      prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
        getAuthEnv: async () => ({
          HOME: root, CODEX_HOME: home, TMPDIR: root, FIXTURE_API_KEY: 'synthetic-invalid-api-key',
          OPENAI_API_KEY: '', CODEX_API_KEY: '',
          CODEX_REFRESH_TOKEN_URL_OVERRIDE: `${endpoint}/oauth/token`,
          HTTP_PROXY: endpoint, HTTPS_PROXY: endpoint, ALL_PROXY: endpoint, NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    try {
      if (revoked) {
        await expect(agent.startSession({ sessionId: 'official-revoked', providerId: 'openai', model: 'fixture-model', workingDir })).rejects.toThrow(/refresh|revoked|logged out/i);
        expect(calls.some((call) => call.includes('/oauth/token'))).toBe(true);
      }
      const cloudCallsBeforeCustom = calls.filter((call) => call.includes('/oauth/token') || call.includes('/config/bundle'));
      const handle = await agent.startSession({ sessionId: `fixture-${revoked}`, providerId: 'cprov-fixture', model: 'fixture-model', workingDir });
      const events = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'error') throw new Error(JSON.stringify(event));
          if (event.type === 'done') return;
        }
      })();
      await handle.send({ type: 'user', content: 'return fixture complete' }, { throwOnStartFailure: true });
      await expect.poll(() => calls.filter((call) => call === 'POST /provider/responses').length, { timeout: 10_000 }).toBe(1);
      expect(calls.filter((call) => call.includes('/oauth/token') || call.includes('/config/bundle'))).toEqual(cloudCallsBeforeCustom);
      if (authFixture) expect(await readFile(authPath, 'utf8')).toBe(authFixture);
      await events;
      await handle.close();
    } finally {
      await agent.dispose();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    }
  }, 45_000);
});
