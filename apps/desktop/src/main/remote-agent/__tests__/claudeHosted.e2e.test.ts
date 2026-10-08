/**
 * 远程 Agent × 真实 Claude Code 端到端：
 *   控制端(任务、项目文件) ⇄ 被控端运行服务 ⇄ 真 Claude Code(cwd = 影子目录) ⇄ 假 Anthropic 网关
 * 自带文件与命令工具关掉，由 cindy_exec(经隧道回到控制端执行)顶替；断言模型拿到的工具清单、
 * 系统提示里的真实路径，以及每一步都落在控制端的项目目录里。依赖 apps/claude-code-bin；缺失时跳过。
 */
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';

import { ClaudeCodeAgent, type AgentDeps, type AgentEvent, type InteractionRequest, type Logger } from '@cindy/maker-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { remoteAgentEventMapper } from '../controller/eventMap';
import { startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost } from '../host/runHost';
import { hostedStartOptions } from '../host/service';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CLAUDE = path.join(REPO, 'apps', 'claude-code-bin', ARCH, process.platform === 'win32' ? 'claude.exe' : 'claude');
const RG = path.join(REPO, 'apps', 'ripgrep-bin', ARCH, process.platform === 'win32' ? 'rg.exe' : 'rg');
const available = fs.existsSync(CLAUDE) && fs.existsSync(RG) && process.platform !== 'win32';
const MODEL = 'claude-sonnet-4-5';

const noopLogger: Logger = {
  trace: () => {}, debug: () => {}, info: () => {}, warn: () => {}, error: () => {}, fatal: () => {},
  child: () => noopLogger,
};

function sse(events: unknown[]): string {
  return events.map((event) => `event: ${(event as { type: string }).type}\ndata: ${JSON.stringify(event)}\n\n`).join('');
}

function toolUse(step: number, name: string, input: unknown): string {
  return sse([
    { type: 'message_start', message: { id: `msg_${step}`, type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: `toolu_${step}_${randomUUID().slice(0, 6)}`, name, input: {} } },
    { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(input) } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 5 } },
    { type: 'message_stop' },
  ]);
}

function text(value: string): string {
  return sse([
    { type: 'message_start', message: { id: 'msg_text', type: 'message', role: 'assistant', model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0 } } },
    { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
    { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: value } },
    { type: 'content_block_stop', index: 0 },
    { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 3 } },
    { type: 'message_stop' },
  ]);
}

interface MainRequest {
  system: string;
  firstUser: string;
  toolNames: string[];
  results: Array<{ text: string; isError: boolean }>;
}

function contentText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content.map((part: { type?: string; text?: string }) => (part.type === 'text' ? part.text ?? '' : '')).join('');
}

