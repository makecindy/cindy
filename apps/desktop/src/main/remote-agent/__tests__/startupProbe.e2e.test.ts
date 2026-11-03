/**
 * 测试价值：生产 startRemoteAgentSession → Host → 原生 Codex → 本机 Responses/MCP。
 * 2026-10-26 一个 Skill 引发 108 次串行插件归属查询；mirror 单测未覆盖原生扫描与启动耗时。
 * 最小输入：一个项目 Skill，关闭/开启短路，固定链路延迟；查询应减少且 Skill/插件结果完整。
 * e2e tier：真实进程、socket 与链路延迟；独立文件覆盖 Windows（codexHosted 含 Unix 命令）。
 * 模型回复和插件业务为 mock；插件 MCP 网关、文件查询与 Codex 引擎是真实实现。
 * 运行端原生插件按 guest 隔离停用；不替代第三方插件安装或 UI 验收。
 * 依赖 apps/codex-package-bin 和 ripgrep；缺失时跳过。实测耗时见远程适配文档。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CodexAgent, type AgentDeps, type Logger } from '@cindy/maker-core';
import { createCindyGhostsMcpServer, type CindyGhostsMcpDeps } from 'cindy-tools';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost } from '../host/runHost';
import { hostedStartOptions } from '../host/service';
import * as shortcutModule from '../host/execServerShortcut';
import * as batchModule from '../host/execServerStartupBatch';
import { collectProjectInstructionFiles as collectProjectFiles, collectAncestorMarkers } from '../controller/projectFiles';
import type { StartupExecServerStats } from '../startupTiming';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CODEX = path.join(REPO, 'apps', 'codex-package-bin', ARCH, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const RG = path.join(REPO, 'apps', 'ripgrep-bin', ARCH, process.platform === 'win32' ? 'rg.exe' : 'rg');
const available = fs.existsSync(CODEX) && fs.existsSync(RG);

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

type Step = { kind: 'exec'; cmd: string } | { kind: 'tool'; name: string; args: Record<string, unknown> };

describe.skipIf(!available)('remote agent with a real Codex', () => {
  let server: Server;
  let endpoint = '';
  let root = '';
  let steps: Step[] = [];
  const bodies: string[] = [];
  let pluginCalls = 0;
  const plugin = {
    id: 'qa-plugin', name: 'QA plugin', command: 'qa-plugin', recall: 'QA_PLUGIN_DISCOVERY_SENTINEL',
    tools: [{ name: 'ping', description: 'Return a test value', parameters: { type: 'object' as const } }],
  };
  const unsupported = async (): Promise<never> => { throw new Error('Not part of this fixture'); };
  const pluginDeps: CindyGhostsMcpDeps = {
    listAwakeGhosts: async () => [plugin],
    getAwakeGhost: async id => id === plugin.id ? { ok: true, ghost: plugin }
      : { ok: false, errorCode: 'GHOST_NOT_FOUND', message: 'Unknown test plugin' },
    readGhostManual: async () => ({ ok: true, manual: [], content: '' }),
    callGhostTool: async ({ ghostId, tool }) => {
      if (ghostId !== plugin.id || tool !== 'ping') throw new Error('Wrong plugin route');
      pluginCalls += 1;
      return { ok: true, result: { value: 'QA_PLUGIN_CALL_SENTINEL' } };
    },
    forgeGuide: unsupported, forgeScaffold: unsupported, forgePack: unsupported,
    forgeInstall: unsupported, forgePublish: unsupported, forgePublishStatus: unsupported,
  };

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-hosted-')));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', async () => {
        if (req.url === '/mcp') {
          const mcp = createCindyGhostsMcpServer(pluginDeps);
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
          res.on('close', () => { void transport.close(); void mcp.close(); });
          await mcp.connect(transport);
          await transport.handleRequest(req, res, body ? JSON.parse(body) : undefined);
          return;
        }
        if (!req.url?.includes('/responses')) {
          res.writeHead(404).end('{}');
          return;
        }
        bodies.push(body);
        let parsed: { input?: Array<{ type?: string }> } = {};
        try {
          parsed = JSON.parse(body);
        } catch {
          parsed = {};
        }
        const done = (parsed.input ?? []).filter((item) => item.type === 'function_call_output' || item.type === 'custom_tool_call_output').length;
        const step = steps[done];
        const id = `resp_${bodies.length}`;
        const item = step?.kind === 'exec'
          ? { type: 'function_call', id: `fc_${done}`, call_id: `call_${done}`, name: 'exec_command', arguments: JSON.stringify({ cmd: step.cmd }), status: 'completed' }
          : step?.kind === 'tool'
            ? { type: 'custom_tool_call', id: `fc_${done}`, call_id: `call_${done}`, name: 'exec', input: `text(await tools.${step.name}(${JSON.stringify(step.args)}));`, status: 'completed' }
            : { type: 'message', id: `msg_${done}`, role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'DONE', annotations: [] }] };
        const events = [
          { type: 'response.created', response: { id, status: 'in_progress', output: [] } },
          { type: 'response.output_item.added', output_index: 0, item },
          { type: 'response.output_item.done', output_index: 0, item },
          { type: 'response.completed', response: { id, status: 'completed', output: [item], usage: { input_tokens: 10, output_tokens: 5, total_tokens: 15 } } },
        ];
        res.writeHead(200, { 'content-type': 'text/event-stream', connection: 'close' });
        res.end(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(''));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function codexDeps(home: string): AgentDeps {
    fs.mkdirSync(home, { recursive: true });
    fs.writeFileSync(path.join(home, 'config.toml'), [
      'model="gpt-5.5"',
      'model_provider="fixture"',
      'cli_auth_credentials_store="ephemeral"',
      'check_for_update_on_startup=false',
      '[analytics]', 'enabled=false',
      // Match hosted guest isolation: provider-side native plugins must not leak into the task.
      // Task-side Cindy plugins remain available through their real MCP gateway below.
      '[features]', 'plugins=false', 'remote_plugin=false',
      '[features.code_mode]', 'enabled=true',
      '[model_providers.fixture]', 'name="Fixture"',
      `base_url="${endpoint}"`, 'wire_api="responses"',
      'requires_openai_auth=false', 'request_max_retries=0', 'supports_websockets=false',
    ].join('\n'));
    return {
      binaryPath: CODEX,
      logger: noopLogger,
      runtimeConfig: {},
      resolveCodexLocalAuthPolicy: () => 'isolated',
      prepareCodexExtraSpawnConfig: async () => ({ extraArgs: [], extraEnv: {}, codexProxyActive: true }),
      auth: {
        getState: async () => ({ authenticated: true }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({
          HOME: path.dirname(home), CODEX_HOME: home, OPENAI_API_KEY: '', CODEX_API_KEY: '',
        }),
      },
    } as AgentDeps;
  }

  it('compares native startup with and without shortcuts', { timeout: 180_000 }, async () => {
    const project = path.join(root, 'project');
    const skillDir = path.join(project, '.agents', 'skills', 'qa-discovery');
    fs.mkdirSync(skillDir, { recursive: true });
    fs.mkdirSync(path.join(project, '.git'));
    fs.writeFileSync(path.join(skillDir, 'SKILL.md'), '---\nname: qa-discovery\ndescription: QA_SKILL_DISCOVERY_SENTINEL\n---\nReply QA_SKILL_BODY_SENTINEL when invoked.\n');
    steps = [{ kind: 'exec', cmd: process.platform === 'win32'
      ? "Get-Content .agents/skills/qa-discovery/SKILL.md"
      : 'cat .agents/skills/qa-discovery/SKILL.md' },
      { kind: 'tool', name: 'mcp__cindy__ghost_list', args: {} },
      { kind: 'tool', name: 'mcp__cindy__ghost_info', args: { ghost_id: plugin.id } },
      { kind: 'tool', name: 'mcp__cindy__ghost_call', args: { ghost_id: plugin.id, tool: 'ping', args: {} } },
    ];
    const original = shortcutModule.createExecServerShortcut;
    const results = [];
    const originalBatch = batchModule.createExecServerStartupBatch;
    for (const { optimized, delayMs, batched } of [
      { optimized: false, delayMs: 0, batched: false }, { optimized: true, delayMs: 0, batched: false },
      { optimized: false, delayMs: 100, batched: false }, { optimized: true, delayMs: 100, batched: false },
      { optimized: true, delayMs: 0, batched: true },
    ]) {
      const batchSpy = vi.spyOn(batchModule, 'createExecServerStartupBatch').mockImplementation(deps =>
        batched ? originalBatch(deps) : { request: () => false, response: () => false, finish() {} });
      bodies.length = 0;
      pluginCalls = 0;
      let shortcutHits = 0;
      const spy = vi.spyOn(shortcutModule, 'createExecServerShortcut').mockImplementation(layout => {
        const shortcut = original(layout);
        return data => {
          const reply = optimized ? shortcut(data) : null;
          if (reply !== null) shortcutHits += 1;
          return reply;
        };
      });
      const agent = new CodexAgent(codexDeps(path.join(root, `home-${optimized}-${delayMs}-${batched}`)));
      const counts: Record<string, number> = {};
      let startupStats: StartupExecServerStats | undefined;
      const host = createRemoteAgentHost({
        isAgentAvailable: () => true,
        startHosted: input => agent.startSession(hostedStartOptions(input)),
        isControllerAuthorized: () => true, captureOwner: () => 'owner', isOwnerCurrent: () => true,
        runsRoot: path.join(root, `host-${optimized}-${delayMs}-${batched}`),
        log: {
          info() {}, warn() {},
          debug(_message, fields) {
            if (fields?.side === 'host' && fields?.stage === 'total') startupStats = fields.execServer as StartupExecServerStats;
          },
        },
      });
      let handle;
      const before = performance.now();
      try {
        handle = await startRemoteAgentSession('codex', {
          sessionId: randomUUID(), workingDir: project, model: 'gpt-5.5', permissionMode: 'default',
        }, {
          invoke: async args => {
            const req = JSON.parse(JSON.stringify(args[0]));
            const result = JSON.parse(JSON.stringify(await host.handle('controller-1', req) ?? null));
            if (req.op === 'poll') {
              for (const run of result?.runs ?? []) for (const line of Buffer.from(run.data ?? '', 'base64').toString().split('\n').filter(Boolean)) {
                const item = JSON.parse(line);
                if (item.t === 'ws' && item.kind === 'message') {
                  const rpc = JSON.parse(item.data);
                  counts[rpc.method] = (counts[rpc.method] ?? 0) + 1;
                }
              }
            }
            // real-wait: e2e fixed link latency measures serial native RPC round trips.
            if (delayMs && (req.op === 'poll' || req.op === 'push')) await new Promise(r => setTimeout(r, delayMs));
            return result;
          },
          rgPath: RG, codexPath: () => CODEX,
          prepareMcp: async () => ({ servers: new Map([
            ['cindy', { url: endpoint.replace('/v1', '/mcp'), headers: {} }],
          ]), dispose() {} }),
          collectProjectFiles: async () => [], collectAncestorMarkers,
          isGitRepo: async () => true, newId: randomUUID,
        });
        handle.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
        const durationMs = Math.round(performance.now() - before);
        const startupCounts = { ...counts };
        const startupHits = shortcutHits;
        expect(startupStats).toMatchObject({ shortcutEnabled: true, connections: 1 });
        if (!batched) expect(startupStats!.answered).toBe(startupHits);
        expect(startupStats!.ancestorLevels).toBeGreaterThan(0);
        const done = (async () => {
          for await (const event of handle!.events()) {
            if (event.type === 'error') throw new Error(JSON.stringify(event.data));
            if (event.type === 'done') break;
          }
        })();
        await handle.send({ type: 'user', content: 'Reply DONE.' }, { throwOnStartFailure: true });
        await done;
        const skillPresent = bodies.at(-1)!.includes('QA_SKILL_DISCOVERY_SENTINEL');
        const skillBodyRead = bodies.at(-1)!.includes('QA_SKILL_BODY_SENTINEL');
        const pluginDiscovered = bodies.at(-1)!.includes('QA_PLUGIN_DISCOVERY_SENTINEL');
        const pluginCalled = bodies.at(-1)!.includes('QA_PLUGIN_CALL_SENTINEL') && pluginCalls === 1;
        results.push({ optimized, batched, delayMs, durationMs, counts: startupCounts, shortcutHits: startupHits, startupStats, skillPresent, skillBodyRead, pluginDiscovered, pluginCalled });
        expect(skillPresent).toBe(true);
        expect(skillBodyRead).toBe(true);
        expect(pluginDiscovered).toBe(true);
        expect(pluginCalled).toBe(true);
        expect(shortcutHits > 0).toBe(optimized);
      } finally {
        await handle?.close({ reason: 'navigation' });
        await agent.dispose(); host.dispose(); spy.mockRestore(); batchSpy.mockRestore();
      }
    }
    expect(results[1].counts['fs/getMetadata']).toBeLessThan(results[0].counts['fs/getMetadata']);
    expect(results[3].counts['fs/getMetadata']).toBeLessThan(results[2].counts['fs/getMetadata']);
    console.log('STARTUP_AB_RESULT', JSON.stringify(results));
  });

  // Production startup with the same eight-Skill/400ms fixture as the incident investigation.
  // Unlike the causal probe, this uses real native metadata replies, including prefetch cost.
  it('batches eight-Skill startup queries across a delayed transport', { timeout: 240_000 }, async () => {
    const taskHome = path.join(root, 'isolated-task-home');
    fs.mkdirSync(taskHome);
    const homeSpy = vi.spyOn(os, 'homedir').mockReturnValue(taskHome);
    vi.stubEnv('USERPROFILE', taskHome);
    vi.stubEnv('HOME', taskHome);
    const project = path.join(root, 'batch-project');
    fs.mkdirSync(path.join(project, '.git'), { recursive: true });
    for (const tier of ['.agents', '.claude']) for (let i = 0; i < 8; i += 1) {
      const dir = path.join(project, tier, 'skills', `qa-${i}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'SKILL.md'), `---\nname: qa-${i}\ndescription: Project startup investigation ${i}\n---\nTest fixture only.\n`);
    }
    const originalShortcut = shortcutModule.createExecServerShortcut;
    // Model the lack of raw absolute-path snapshots across Windows/POSIX; real RPCs still run on Windows.
    const shortcutSpy = vi.spyOn(shortcutModule, 'createExecServerShortcut').mockImplementation(layout =>
      originalShortcut({ ...layout, taskAncestorAbsence: [] }));
    const originalBatch = batchModule.createExecServerStartupBatch;
    const results: Array<{ batched: boolean; durationMs: number; pushes: number; startupStats?: StartupExecServerStats }> = [];
    try {
      for (const [index, batched] of [false, true, false, true].entries()) {
        const batchSpy = vi.spyOn(batchModule, 'createExecServerStartupBatch').mockImplementation(deps =>
          batched ? originalBatch(deps) : { request: () => false, response: () => false, finish() {} });
        const agent = new CodexAgent(codexDeps(path.join(root, `batch-home-${index}`)));
        let startupStats: StartupExecServerStats | undefined;
        const host = createRemoteAgentHost({
          isAgentAvailable: () => true,
          startHosted: input => agent.startSession(hostedStartOptions(input)),
          isControllerAuthorized: () => true, captureOwner: () => 'owner', isOwnerCurrent: () => true,
          runsRoot: path.join(root, `batch-host-${index}`),
          log: { info() {}, warn() {}, debug(_message, fields) {
            if (fields?.side === 'host' && fields?.stage === 'total') startupStats = fields.execServer as StartupExecServerStats;
          } },
        });
        let handle;
        let pushes = 0;
        const before = performance.now();
        try {
          handle = await startRemoteAgentSession('codex', {
            sessionId: randomUUID(), workingDir: project, model: 'gpt-5.5', permissionMode: 'default',
          }, {
            invoke: async args => {
              const req = JSON.parse(JSON.stringify(args[0]));
              if (req.op === 'push') pushes += 1;
              const result = JSON.parse(JSON.stringify(await host.handle('controller-1', req) ?? null));
              // real-wait: manual e2e benchmark includes poll/push latency from the incident probe.
              if (req.op === 'poll' || req.op === 'push') await new Promise(r => setTimeout(r, 400));
              return result;
            },
            rgPath: RG, codexPath: () => CODEX,
            prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
            collectProjectFiles, collectAncestorMarkers,
            isGitRepo: async () => true, newId: randomUUID,
          });
          const result = { batched, durationMs: Math.round(performance.now() - before), pushes, startupStats };
          results.push(result);
          console.log('STARTUP_BATCH_RESULT', JSON.stringify(result));
          expect(startupStats?.connections).toBe(1);
        } finally {
          await handle?.close({ reason: 'navigation' });
          await agent.dispose(); host.dispose(); batchSpy.mockRestore();
        }
      }
      for (const index of [0, 2]) {
        // A regression to serial traversal must fail, even if all four startups succeed.
        expect(results[index + 1].pushes).toBeLessThan(results[index].pushes / 2);
        expect(results[index + 1].durationMs).toBeLessThan(results[index].durationMs * 0.7);
      }
    } finally {
      console.log('STARTUP_BATCH_AB_RESULT', JSON.stringify(results));
      shortcutSpy.mockRestore(); homeSpy.mockRestore(); vi.unstubAllEnvs();
    }
  });

});
