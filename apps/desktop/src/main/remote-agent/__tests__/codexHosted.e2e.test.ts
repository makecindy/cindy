/**
 * 远程 Agent × 真实 Codex 端到端：
 *   控制端(任务、项目文件、本机 codex exec-server) ⇄ 被控端运行服务 ⇄ 真 Codex app-server ⇄ 假 Responses 网关
 * 被控端的 Codex 把控制端注册成 exec-server 执行环境(Codex 原生机制)，命令与补丁都在控制端执行。
 * 依赖 apps/codex-package-bin；缺失时跳过。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { CodexAgent, type AgentDeps, type AgentEvent, type InteractionRequest, type Logger } from '@cindy/maker-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost } from '../host/runHost';
import { hostedStartOptions } from '../host/service';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CODEX = path.join(REPO, 'apps', 'codex-package-bin', ARCH, 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
const RG = path.join(REPO, 'apps', 'ripgrep-bin', ARCH, process.platform === 'win32' ? 'rg.exe' : 'rg');
const available = fs.existsSync(CODEX) && fs.existsSync(RG) && process.platform !== 'win32';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

type Step = { kind: 'exec'; cmd: string } | { kind: 'patch'; patch: string };

describe.skipIf(!available)('remote agent with a real Codex', () => {
  let server: Server;
  let endpoint = '';
  let root = '';
  let steps: Step[] = [];
  const bodies: string[] = [];

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-codex-hosted-')));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
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
          : step?.kind === 'patch'
            ? { type: 'custom_tool_call', id: `ctc_${done}`, call_id: `call_${done}`, name: 'apply_patch', input: step.patch, status: 'completed' }
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

  async function run(permissionMode: 'bypassPermissions' | 'default', resolve?: (request: InteractionRequest) => boolean) {
    const project = path.join(root, `project-${permissionMode}`);
    const hostRoot = path.join(root, `host-${permissionMode}`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the controller\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Rules\nKeep answers short.\n');
    const agent = new CodexAgent(codexDeps(path.join(root, `codex-home-${permissionMode}`)));
    const host = createRemoteAgentHost({
      isAgentAvailable: (kind) => kind === 'codex',
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const handle = await startRemoteAgentSession('codex', {
      sessionId: `codex-hosted-${permissionMode}`,
      workingDir: project,
      model: 'gpt-5.5',
      permissionMode,
    }, {
      invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
      rgPath: RG,
      codexPath: () => CODEX,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      collectProjectFiles: async () => [],
      isGitRepo: async () => false,
      newId: randomUUID,
    });
    const asked: InteractionRequest[] = [];
    handle.setInteractionResolver(async (request) => {
      asked.push(request);
      const allow = resolve ? resolve(request) : true;
      return { kind: 'permission', behavior: allow ? 'allow' : 'deny' };
    });
    const events: AgentEvent[] = [];
    const done = (async () => {
      for await (const event of handle.events()) {
        events.push(event);
        if (event.type === 'error' && (event.data as { isTerminal?: boolean }).isTerminal !== false) {
          throw new Error(JSON.stringify(event.data));
        }
        if (event.type === 'done') return;
      }
    })();
    await handle.send({ type: 'user', content: 'Do the scripted work.' }, { throwOnStartFailure: true });
    await done;
    await handle.close({ reason: 'navigation' });
    agent.dispose?.();
    host.dispose();
    return { project, hostRoot, events, asked };
  }

  it('runs commands and patches on the controller through the native exec-server environment', { timeout: 180_000 }, async () => {
    steps = [
      { kind: 'exec', cmd: 'pwd; ls' },
      { kind: 'patch', patch: '*** Begin Patch\n*** Add File: made-by-codex.txt\n+hello codex\n*** End Patch\n' },
    ];
    bodies.length = 0;
    const { project, hostRoot } = await run('bypassPermissions');
    expect(fs.readFileSync(path.join(project, 'made-by-codex.txt'), 'utf8')).toBe('hello codex\n');
    const last = bodies.at(-1)!;
    // 命令在控制端的项目目录执行。
    expect(last).not.toContain(project);
    expect(last).toContain(hostRoot);
    expect(last).toContain('hello.txt');
    // 模型看到的工作目录与项目说明都来自控制端。
    expect(bodies[0]).not.toContain(project);
    expect(bodies[0]).toContain(hostRoot);
    expect(bodies[0]).toContain('Keep answers short.');
    const hostFiles = fs.readdirSync(hostRoot, { recursive: true }).map(String);
    expect(hostFiles.some((file) => file.endsWith('made-by-codex.txt'))).toBe(false);
  });

  it('asks on this computer before Codex runs a risky command, and runs only what was approved', { timeout: 180_000 }, async () => {
    const approvedVictim = path.join(root, 'victim-approved');
    const deniedVictim = path.join(root, 'victim-denied');
    fs.mkdirSync(approvedVictim);
    fs.mkdirSync(deniedVictim);
    steps = [
      { kind: 'exec', cmd: `rm -rf ${approvedVictim}` },
      { kind: 'exec', cmd: `rm -rf ${deniedVictim}` },
    ];
    bodies.length = 0;
    const { asked } = await run('default', (request) =>
      !(request.kind === 'permission' && String(request.input.command ?? '').includes('victim-denied')));
    const commands = asked
      .filter((request): request is Extract<InteractionRequest, { kind: 'permission' }> => request.kind === 'permission')
      .map((request) => String(request.input.command));
    expect(commands.some((command) => command.includes(`rm -rf ${approvedVictim}`))).toBe(true);
    expect(commands.some((command) => command.includes(`rm -rf ${deniedVictim}`))).toBe(true);
    expect(fs.existsSync(approvedVictim)).toBe(false);
    expect(fs.existsSync(deniedVictim)).toBe(true);
  });
});