describe.skipIf(!available)('remote agent with a real Claude Code', () => {
  let server: Server;
  let endpoint = '';
  let root = '';
  let steps: Array<{ name: string; input: unknown }> = [];
  const requests: MainRequest[] = [];
  const previousHome = process.env.HOME;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-hosted-')));
    // Claude Code 读写 ~/.claude：指向临时目录，不碰开发机的真实配置。
    process.env.HOME = path.join(root, 'home');
    fs.mkdirSync(process.env.HOME, { recursive: true });
    server = createServer((req, res) => {
      let body = '';
      req.on('data', (chunk) => { body += chunk; });
      req.on('end', () => {
        if (req.url?.includes('count_tokens')) {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end(JSON.stringify({ input_tokens: 100 }));
          return;
        }
        let parsed: { system?: unknown; tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> } = {};
        try {
          parsed = JSON.parse(body || '{}');
        } catch {
          parsed = {};
        }
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const toolNames = (parsed.tools ?? []).map((tool) => tool.name);
        // 只有带 cindy_exec 工具的主请求按脚本回；标题生成等辅助请求回一句话。
        if (!toolNames.some((name) => name.startsWith('mcp__cindy_exec__'))) {
          res.end(text('ok'));
          return;
        }
        const system = typeof parsed.system === 'string'
          ? parsed.system
          : Array.isArray(parsed.system) ? parsed.system.map((part: { text?: string }) => part.text ?? '').join('\n') : '';
        const results: MainRequest['results'] = [];
        let firstUser = '';
        for (const message of parsed.messages ?? []) {
          if (!firstUser && message.role === 'user') firstUser = contentText(message.content);
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') results.push({ text: contentText(block.content), isError: block.is_error === true });
          }
        }
        requests.push({ system, firstUser, toolNames, results });
        const step = steps[results.length];
        res.end(step ? toolUse(results.length, step.name, step.input) : text('all done'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    process.env.HOME = previousHome;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // Claude Code 退出时可能还在写 ~/.claude，重试几次再删。
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function claudeDeps(): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-test-key' }),
      },
      runtimeConfig: { endpoint },
      binaryPath: CLAUDE,
      logger: noopLogger,
    };
  }

  async function run(permissionMode: 'bypassPermissions' | 'default', resolve?: (request: InteractionRequest) => boolean) {
    const project = path.join(root, `project-${permissionMode}`);
    const hostRoot = path.join(root, `host-${permissionMode}`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the controller\n');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project memory\nAlways answer briefly.\n');
    const agent = new ClaudeCodeAgent(claudeDeps());
    const host = createRemoteAgentHost({
      isAgentAvailable: (kind) => kind === 'claude-code',
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: () => true,
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    const captured: string[] = [];
    const handle = await startRemoteAgentSession('claude-code', {
      sessionId: `cc-hosted-${permissionMode}`,
      workingDir: project,
      model: MODEL,
      permissionMode,
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
      collectProjectFiles: async () => [{ path: 'CLAUDE.md', data: fs.readFileSync(path.join(project, 'CLAUDE.md')).toString('base64') }],
      isGitRepo: async () => false,
      mapEvent: remoteAgentEventMapper,
      newId: randomUUID,
    });
    const asked: InteractionRequest[] = [];
    handle.setInteractionResolver(async (request) => {
      asked.push(request);
      const allow = resolve ? resolve(request) : true;
      return request.kind === 'permission'
        ? { kind: 'permission', behavior: allow ? 'allow' : 'deny', ...(allow ? {} : { reason: 'denied by test' }) }
        : { kind: 'permission', behavior: 'deny' };
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
    await handle.close({ reason: 'navigation' });
    host.dispose();
    return { project, hostRoot, events, asked, captured };
  }

  it('replaces the built-in file and shell tools and runs every step on the controller', { timeout: 120_000 }, async () => {
    const projectPath = path.join(root, 'project-bypassPermissions');
    steps = [
      { name: 'mcp__cindy_exec__Bash', input: { command: 'pwd; ls', description: 'Show location' } },
      { name: 'mcp__cindy_exec__Write', input: { file_path: path.join(projectPath, 'made.txt'), content: 'one\n' } },
      { name: 'mcp__cindy_exec__Read', input: { file_path: path.join(projectPath, 'hello.txt') } },
      { name: 'mcp__cindy_exec__Edit', input: { file_path: path.join(projectPath, 'made.txt'), old_string: 'one', new_string: 'two' } },
    ];
    requests.length = 0;
    const { project, hostRoot, events, captured } = await run('bypassPermissions');
    const first = requests[0];
    // 模型看不到只能操作本机的自带文件与命令工具。
    for (const builtin of ['Bash', 'Read', 'Write', 'Edit', 'NotebookEdit', 'Glob', 'Grep']) {
      expect(first.toolNames).not.toContain(builtin);
    }
    expect(first.toolNames).toEqual(expect.arrayContaining([
      'mcp__cindy_exec__Bash', 'mcp__cindy_exec__Read', 'mcp__cindy_exec__Write', 'mcp__cindy_exec__Edit',
      'mcp__cindy_exec__NotebookEdit', 'mcp__cindy_exec__BashOutput', 'mcp__cindy_exec__KillShell',
    ]));
    // 系统提示说明了项目的真实位置；项目说明来自同步的影子目录。
    expect(first.system).not.toContain(project);
    expect(first.system).toContain('# Workspace');
    expect(`${first.system}\n${first.firstUser}`).toContain('Always answer briefly.');
    const last = requests.at(-1)!;
    expect(last.results.map((result) => result.isError)).toEqual([false, false, false, false]);
    expect(last.results[0].text).not.toContain(project);
    expect(last.results[0].text).toContain(hostRoot);
    expect(last.results[0].text).toContain('hello.txt');
    expect(last.results[2].text).toContain('hello from the controller');
    expect(fs.readFileSync(path.join(project, 'made.txt'), 'utf8')).toBe('two\n');
    expect(captured).toContain(path.join(project, 'made.txt'));
    const hostFiles = fs.readdirSync(hostRoot, { recursive: true }).map(String);
    expect(hostFiles.some((file) => file.endsWith('made.txt'))).toBe(false);
    // 界面看到的仍是自带工具名。
    const toolNames = events.filter((event) => event.type === 'tool_use').map((event) => (event.data as { toolName: string }).toolName);
    expect(toolNames).toEqual(['Bash', 'Write', 'Read', 'Edit']);
  });

  it('asks on this computer for commands that change things, but not for reads and read-only commands', { timeout: 120_000 }, async () => {
    const projectPath = path.join(root, 'project-default');
    steps = [
      { name: 'mcp__cindy_exec__Read', input: { file_path: path.join(projectPath, 'hello.txt') } },
      { name: 'mcp__cindy_exec__Bash', input: { command: 'ls', description: 'List files' } },
      { name: 'mcp__cindy_exec__Bash', input: { command: 'touch approved.txt', description: 'Create file' } },
      { name: 'mcp__cindy_exec__Bash', input: { command: 'touch denied.txt', description: 'Create file' } },
    ];
    requests.length = 0;
    const { project, asked } = await run('default', (request) =>
      !(request.kind === 'permission' && String(request.input.command ?? '').includes('denied')));
    const permissionAsks = asked.filter((request): request is Extract<InteractionRequest, { kind: 'permission' }> => request.kind === 'permission');
    expect(permissionAsks.map((request) => [request.toolName, request.input.command])).toEqual([
      ['Bash', 'touch approved.txt'],
      ['Bash', 'touch denied.txt'],
    ]);
    expect(fs.existsSync(path.join(project, 'approved.txt'))).toBe(true);
    expect(fs.existsSync(path.join(project, 'denied.txt'))).toBe(false);
    const last = requests.at(-1)!;
    expect(last.results[0].isError).toBe(false);
    expect(last.results[1].isError).toBe(false);
    expect(last.results[3].isError).toBe(true);
  });
});
