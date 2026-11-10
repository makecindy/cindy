/**
 * Real proxy/socket regression for XD gateway tool lowering and replay.
 * Set CINDY_TEST_CODEX_BINARY to also exercise the real Codex process.
 * The upstream and credentials are synthetic; no developer account is used.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { describe, expect, it, vi } from 'vitest';
import { CodexAgent } from '../../../../../../packages/maker-core/src/agents/codex/index.js';
import type { AgentSessionHandle } from '../../../../../../packages/maker-core/src/agents/base-agent.js';
import type { Logger } from '../../../../../../packages/maker-core/src/interfaces/logger.js';

const fixture = vi.hoisted(() => ({ root: '', gateway: '' }));
vi.mock('electron', () => ({
  app: {
    isPackaged: true,
    getPath: () => fixture.root,
    getAppPath: () => fixture.root,
  },
  safeStorage: { isEncryptionAvailable: () => false },
}));
vi.mock('../../appCapabilities.js', () => ({
  getAppCapabilities: () => ({ canUseCindyGateway: true }),
}));
vi.mock('../../clientEndpointsService.js', async () => {
  const { TEST_CLIENT_ENDPOINTS } = await import('../../../test/vitest/clientEndpointsFixture');
  return {
    getClientEndpoint: (key: keyof typeof TEST_CLIENT_ENDPOINTS) => TEST_CLIENT_ENDPOINTS[key],
  };
});
vi.mock('../../model-access/effectiveEndpoint.js', () => ({
  effectiveXdGatewayBaseUrl: () => fixture.gateway,
}));
vi.mock('../../logger.js', () => ({
  createLogger: () => ({ trace() {}, debug() {}, info() {}, warn() {}, error() {} }),
  getLogLevel: () => 'info',
  getLogDir: () => fixture.root,
}));
vi.mock('@cindy/anthropic-compat-proxy', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cindy/anthropic-compat-proxy')>();
  return {
    ...actual,
    createAnthropicCompatProxy: (
      options: Parameters<typeof actual.createAnthropicCompatProxy>[0],
    ) => actual.createAnthropicCompatProxy({ ...options, resolveOutboundProxy: () => null }),
  };
});

const binary = process.env.CINDY_TEST_CODEX_BINARY;
const logger: Logger = {
  trace() {},
  debug() {},
  info() {},
  warn() {},
  error() {},
  fatal() {},
  child: () => logger,
};
const fixtureContents = 'synthetic-xd-gateway-tool-result';

describe.skipIf(!binary)('native Codex through the Cindy XD gateway proxy', () => {
  it.each(['x-ai-grok/grok-4.7', 'deepseek/deepseek-v4.1-flash'])(
    'executes a tool and replays its history for %s',
    async (model) => {
      fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-xd-gateway-native-'));
      const home = path.join(fixture.root, 'home');
      const codex = path.join(fixture.root, 'codex');
      const work = path.join(fixture.root, 'work');
      for (const dir of [home, codex, work]) fs.mkdirSync(dir);
      fs.writeFileSync(path.join(work, 'fixture.txt'), fixtureContents);
      const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(home);
      const requests: Array<Record<string, unknown>> = [];
      const failures: unknown[] = [];
      let execFunctionName = '';
      const command =
        process.platform === 'win32'
          ? "Get-Content -LiteralPath 'fixture.txt' -Raw"
          : "cat 'fixture.txt'";
      const code = [
        'const result = typeof tools.exec_command === "function"',
        '  ? await tools.exec_command(' + JSON.stringify({ cmd: command }) + ')',
        '  : await tools.shell_command(' + JSON.stringify({ command }) + ');',
        'text(JSON.stringify(result));',
      ].join('\n');
      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          if (req.method !== 'POST' || req.url !== '/v1/responses') {
            res.writeHead(404).end();
            return;
          }
          const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
            string,
            unknown
          >;
          requests.push(body);
          expect(req.headers.authorization).toBe('Bearer synthetic-gateway-key');
          expect(body.model).toBe(model);
          let item: Record<string, unknown>;
          if (requests.length === 1) {
            const tools = Array.isArray(body.tools)
              ? (body.tools as Array<Record<string, unknown>>)
              : [];
            const execFunction = tools.find((tool) => {
              const parameters = tool.parameters as { required?: string[] } | undefined;
              return tool.type === 'function' && parameters?.required?.includes('input');
            });
            execFunctionName = typeof execFunction?.name === 'string' ? execFunction.name : '';
            expect(execFunctionName).not.toBe('');
            const args = JSON.stringify({ input: code });
            item = {
              id: 'fc_exec_call_1',
              type: 'function_call',
              status: 'completed',
              call_id: 'exec-call-1',
              name: execFunctionName,
              arguments: args,
            };
          } else if (requests.length === 2) {
            item = {
              id: 'msg_gateway_result',
              type: 'message',
              status: 'completed',
              role: 'assistant',
              content: [{ type: 'output_text', text: fixtureContents }],
            };
          } else {
            throw new Error('Unexpected extra gateway request');
          }
          const responseId = 'synthetic-response-' + requests.length;
          const events: unknown[] = [{ type: 'response.created', response: { id: responseId } }];
          if (item.type === 'function_call') {
            events.push(
              {
                type: 'response.output_item.added',
                output_index: 0,
                item: { ...item, status: 'in_progress', arguments: '' },
              },
              {
                type: 'response.function_call_arguments.done',
                item_id: item.id,
                output_index: 0,
                arguments: item.arguments,
              },
            );
          }
          events.push(
            { type: 'response.output_item.done', output_index: 0, item },
            {
              type: 'response.completed',
              response: {
                id: responseId,
                status: 'completed',
                output: [item],
                usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 },
              },
            },
          );
          res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
          res.end(
            events
              .map(
                (event) =>
                  'event: ' +
                  (event as { type: string }).type +
                  '\ndata: ' +
                  JSON.stringify(event) +
                  '\n\n',
              )
              .join(''),
          );
        } catch (error) {
          failures.push(error);
          res.writeHead(500).end('Synthetic gateway failure');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      fixture.gateway = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      const catalog = await import('../active-catalog.js');
      const routing = await import('../provider-route.js');
      const proxy = await import('../codex-proxy-host.desktop.js');
      const sessions = await import('../session-provider-store.js');
      const { buildCodexProxySpawnArgs } = await import('../codex-gateway-config.js');
      let agent: CodexAgent | undefined;
      let handle: AgentSessionHandle | undefined;
      try {
        catalog.setXdGatewayModels([{ id: model, agents: ['codex'] }]);
        sessions.setSessionProvider('native-xd-gateway', 'xd');
        proxy.setCodexProxyAuthInjection('env-key');
        proxy.setCodexProxyGatewayKeyReader(() => 'synthetic-gateway-key');
        await proxy.ensureCodexProxyReady();
        fs.writeFileSync(
          path.join(codex, 'config.toml'),
          [
            'check_for_update_on_startup=false',
            'chatgpt_base_url=' + JSON.stringify(fixture.gateway),
            '[analytics]',
            'enabled=false',
            '[features]',
            'plugins=false',
            'remote_plugin=false',
            '[mcp_servers.cindy_memory]',
            'command="false"',
            'enabled=false',
          ].join('\n'),
        );
        const env = {
          HOME: home,
          USERPROFILE: home,
          CODEX_HOME: codex,
          TMPDIR: fixture.root,
          OPENAI_API_KEY: '',
          CODEX_API_KEY: '',
          XDT_CODEX_API_KEY: 'synthetic-gateway-key',
          HTTP_PROXY: 'http://127.0.0.1:9',
          HTTPS_PROXY: 'http://127.0.0.1:9',
          ALL_PROXY: 'http://127.0.0.1:9',
          NO_PROXY: '127.0.0.1,localhost',
        };
        agent = new CodexAgent({
          binaryPath: binary!,
          logger,
          auth: {
            getState: async () => ({ authenticated: true }),
            triggerLogin: async () => ({ authenticated: true }),
            logout: async () => {},
            getAuthEnv: async () => env,
          },
          runtimeConfig: { behaviorFlags: env },
          resolveCodexLocalAuthPolicy: routing.captureCodexLocalAuthPolicy,
          prepareCodexExtraSpawnConfig: async () => ({
            extraArgs: [
              ...buildCodexProxySpawnArgs(proxy.getCodexProxyEndpoint(), 'env-key'),
              '-c',
              'model_providers.cindy_gateway.request_max_retries=0',
              '-c',
              'model_providers.cindy_gateway.stream_max_retries=0',
            ],
            extraEnv: {},
            codexProxyActive: true,
          }),
          registerCodexSystemPromptForThread: ({ sessionId, threadId, text, ...options }) =>
            proxy.registerComposed(sessionId, threadId, text, options),
        });
        handle = await agent.startSession({
          sessionId: 'native-xd-gateway',
          providerId: 'xd',
          model,
          workingDir: work,
          permissionMode: 'bypassPermissions',
          makerMemoryEnabled: false,
        });
        const events: string[] = [];
        const complete = (async () => {
          for await (const event of handle!.events()) {
            events.push(JSON.stringify(event));
            if (event.type === 'error') throw new Error(JSON.stringify(event));
            if (event.type === 'done') return;
          }
          throw new Error('Native Codex ended before completing the turn');
        })();
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            Promise.all([
              complete,
              handle.send(
                { type: 'user', content: 'Read fixture.txt and return its contents.' },
                { throwOnStartFailure: true },
              ),
            ]),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Native gateway turn timed out')), 20_000);
            }),
          ]);
        } finally {
          clearTimeout(timer);
        }
        expect(failures).toEqual([]);
        expect(requests).toHaveLength(2);
        const tools = requests[0]!.tools as Array<Record<string, unknown>>;
        expect(tools).toContainEqual(
          expect.objectContaining({ type: 'function', name: execFunctionName }),
        );
        expect(tools.some((tool) => tool.type === 'custom' || tool.type === 'namespace')).toBe(
          false,
        );
        const replay = requests[1]!.input as Array<Record<string, unknown>>;
        const call = replay.find(
          (item) => item.type === 'function_call' && item.call_id === 'exec-call-1',
        );
        const output = replay.find(
          (item) => item.type === 'function_call_output' && item.call_id === 'exec-call-1',
        );
        expect(call).toMatchObject({
          name: execFunctionName,
          arguments: JSON.stringify({ input: code }),
        });
        expect(String(call?.id)).toMatch(/^fc/);
        expect(JSON.stringify(output?.output)).toContain(fixtureContents);
        expect(events.join('')).toContain(fixtureContents);
      } finally {
        await handle?.close();
        await agent?.dispose();
        proxy.unregister('native-xd-gateway');
        sessions.clearSessionProvider('native-xd-gateway');
        await proxy.disposeCodexProxy();
        proxy.setCodexProxyGatewayKeyReader(() => null);
        proxy.clearCodexProxyAuthInjection();
        catalog.setXdGatewayModels([]);
        homeSpy.mockRestore();
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fixture.gateway = '';
      }
    },
    60_000,
  );
});

describe('Codex Responses through a loopback XD gateway', () => {
  it.each(['x-ai-grok/grok-4.7', 'deepseek/deepseek-v4.1-flash'])(
    'restores streaming namespace calls and replays them for %s',
    async (model) => {
      fixture.root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-xd-gateway-wire-'));
      const requests: Array<Record<string, unknown>> = [];
      const failures: unknown[] = [];
      const server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = [];
          for await (const chunk of req) chunks.push(Buffer.from(chunk));
          if (req.method !== 'POST' || req.url !== '/v1/responses')
            throw new Error('Unexpected gateway request');
          requests.push(
            JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
          );
          const items = [
            {
              type: 'function_call',
              id: 'fc_exec',
              call_id: 'call_exec',
              name: 'exec',
              arguments: JSON.stringify({ input: 'text("synthetic")' }),
            },
            {
              type: 'function_call',
              id: 'fc_read',
              call_id: 'call_read',
              name: 'files__read',
              arguments: '{"path":"README.md"}',
            },
          ];
          const events: unknown[] = items.flatMap((item, index) => [
            {
              type: 'response.output_item.added',
              output_index: index,
              item: { ...item, arguments: '' },
            },
            {
              type: 'response.function_call_arguments.delta',
              output_index: index,
              item_id: item.id,
              delta: item.arguments,
            },
            {
              type: 'response.function_call_arguments.done',
              output_index: index,
              item_id: item.id,
              arguments: item.arguments,
            },
            { type: 'response.output_item.done', output_index: index, item },
          ]);
          events.push({ type: 'response.completed', response: { output: items } });
          res.writeHead(200, { 'content-type': 'text/event-stream' });
          res.end(events.map((event) => 'data: ' + JSON.stringify(event) + '\n\n').join(''));
        } catch (error) {
          failures.push(error);
          res.writeHead(500).end('Synthetic gateway failure');
        }
      });
      await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
      fixture.gateway = 'http://127.0.0.1:' + (server.address() as AddressInfo).port;
      const catalog = await import('../active-catalog.js');
      const proxy = await import('../codex-proxy-host.desktop.js');
      const sessions = await import('../session-provider-store.js');
      const tools = [
        { type: 'custom', name: 'exec', description: 'Run JavaScript' },
        {
          type: 'namespace',
          name: 'files',
          tools: [{ type: 'function', name: 'read', parameters: { type: 'object' } }],
        },
      ];
      try {
        catalog.setXdGatewayModels([{ id: model, agents: ['codex'] }]);
        sessions.setSessionProvider('gateway-wire', 'xd');
        proxy.setCodexProxyAuthInjection('env-key');
        proxy.setCodexProxyGatewayKeyReader(() => 'synthetic-gateway-key');
        proxy.registerComposed('gateway-wire', 'thread-wire', 'PRODUCT_PROMPT');
        await proxy.ensureCodexProxyReady();
        const post = async (input: unknown[]) => {
          const response = await fetch(proxy.getCodexProxyEndpoint() + '/responses', {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              'thread-id': 'thread-wire',
              authorization: 'Bearer synthetic-gateway-key',
            },
            body: JSON.stringify({ model, stream: true, tools, input }),
          });
          expect(response.status).toBe(200);
          return (await response.text())
            .split('\n')
            .filter((line) => line.startsWith('data: '))
            .map((line) => JSON.parse(line.slice(6)));
        };
        const events = await post([{ type: 'message', role: 'user', content: 'read README.md' }]);
        expect(requests[0]?.tools).toEqual([
          expect.objectContaining({ type: 'function', name: 'exec' }),
          expect.objectContaining({ type: 'function', name: 'files__read' }),
        ]);
        expect(
          events.find(
            (event) => event.type === 'response.output_item.done' && event.output_index === 0,
          )?.item,
        ).toMatchObject({
          type: 'custom_tool_call',
          name: 'exec',
          call_id: 'call_exec',
          input: 'text("synthetic")',
        });
        expect(
          events.find((event) => event.type === 'response.custom_tool_call_input.done'),
        ).toMatchObject({ input: 'text("synthetic")' });
        expect(
          events.find(
            (event) => event.type === 'response.output_item.done' && event.output_index === 1,
          )?.item,
        ).toMatchObject({
          type: 'function_call',
          namespace: 'files',
          name: 'read',
          call_id: 'call_read',
          arguments: '{"path":"README.md"}',
        });
        await post([
          {
            type: 'custom_tool_call',
            id: 'ctc_exec',
            name: 'exec',
            call_id: 'call_exec',
            input: 'text("synthetic")',
          },
          {
            type: 'custom_tool_call_output',
            call_id: 'call_exec',
            output: 'synthetic exec result',
          },
          {
            type: 'function_call',
            id: 'fc_read',
            namespace: 'files',
            name: 'read',
            call_id: 'call_read',
            arguments: '{"path":"README.md"}',
          },
          { type: 'function_call_output', call_id: 'call_read', output: 'synthetic file contents' },
        ]);
        const replay = requests[1]?.input as Array<Record<string, unknown>>;
        expect(replay[0]).toMatchObject({
          type: 'function_call',
          id: 'fc_exec',
          name: 'exec',
          call_id: 'call_exec',
          arguments: JSON.stringify({ input: 'text("synthetic")' }),
        });
        expect(replay[1]).toMatchObject({
          type: 'function_call_output',
          call_id: 'call_exec',
          output: 'synthetic exec result',
        });
        expect(replay[2]).toMatchObject({
          type: 'function_call',
          name: 'files__read',
          call_id: 'call_read',
        });
        expect(replay[2]).not.toHaveProperty('namespace');
        expect(replay[3]).toMatchObject({
          type: 'function_call_output',
          call_id: 'call_read',
          output: 'synthetic file contents',
        });
        expect(failures).toEqual([]);
      } finally {
        proxy.unregister('gateway-wire');
        sessions.clearSessionProvider('gateway-wire');
        await proxy.disposeCodexProxy();
        proxy.setCodexProxyGatewayKeyReader(() => null);
        proxy.clearCodexProxyAuthInjection();
        catalog.setXdGatewayModels([]);
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
        fs.rmSync(fixture.root, { recursive: true, force: true });
        fixture.gateway = '';
      }
    },
    60_000,
  );
});
