/**
 * 远程 Agent × 真实 Pi 端到端：
 *   控制端(任务、项目文件) ⇄ 被控端运行服务 ⇄ 真 Pi 二进制(cwd = 影子目录) ⇄ 假模型网关
 * 模型按脚本依次调用 bash / write / read / edit / grep / ls / find，断言每一步都落在控制端的
 * 项目目录里(影子目录里没有项目文件)，提示里的工作目录是控制端的真实路径。
 * 依赖 apps/pi-bin/<platform>/pi；缺失时跳过。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { PiAgent, type AgentDeps, type AgentEvent, type Logger } from '@cindy/maker-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost } from '../host/runHost';
import { hostedStartOptions } from '../host/service';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const PI = path.join(REPO, 'apps', 'pi-bin', ARCH, process.platform === 'win32' ? 'pi.exe' : 'pi');
const RG = path.join(REPO, 'apps', 'ripgrep-bin', ARCH, process.platform === 'win32' ? 'rg.exe' : 'rg');
const available = fs.existsSync(PI) && fs.existsSync(RG) && process.platform !== 'win32';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function sse(events: Array<{ event: string; data: unknown }>): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join('');
}

function toolUseBody(step: number, name: string, input: unknown): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: 'pi-test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}`, name, input: {} } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

function textBody(text: string): string {
  return sse([
    { event: 'message_start', data: { type: 'message_start', message: { id: 'msg_end', type: 'message', role: 'assistant', model: 'pi-test-model', content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } } },
    { event: 'content_block_start', data: { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } } },
    { event: 'content_block_delta', data: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } },
    { event: 'content_block_stop', data: { type: 'content_block_stop', index: 0 } },
    { event: 'message_delta', data: { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } } },
    { event: 'message_stop', data: { type: 'message_stop' } },
  ]);
}

interface ModelRequest {
  system: string;
  toolNames: string[];
  results: string[];
}

describe.skipIf(!available)('remote agent with a real Pi', () => {
  let server: Server;
  let endpoint = '';
  let root = '';
  let steps: Array<{ name: string; input: unknown }> = [];
  const requests: ModelRequest[] = [];

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-pi-hosted-')));
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        const parsed = JSON.parse(body || '{}') as {
          system?: string | Array<{ text?: string }>;
          tools?: Array<{ name: string }>;
          messages?: Array<{ content?: unknown }>;
        };
        const system = typeof parsed.system === 'string' ? parsed.system : (parsed.system ?? []).map((part) => part.text ?? '').join('\n');
        const results: string[] = [];
        for (const message of parsed.messages ?? []) {
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type !== 'tool_result') continue;
            const content = block.content;
            results.push(typeof content === 'string'
              ? content
              : Array.isArray(content) ? content.map((part: { text?: string }) => part.text ?? '').join('') : '');
          }
        }
        requests.push({ system, toolNames: (parsed.tools ?? []).map((tool) => tool.name), results });
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
        const step = steps[results.length];
        res.end(step ? toolUseBody(results.length, step.name, step.input) : textBody('all done'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    if (address && typeof address === 'object') endpoint = `http://127.0.0.1:${address.port}`;
  });

  afterAll(async () => {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    fs.rmSync(root, { recursive: true, force: true });
  });

  function piDeps(agentHome: string): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ CINDY_PI_API_KEY: 'test-key' }),
      },
      runtimeConfig: { endpoint, managedExecutablePaths: { ripgrep: RG } },
      binaryPath: PI,
      logger: noopLogger,
      capabilityAdditions: {
        availableModels: [{ id: 'pi-test-model', displayName: 'Pi Test', contextWindow: 200_000, efforts: [], defaultEffort: null }],
      },
      resolvePiAgentHome: () => agentHome,
      resolvePiGatewayModelApi: () => 'anthropic-messages',
    };
  }

  it('runs Pi on the provider computer while every tool lands in the project here', { timeout: 120_000 }, async () => {
    const project = path.join(root, 'project');
    const hostRoot = path.join(root, 'host');
    fs.mkdirSync(path.join(project, 'src'), { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the controller\n');
    fs.writeFileSync(path.join(project, 'src', 'needle.ts'), 'export const needle = 42;\n');
    fs.writeFileSync(path.join(project, 'AGENTS.md'), '# Project rules\nAlways be precise.\n');
    steps = [
      { name: 'bash', input: { command: 'pwd; ls' } },
      { name: 'write', input: { path: 'made-by-pi.txt', content: 'first line\n' } },
      { name: 'read', input: { path: 'hello.txt' } },
      { name: 'edit', input: { path: 'made-by-pi.txt', edits: [{ oldText: 'first line', newText: 'edited line' }] } },
      { name: 'grep', input: { pattern: 'needle' } },
      { name: 'ls', input: { path: 'src' } },
      { name: 'find', input: { pattern: '*.ts' } },
    ];
    requests.length = 0;

    const agent = new PiAgent(piDeps(path.join(root, 'pi-home')));
    const host = createRemoteAgentHost({
      isAgentAvailable: (kind) => kind === 'pi',
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const captured: string[] = [];
    const handle = await startRemoteAgentSession('pi', {
      sessionId: 'pi-hosted-1',
      workingDir: project,
      model: 'pi-test-model',
      permissionMode: 'bypassPermissions',
    }, {
      invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
      rgPath: RG,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      capture: () => ({
        beforeWrite: async (file) => {
          captured.push(file);
        },
        noteOpaqueWrite: () => {},
      }),
      collectProjectFiles: async () => [{ path: 'AGENTS.md', data: fs.readFileSync(path.join(project, 'AGENTS.md')).toString('base64') }],
      isGitRepo: async () => false,
      newId: randomUUID,
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
    await handle.send({ type: 'user', content: 'Do the scripted work.' });
    await done;

    const last = requests.at(-1)!;
    const [bash, write, read, edit, grep, ls, find] = last.results;
    // 命令在控制端的项目目录执行，看得到控制端的文件。
    expect(bash).not.toContain(project);
    expect(bash).toContain(hostRoot);
    expect(bash).toContain('hello.txt');
    expect(write).toMatch(/made-by-pi\.txt/);
    expect(read).toContain('hello from the controller');
    expect(edit).toMatch(/made-by-pi\.txt/);
    expect(fs.readFileSync(path.join(project, 'made-by-pi.txt'), 'utf8')).toBe('edited line\n');
    expect(grep).toContain('src/needle.ts');
    expect(grep).toContain('needle = 42');
    expect(ls).toContain('needle.ts');
    expect(find).toContain('needle.ts');
    // 影子目录里只有项目说明；Agent 写的文件不在那里。
    const hostFiles = fs.readdirSync(hostRoot, { recursive: true }).map(String);
    expect(hostFiles.some((file) => file.endsWith('made-by-pi.txt'))).toBe(false);
    expect(hostFiles.some((file) => file.endsWith('AGENTS.md'))).toBe(true);
    // 模型看到的是控制端的真实目录与项目说明。
    expect(requests[0].system).not.toContain(project);
    expect(requests[0].system).toContain('# Workspace');
    expect(requests[0].system).toContain(hostRoot);
    expect(requests[0].system).toContain('AGENTS.md');
    expect(requests[0].system).toContain('Always be precise.');
    // 工具清单与本机任务一致(读写编辑也有提示片段)。
    expect(requests[0].system).toMatch(/- read: /);
    expect(requests[0].system).toMatch(/- edit: /);
    expect(requests[0].system).toMatch(/- write: /);
    expect(requests[0].toolNames).toEqual(expect.arrayContaining(['read', 'bash', 'edit', 'write', 'grep', 'find', 'ls']));
    // 写入前本机抓取了改前内容。
    expect(captured).toContain(path.join(project, 'made-by-pi.txt'));
    expect(events.some((event) => event.type === 'tool_use')).toBe(true);

    await handle.close({ reason: 'navigation' });
    host.dispose();
  });

  it('asks the user here before running commands in ask mode, and holds high-impact commands until confirmed', { timeout: 120_000 }, async () => {
    const project = path.join(root, 'project-ask');
    const hostRoot = path.join(root, 'host-ask');
    fs.mkdirSync(project, { recursive: true });
    const victim = path.join(root, 'victim-dir');
    fs.mkdirSync(victim);
    steps = [
      { name: 'bash', input: { command: 'touch approved.txt' } },
      { name: 'bash', input: { command: `rm -rf ${victim}` } },
      { name: 'bash', input: { command: 'touch denied.txt' } },
    ];
    requests.length = 0;
    const agent = new PiAgent(piDeps(path.join(root, 'pi-home-ask')));
    const host = createRemoteAgentHost({
      isAgentAvailable: () => true,
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const handle = await startRemoteAgentSession('pi', {
      sessionId: 'pi-hosted-ask',
      workingDir: project,
      model: 'pi-test-model',
      permissionMode: 'default',
    }, {
      invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
      rgPath: RG,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      collectProjectFiles: async () => [],
      isGitRepo: async () => false,
      newId: randomUUID,
    });
    const asked: Array<{ toolName: string; command: unknown }> = [];
    handle.setInteractionResolver(async (request) => {
      if (request.kind !== 'permission') throw new Error('unexpected interaction');
      asked.push({ toolName: request.toolName, command: request.input.command });
      const deny = String(request.input.command).includes('denied');
      return { kind: 'permission', behavior: deny ? 'deny' : 'allow' };
    });
    const done = (async () => {
      for await (const event of handle.events()) {
        if (event.type === 'done') return;
      }
    })();
    await handle.send({ type: 'user', content: 'Run the commands.' });
    await done;
    expect(asked.map((item) => item.command)).toEqual(['touch approved.txt', `rm -rf ${victim}`, 'touch denied.txt']);
    expect(asked.every((item) => item.toolName === 'bash')).toBe(true);
    expect(fs.existsSync(path.join(project, 'approved.txt'))).toBe(true);
    // 用户在本机允许了高危命令，执行器据此放行。
    expect(fs.existsSync(victim)).toBe(false);
    expect(fs.existsSync(path.join(project, 'denied.txt'))).toBe(false);
    const results = requests.at(-1)!.results;
    expect(results[2]).toMatch(/denied/i);
    await handle.close({ reason: 'navigation' });
    host.dispose();
  });
});
