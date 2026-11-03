import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createServer } from 'node:http';
import assert from 'node:assert/strict';
import { it } from 'vitest';
import { CodexAgent } from './index.js';
import type { AgentSessionHandle } from '../base-agent.js';
import type { Logger } from '../../interfaces/logger.js';
import type { AgentEvent, UsageSnapshot } from '../../types/events.js';
// Integration tier: real Codex process + local Responses server, private home, no account.
// Existing unit handlers cannot verify native timing boundaries and tool execution.
it.skipIf(!process.env.CINDY_CODEX_TEST_BINARY)(
  'measures real native tool turns and resets on a new user send',
  async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'cindy-speed-native-'));
    try {
      const home = path.join(root, 'codex');
      const workdir = path.join(root, 'work');
      await mkdir(home);
      await mkdir(workdir);
      const warnings: unknown[] = [];
      const logger: Logger = {
        trace() {},
        debug() {},
        info() {},
        warn(...a: unknown[]) {
          warnings.push(a);
        },
        error(...a: unknown[]) {
          warnings.push(a);
        },
        fatal() {},
        child() {
          return logger;
        },
      };
      let requests = 0;
      const server = createServer(async (req, res) => {
        for await (const _ of req) {
          /* drain local request */
        }
        if (!req.url?.endsWith('/responses')) {
          res.writeHead(404).end();
          return;
        }
        const n = ++requests;
        const item =
          n === 1
            ? {
                type: 'function_call',
                id: 'fc-1',
                call_id: 'tool-1',
                name: 'exec_command',
                arguments: JSON.stringify({
                  cmd: 'node -e "setTimeout(()=>{},1000)"',
                  yield_time_ms: 1000,
                }),
                status: 'completed',
              }
            : {
                type: 'message',
                id: `msg-${n}`,
                role: 'assistant',
                status: 'completed',
                content: [
                  {
                    type: 'output_text',
                    text: 'Speed validation complete.',
                    annotations: [],
                  },
                ],
              };
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          connection: 'close',
        });
        const send = (event: unknown) =>
          res.write(`data: ${JSON.stringify(event)}\n\n`);
        send({
          type: 'response.created',
          response: { id: `r-${n}`, status: 'in_progress', output: [] },
        });
        // real-wait: integration tier measures native wall-clock generation against a local SSE server.
        await new Promise((r) => setTimeout(r, 1100));
        send({ type: 'response.output_item.done', output_index: 0, item });
        send({
          type: 'response.completed',
          response: {
            id: `r-${n}`,
            status: 'completed',
            output: [item],
            usage: { input_tokens: 10, output_tokens: 100, total_tokens: 110 },
          },
        });
        res.end();
      });
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
          });
        });
        const address = server.address();
        assert(address && typeof address !== 'string');
        const endpoint = `http://127.0.0.1:${address.port}/v1`;
        const agent = new CodexAgent({
          binaryPath: process.env.CINDY_CODEX_TEST_BINARY!,
          logger,
          runtimeConfig: {},
          prepareCodexExtraSpawnConfig: async () => ({
            extraArgs: [
              '-c',
              'model_provider="fixture"',
              '-c',
              `model_providers.fixture={name="Local speed validation",base_url="${endpoint}",wire_api="responses",requires_openai_auth=false,request_max_retries=0,supports_websockets=false}`,
              '-c',
              'check_for_update_on_startup=false',
              '-c',
              'analytics.enabled=false',
              '-c',
              'features.code_mode=false',
              // Fresh profile: keep the adapter-disabled MCP transport syntactically valid.
              '-c',
              'mcp_servers.cindy_memory={command="false",enabled=false}',
            ],
            extraEnv: {},
          }),
          auth: {
            getState: async () => ({ authenticated: true }),
            triggerLogin: async () => ({ authenticated: true }),
            logout: async () => {},
            getAuthEnv: async () => ({
              HOME: root,
              USERPROFILE: root,
              CODEX_HOME: home,
              OPENAI_API_KEY: '',
              CODEX_API_KEY: '',
              NO_PROXY: '127.0.0.1,localhost',
            }),
          },
        });
        try {
          let handle: AgentSessionHandle | undefined;
          const events: AgentEvent[] = [];
          try {
            handle = await agent.startSession({
              sessionId: 'speed-native',
              model: 'gpt-6-astra',
              workingDir: workdir,
              permissionMode: 'bypassPermissions',
              makerMemoryEnabled: false,
            });
            let doneResolve: () => void = () => {};
            void (async () => {
              for await (const e of handle!.events()) {
                if (
                  e.type === 'status' ||
                  e.type === 'done' ||
                  e.type === 'error' ||
                  e.type === 'tool_use' ||
                  e.type === 'tool_result'
                )
                  events.push(e);
                if (e.type === 'done') doneResolve();
              }
            })();
            const run = async () => {
              const done = new Promise<void>((r) => (doneResolve = r));
              await handle!.send(
                { type: 'user', content: 'Run the tool and finish.' },
                { throwOnStartFailure: true },
              );
              let timer: ReturnType<typeof setTimeout> | undefined;
              try {
                await Promise.race([
                  done,
                  new Promise((_, reject) => {
                    // real-wait: failure deadline for the native subprocess; successful runs cancel it.
                    timer = setTimeout(
                      () => reject(new Error('native turn timeout')),
                      20000,
                    );
                  }),
                ]);
              } finally {
                clearTimeout(timer);
              }
            };
            const startedAt = Date.now();
            await run();
            const firstWallMs = Date.now() - startedAt;
            const readings = () =>
              events.flatMap((e) => {
                const speed =
                  e.type === 'status'
                    ? (e.data as UsageSnapshot).tokenSpeed
                    : undefined;
                return speed ? [speed] : [];
              });
            const first = readings().at(-1);
            assert(
              first && first.tokens === 200,
              JSON.stringify({ first, events, warnings }),
            );
            assert(
              first.elapsedMs >= 2000 && first.elapsedMs < 5000,
              JSON.stringify(first),
            );
            assert(
              firstWallMs - first.elapsedMs >= 800,
              'tool wait must be excluded from generation time',
            );
            assert.equal(events.filter((e) => e.type === 'tool_use').length, 1);
            await run();
            const second = readings().at(-1);
            assert(second);
            assert.equal(second.tokens, 100);
            const evidence = {
              requests,
              first,
              second,
              tools: events
                .filter((e) => e.type === 'tool_use')
                .map((e) => e.data),
              statuses: events
                .filter((e) => e.type === 'status')
                .map((e) => e.data),
              errors: events.filter((e) => e.type === 'error'),
              warnings,
            };
            if (process.env.CINDY_SPEED_EVIDENCE)
              await writeFile(
                process.env.CINDY_SPEED_EVIDENCE,
                JSON.stringify(evidence, null, 2),
              );
            console.log(
              JSON.stringify({
                requests,
                first,
                second,
                toolCount: evidence.tools.length,
                errors: evidence.errors,
              }),
            );
          } finally {
            await handle?.close();
          }
        } finally {
          await agent.dispose();
        }
      } finally {
        // Independent scopes ensure an earlier cleanup failure cannot skip this one.
        try {
          server.closeAllConnections();
        } finally {
          await new Promise<void>((r) => server.close(() => r()));
        }
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
  40_000,
);
