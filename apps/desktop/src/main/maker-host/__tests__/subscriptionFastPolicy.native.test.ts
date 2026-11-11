/** Opt in with CINDY_TEST_CODEX_BINARY; uses a temporary home and loopback upstream, never real credentials. */
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { CodexAgent, withFastModePolicy, type Logger } from '@cindy/maker-core';
import { createAnthropicCompatProxy } from '@cindy/anthropic-compat-proxy';
import { withSubscriptionFastRequestPolicy } from '../subscription-fast-request-policy.js';

const state = vi.hoisted(() => ({ allowed: true, suppressed: false }));
vi.mock('../subscription-fast-policy.js', () => ({
  createSubscriptionFastPolicy: () => ({
    isAllowed: () => state.allowed,
    isRequestAllowed: () => state.allowed && !state.suppressed,
  }),
}));
vi.mock('../active-catalog.js', () => ({
  getActiveCatalog: () => ({
    providers: [{ id: 'cprov-fixture', auth: { method: 'oauth', native: 'codex' } }],
  }),
}));

const binaryPath = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => logger,
};

describe.skipIf(!binaryPath)('native Codex subscription speed enforcement', () => {
  it('changes actual Responses bodies to standard, clamps stale re-enables and keeps standard after relaxation', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-fast-native-test-'));
    const home = path.join(root, 'codex');
    const workingDir = path.join(root, 'work');
    await mkdir(home);
    await mkdir(workingDir);
    const requests: Array<Record<string, unknown>> = [];
    let prohibitDuringTurn: (() => Promise<void>) | undefined;
    let relaxDuringTurn: (() => Promise<void>) | undefined;
    const server = createServer(async (req, res) => {
      let body = '';
      for await (const chunk of req) body += chunk;
      if (req.url === '/provider/responses') {
        requests.push(JSON.parse(body));
        const toolLoop = requests.length === 2 || requests.length === 3;
        if (requests.length === 2) await prohibitDuringTurn!();
        if (requests.length === 3) await relaxDuringTurn!();
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(
          [
            { type: 'response.created', response: { id: `response-${requests.length}` } },
            {
              type: 'response.output_item.done',
              item: toolLoop
                ? {
                    type: 'function_call',
                    call_id: `fixture-tool-${requests.length}`,
                    name: 'exec_command',
                    arguments: JSON.stringify({
                      cmd: 'echo fast-policy-fixture',
                      max_output_tokens: 20,
                    }),
                  }
                : {
                    type: 'message',
                    role: 'assistant',
                    id: 'fixture-message',
                    content: [{ type: 'output_text', text: 'fixture complete' }],
                  },
            },
            {
              type: 'response.completed',
              response: {
                id: `response-${requests.length}`,
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          ]
            .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
            .join(''),
        );
      } else {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ models: [] }));
      }
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const proxy = await createAnthropicCompatProxy({
      upstream: `${endpoint}/provider`,
      transformRequest: [],
      routingTransform: () =>
        withSubscriptionFastRequestPolicy(null, {
          sessionId: 'native-fast-policy',
          providerId: 'cprov-fixture',
        }),
    });
    await writeFile(
      path.join(home, 'config.toml'),
      [
        'model="gpt-6.1-sol"',
        'model_provider="fixture"',
        'cli_auth_credentials_store="file"',
        `chatgpt_base_url="${endpoint}"`,
        'check_for_update_on_startup=false',
        '[analytics]',
        'enabled=false',
        '[mcp_servers.cindy_memory]',
        'command="unused-fixture-command"',
        'enabled=false',
        '[model_providers.fixture]',
        'name="Fixture"',
        `base_url="${proxy.url}"`,
        'wire_api="responses"',
        'requires_openai_auth=true',
        'supports_websockets=false',
        'request_max_retries=0',
      ].join('\n'),
    );
    state.allowed = true;
    state.suppressed = false;
    let update: (() => Promise<void>) | undefined;
    const policy = {
      isAllowed: () => state.allowed,
      onFastModeChanged: (enabled: boolean | 'ultrafast') => {
        state.suppressed = !enabled;
      },
      subscribe: (listener: () => Promise<void>) => {
        update = listener;
        return () => {};
      },
    };
    const token = `test.${Buffer.from(
      JSON.stringify({
        exp: 4102444800,
        'https://api.openai.com/auth': { chatgpt_account_id: 'fixture', chatgpt_plan_type: 'pro' },
      }),
    ).toString('base64url')}.synthetic`;
    await writeFile(
      path.join(home, 'auth.json'),
      JSON.stringify({
        auth_mode: 'chatgpt',
        tokens: {
          id_token: token,
          access_token: token,
          refresh_token: 'synthetic-refresh',
          account_id: 'fixture',
        },
        last_refresh: new Date().toISOString(),
      }),
    );
    const agent = new CodexAgent({
      binaryPath: binaryPath!,
      logger,
      runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => 'legacy-shared',
      prepareCodexExtraSpawnConfig: async () => ({
        extraArgs: [],
        extraEnv: {},
        codexProxyActive: true,
      }),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({
          HOME: root,
          USERPROFILE: root,
          CODEX_HOME: home,
          TMPDIR: root,
          TEMP: root,
          TMP: root,
          FIXTURE_API_KEY: 'synthetic-invalid-api-key',
          OPENAI_API_KEY: '',
          CODEX_API_KEY: '',
          HTTP_PROXY: endpoint,
          HTTPS_PROXY: endpoint,
          ALL_PROXY: endpoint,
          NO_PROXY: '127.0.0.1,localhost',
        }),
      },
    });
    try {
      const handle = withFastModePolicy(
        await agent.startSession({
          sessionId: 'native-fast-policy',
          providerId: 'cprov-fixture',
          model: 'gpt-6.1-sol',
          workingDir,
          fastMode: true,
          fastModePolicy: policy,
        }),
        policy,
      );
      let done = 0;
      const errors: unknown[] = [];
      const events = (async () => {
        for await (const event of handle.events()) {
          if (event.type === 'done') done++;
          if (event.type === 'error') errors.push(event);
        }
      })();
      const turn = async () => {
        const target = done + 1;
        await handle.send(
          { type: 'user', content: 'return fixture complete' },
          { throwOnStartFailure: true },
        );
        await expect.poll(() => done, { timeout: 15_000 }).toBe(target);
        expect(errors).toEqual([]);
      };
      await turn();
      expect(requests[0].service_tier).toBe('priority'); // Positive control: the real binary can send Fast.
      prohibitDuringTurn = async () => {
        state.allowed = false;
        await update!();
      };
      relaxDuringTurn = async () => {
        state.allowed = true;
        await update!();
      };
      await turn();
      expect(requests[1].service_tier).toBe('priority'); // Already admitted before the switch.
      expect(requests[2].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function_call_output', call_id: 'fixture-tool-2' }),
        ]),
      );
      expect(requests[3].input).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: 'function_call_output', call_id: 'fixture-tool-3' }),
        ]),
      );
      state.allowed = false;
      await update!();
      await handle.setFastMode!('ultrafast');
      await turn();
      state.allowed = true;
      await update!();
      await turn();
      expect(requests).toHaveLength(6);
      expect(
        requests
          .slice(2)
          .every(
            (body) =>
              body.service_tier === undefined ||
              body.service_tier === null ||
              body.service_tier === 'default',
          ),
      ).toBe(true);
      await handle.setFastMode!(true);
      await turn();
      expect(requests[6].service_tier).toBe('priority');
      await handle.close();
      await events;
    } finally {
      await agent.dispose();
      await proxy.dispose();
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
        server.closeAllConnections();
      });
      await rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
    }
  }, 60_000);
});
