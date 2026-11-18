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

import { createAnthropicCompatProxy, type ProxyHandle } from '@cindy/anthropic-compat-proxy';
import {
  ClaudeCodeAgent, NATIVE_SUBSCRIPTION_ACCOUNT, type AgentDeps, type AgentEvent,
  type BaseAgent, type AgentSessionHandle, type Session, type StartSessionOptions,
  type InteractionDecision, type InteractionRequest, type Logger,
} from '@cindy/maker-core';
import { buildUserProvider } from '@cindy/model-providers';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

// External authentication/status/quota use isolated fixtures. CLI execution,
// account selection/placement/bindings, hosted transport, message assembly and handoff are real.
const poolCli = vi.hoisted(() => ({ active: false, limited: new Set<string>(), signedOut: new Set<string>() }));
vi.mock('../../subscription-accounts/nativeCli.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../../subscription-accounts/nativeCli.js')>();
  return { ...actual,
    readNativeAccount: async (...args: Parameters<typeof actual.readNativeAccount>) => poolCli.active
      ? { authenticated: !poolCli.signedOut.has(args[1]), authSource: 'oauth', identity: args[1] } : actual.readNativeAccount(...args),
    readNativeAccountUsage: async (...args: Parameters<typeof actual.readNativeAccountUsage>) => poolCli.active
      ? { claudeUsage: { updatedAt: Date.now(), fiveHour: { utilization: poolCli.limited.has(args[1]) ? 100 : 10,
        resetsAt: Date.now() / 1000 + 3600 }, sevenDay: null, scoped: [] } } : actual.readNativeAccountUsage(...args),
  };
});
import { withSubscriptionAccounts } from '../../subscription-accounts/agent';
import { canSwitchHostedSubscriptionAccount, refreshSubscriptionPool, runSubscriptionAccountCommand } from '../../subscription-accounts/runtime';
import { accountDirectory, accountOwnerPrefix, readAccountBinding, updatePool } from '../../subscription-accounts/store';
import { accountProviderId, createSubscriptionProvider } from '../../subscription-accounts/placement';
import { subscriptionRouteAllowsModel } from '../../subscription-accounts/legacyAccountAccess';
import { activeOwnerScopeKey, commitVolatileAppSession, getActiveAppSession } from '../../appSessionState';
import { configureUserDataDir, getUserDataDir } from '../../userDataPath';
import { setRemoteProviderInvocationEnabled } from '../../maker-host/remote-provider-access-store';
import { createProviderGroupGuestSwitch } from '../../provider-group/guestSwitch';
import { createProviderGroupExternalLoad } from '../../provider-group/externalLoad';
import { createProviderGroupGuestRelay } from '../../provider-group/guestRelay';
import { createProviderGroupDirectory } from '../../provider-group/directory';
import { createProviderGroupRouter } from '../../provider-group/router';
import { createProviderGroupService } from '../../provider-group/service';
import { createMessagePersistence, type MessagePersistencePorts } from '../../messagePersistBroadcaster';
import { persistSessionStreamEventCore } from '../../maker-ipc/sessionEventStreamCore';
import { assistantSamplingSettlements } from '../../assistantSamplingSettlement';
import { relocateForFreshStart, type AgentSwitchSessionRow } from '../../maker-ipc/sessionAgentSwitchHandler';
import { createAgentHandoffPendingRegistry, prependHandoffToUserMessage, type HandoffSourceMessage } from '../../maker-ipc/agentHandoff';
import { hostSessionIdFor } from '../host/sessionIdentity';

import { remoteAgentEventMapper } from '../controller/eventMap';
import { startRemoteAgentSession } from '../controller/startRemote';
import { createRemoteAgentHost } from '../host/runHost';
import { hostedStartOptions } from '../host/service';
import { exerciseConnectionPool } from './poolHarness';
import { getActiveCatalog, setCustomProviders } from '../../maker-host/active-catalog';
import { createModelRoutingTransform, setClaudeProxyGatewayKeyReader, setClaudeProxySessionIdResolver } from '../../maker-host/anthropic-compat-proxy-host';
import { setCustomProviderKeyReader } from '../../maker-host/provider-route';
import { bindHostedSessionProvider, clearAllSessionProviders } from '../../maker-host/session-provider-store';
import { PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL } from '../../../shared/providerShareCredentialConsent';

const REPO = path.resolve(__dirname, '../../../../../..');
const ARCH = `${process.platform}-${process.arch}`;
const CLAUDE = path.join(REPO, 'apps', 'claude-code-bin', ARCH, process.platform === 'win32' ? 'claude.exe' : 'claude');
const RG = path.join(REPO, 'apps', 'ripgrep-bin', ARCH, process.platform === 'win32' ? 'rg.exe' : 'rg');
const available = fs.existsSync(CLAUDE) && fs.existsSync(RG);
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
  sdkSessionId: string;
  apiKey: string;
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
  /** 主请求原文(连接池场景看接回后模型拿到的历史)。 */
  const rawBodies: string[] = [];
  /** 设了就按它决定这一步(可看已有工具结果与最后一条用户消息)；返回 null 时回一句话。 */
  let script: ((ctx: { results: MainRequest['results']; lastUser: string }) => { name: string; input: unknown } | null) | null = null;

  beforeAll(async () => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-hosted-')));
    // Claude Code 读写 ~/.claude：指向临时目录，不碰开发机的真实配置。
    const isolatedHome = path.join(root, 'home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, isolatedHome);
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
        let lastUser = '';
        rawBodies.push(body);
        for (const message of parsed.messages ?? []) {
          if (!firstUser && message.role === 'user') firstUser = contentText(message.content);
          if (message.role === 'user' && contentText(message.content)) lastUser = contentText(message.content);
          if (!Array.isArray(message.content)) continue;
          for (const block of message.content as Array<Record<string, unknown>>) {
            if (block.type === 'tool_result') results.push({ text: contentText(block.content), isError: block.is_error === true });
          }
        }
        requests.push({
          system, firstUser, toolNames, results,
          sdkSessionId: String(req.headers['x-claude-code-session-id'] ?? ''),
          apiKey: String(req.headers['x-api-key'] ?? ''),
        });
        const step = script ? script({ results, lastUser }) : steps[results.length];
        res.end(step ? toolUse(results.length, step.name, step.input) : text('all done'));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });

  afterAll(async () => {
    vi.unstubAllEnvs();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    // 异步等待 CLI 退出并释放 Windows 文件句柄，避免同步重试挡住子进程收尾。
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  function claudeDeps(proxyEndpoint = endpoint): AgentDeps {
    return {
      auth: {
        getState: async () => ({ authenticated: true, identity: 'test', authSource: 'api-key' as const }),
        triggerLogin: async () => ({ authenticated: true }),
        logout: async () => {},
        getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'fake-test-key' }),
      },
      // This synthetic upstream implements tool_use, not Anthropic deferred tool
      // discovery. Keep the real CLI on the same non-deferred provider route.
      runtimeConfig: { endpoint: proxyEndpoint, behaviorFlags: { ENABLE_TOOL_SEARCH: 'false' } },
      binaryPath: CLAUDE,
      logger: noopLogger,
    };
  }

  async function run(
    permissionMode: 'bypassPermissions' | 'default',
    resolve?: (request: InteractionRequest) => boolean,
    route?: { endpoint: string; model: string; providerId: string; resolveHostedId?: boolean },
    initialPermissionMode = permissionMode,
    credentialConsent?: (request: InteractionRequest) => Promise<InteractionDecision>,
  ) {
    const project = path.join(root, `project-${permissionMode}`);
    const hostRoot = path.join(root, `host-${permissionMode}`);
    fs.mkdirSync(project, { recursive: true });
    fs.writeFileSync(path.join(project, 'hello.txt'), 'hello from the controller\n');
    fs.writeFileSync(path.join(project, 'CLAUDE.md'), '# Project memory\nAlways answer briefly.\n');
    if (credentialConsent) {
      fs.writeFileSync(path.join(project, '.env'), 'INVALID_FIXTURE=first');
      fs.writeFileSync(path.join(project, '.env.production'), 'INVALID_FIXTURE=second');
    }
    const agent = new ClaudeCodeAgent(claudeDeps(route?.endpoint));
    const host = createRemoteAgentHost({
      isAgentAvailable: (kind) => kind === 'claude-code',
      startHosted: (input) => agent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: () => true,
      ...(route ? {
        providerAccess: {
          resolve: async () => route.providerId,
          isAllowed: (providerId: string) => providerId === route.providerId,
        },
        bindOwnerProviderRoute: bindHostedSessionProvider,
      } : {}),
      captureOwner: () => 'owner',
      isOwnerCurrent: () => true,
      runsRoot: hostRoot,
    });
    if (route) setClaudeProxySessionIdResolver((sdkSessionId) => route.resolveHostedId === false ? null : host.resolveClaudeSessionId(sdkSessionId));
    const captured: string[] = [];
    const handle = await startRemoteAgentSession('claude-code', {
      sessionId: `cc-hosted-${permissionMode}`,
      workingDir: project,
      model: route?.model ?? MODEL,
      ...(route ? { providerId: route.providerId } : {}),
      permissionMode: initialPermissionMode,
    }, {
      invoke: async (args) => JSON.parse(JSON.stringify(await host.handle('controller-1', JSON.parse(JSON.stringify(args[0]))) ?? null)),
      rgPath: RG,
      prepareMcp: async () => ({ servers: new Map(), dispose() {} }),
      ...(credentialConsent ? { credentialConsent: { description: 'Fixture credential confirmation' } } : {}),
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
      if (credentialConsent) return credentialConsent(request);
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
    try {
      if (initialPermissionMode !== permissionMode) await handle.setPermissionMode!(permissionMode);
      await handle.send({ type: 'user', content: 'Do the scripted work.' });
      await done;
    } finally {
      await handle.close({ reason: 'navigation' });
      host.dispose();
    }
    return { project, hostRoot, events, asked, captured };
  }

  it.skipIf(process.platform === 'win32')('replaces the built-in file and shell tools and runs every step on the controller', { timeout: 120_000 }, async () => {
    const projectPath = path.join(root, 'project-bypassPermissions');
    steps = [
      { name: 'mcp__cindy_exec__Bash', input: { command: 'pwd; ls', description: 'Show location' } },
      { name: 'mcp__cindy_exec__Write', input: { file_path: path.join(projectPath, 'made.txt'), content: 'one\n' } },
      // The model sees the hosted workspace; a relative path stays within that
      // authorized root. The controller's absolute path is outside that scope.
      { name: 'mcp__cindy_exec__Read', input: { file_path: 'hello.txt' } },
      { name: 'mcp__cindy_exec__Edit', input: { file_path: path.join(projectPath, 'made.txt'), old_string: 'one', new_string: 'two' } },
    ];
    requests.length = 0;
    const { project, hostRoot, events, captured, asked } = await run('bypassPermissions');
    expect(requests.length, 'Claude did not send a request with the controller tools').toBeGreaterThan(0);
    expect(asked).toEqual([]);
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

  it.skipIf(process.platform === 'win32')('honors switching an existing hosted session to Full access without a confirmation', { timeout: 120_000 }, async () => {
    steps = [{ name: 'mcp__cindy_exec__Bash', input: { command: 'printf switched > switched.txt' } }];
    requests.length = 0;
    const { project, asked } = await run('bypassPermissions', undefined, undefined, 'default');
    expect(asked).toEqual([]);
    expect(fs.readFileSync(path.join(project, 'switched.txt'), 'utf8')).toBe('switched');
  });

  it.skipIf(process.platform === 'win32')('asks on this computer for commands that change things, but not for reads and read-only commands', { timeout: 120_000 }, async () => {
    const projectPath = path.join(root, 'project-default');
    steps = [
      { name: 'mcp__cindy_exec__Read', input: { file_path: 'hello.txt' } },
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

  // Bug: MCP 首次 HTTP 响应默认 60s，原 JSON 隧道把人工确认也算进去。
  // 生产入口：真实 ClaudeCodeAgent → runHost 隧道 → startRemoteAgentSession → 执行器。
  // 原 E2E 都立即回答；此处第 70s 授权，后续另一凭证读取应直接成功。tier: e2e(真实 CLI/计时)。
  it('keeps a credential confirmation alive past the MCP first-response timeout', { timeout: 120_000 }, async () => {
    const projectPath = path.join(root, 'project-bypassPermissions');
    steps = [
      { name: 'mcp__cindy_exec__Read', input: { file_path: path.join(projectPath, '.env') } },
      { name: 'mcp__cindy_exec__Read', input: { file_path: path.join(projectPath, '.env.production') } },
    ];
    requests.length = 0;
    let waited = false;
    const { asked } = await run('bypassPermissions', undefined, undefined, 'bypassPermissions', async () => {
      if (!waited) {
        waited = true;
        // real-wait: CLI 子进程的 60s HTTP 定时器不能由 Vitest fake timers 推进。
        await new Promise((resolve) => setTimeout(resolve, 70_000));
      }
      return { kind: 'permission', behavior: 'allow', permissionUpdates: [PROVIDER_SHARE_CREDENTIAL_SESSION_APPROVAL] };
    });
    expect(asked).toHaveLength(1);
    const results = requests.at(-1)!.results;
    expect(results.map((result) => result.isError)).toEqual([false, false]);
    expect(results[0].text).toContain('INVALID_FIXTURE=first');
    expect(results[1].text).toContain('INVALID_FIXTURE=second');
    expect(requests.every((request) => request.system === requests[0].system)).toBe(true);
    expect(requests.every((request) => JSON.stringify(request.toolNames) === JSON.stringify(requests[0].toolNames))).toBe(true);
  });

  it('releases an idle task under slot pressure and resumes the same conversation, keeping background commands here', { timeout: 300_000 }, async () => {
    const agent = new ClaudeCodeAgent(claudeDeps());
    let backgroundId = '';
    let afterStart = 0;
    // 第一轮在本机执行器里起一条后台命令；接回后那一轮用原来的 ID 读它的输出。
    script = ({ results, lastUser }) => {
      if (lastUser.includes('codeword PINEAPPLE') && results.length === afterStart) {
        return { name: 'mcp__cindy_exec__Bash', input: { command: 'echo bg-started; sleep 0.3; echo bg-done', run_in_background: true } };
      }
      if (lastUser.includes('What was the codeword') && results.length === afterStart + 1) {
        return { name: 'mcp__cindy_exec__BashOutput', input: { bash_id: backgroundId } };
      }
      return null;
    };
    try {
      await exerciseConnectionPool({
        kind: 'claude-code',
        root,
        model: MODEL,
        rgPath: RG,
        startHosted: (input) => agent.startSession(hostedStartOptions(input)),
        deps: { mapEvent: remoteAgentEventMapper },
        modelRequests: () => rawBodies,
        afterFirstTurn: () => {
          const started = requests.at(-1)!.results.at(-1)!.text;
          backgroundId = /with ID: (\S+?)\./.exec(started)?.[1] ?? '';
          expect(backgroundId).not.toBe('');
        },
        afterResumedTurn: () => {
          const output = requests.at(-1)!.results.at(-1)!;
          expect(output.isError).toBe(false);
          expect(output.text).toContain('bg-done');
        },
      });
    } finally {
      script = null;
    }
  });

  async function withProviderProxy(
    model: string,
    use: (proxyEndpoint: string, fallbackRequests: string[]) => Promise<void>,
    createProxy = createAnthropicCompatProxy,
  ): Promise<void> {
    const fallbackRequests: string[] = [];
    const fallback = createServer((req, res) => {
      if (req.method === 'POST' && req.url?.startsWith('/v1/messages')) fallbackRequests.push(req.url);
      req.resume();
      res.writeHead(200, { 'content-type': 'text/event-stream' }).end(text('FALLBACK'));
    });
    let proxy: ProxyHandle | undefined;
    try {
      await new Promise<void>((resolve, reject) => {
        fallback.once('error', reject);
        fallback.listen(0, '127.0.0.1', () => {
          fallback.removeListener('error', reject);
          resolve();
        });
      });
      const address = fallback.address();
      if (!address || typeof address === 'string') throw new Error('fallback server has no port');
      const fallbackEndpoint = `http://127.0.0.1:${address.port}`;
      setCustomProviders(['selected', 'other'].map((id) => buildUserProvider({
        id, name: id,
        runtimes: { 'claude-code': {
          baseUrl: id === 'selected' ? endpoint : fallbackEndpoint,
          wireProtocol: 'anthropic-messages', models: [{ id: model, name: model }],
        } },
      })));
      setCustomProviderKeyReader((id) => `${id}-native-test-key`);
      setClaudeProxyGatewayKeyReader(() => 'fake-test-key');
      proxy = await createProxy({ upstream: fallbackEndpoint, routingTransform: createModelRoutingTransform() });
      await use(proxy.url, fallbackRequests);
    } finally {
      try {
        await proxy?.dispose();
      } finally {
        try {
          if (fallback.listening) await new Promise<void>((resolve) => fallback.close(() => resolve()));
        } finally {
          setClaudeProxySessionIdResolver(() => null);
          setClaudeProxyGatewayKeyReader(() => null);
          setCustomProviderKeyReader(() => null);
          setCustomProviders([]);
          clearAllSessionProviders();
        }
      }
    }
  }

  it.skipIf(process.platform === 'win32')('cleans up the fallback server and provider settings when proxy startup fails', async () => {
    let fallbackEndpoint = '';
    const use = vi.fn(async () => {});
    const createProxy = vi.fn<typeof createAnthropicCompatProxy>(async (options) => {
      if (typeof options.upstream !== 'string') throw new Error('expected a literal test upstream');
      fallbackEndpoint = options.upstream;
      throw new Error('proxy startup failed');
    });
    await expect(withProviderProxy('hosted-shared-model', use, createProxy)).rejects.toThrow('proxy startup failed');
    expect(createProxy).toHaveBeenCalledOnce();
    expect(use).not.toHaveBeenCalled();
    expect(getActiveCatalog().providers.some((provider) => provider.id === 'selected' || provider.id === 'other')).toBe(false);
    await expect(fetch(fallbackEndpoint)).rejects.toThrow();
  });

  it.skipIf(process.platform === 'win32').each(['claude-sonnet-4-5-20250929', 'hosted-shared-model'])('routes the first real Claude SDK model request for %s to its selected provider', { timeout: 120_000 }, async (model) => {
    await withProviderProxy(model, async (proxyEndpoint, fallbackRequests) => {
      requests.length = 0;
      steps = [];
      if (model.startsWith('claude-')) {
        await run('bypassPermissions', undefined, { endpoint: proxyEndpoint, model, providerId: 'selected', resolveHostedId: false });
        expect(fallbackRequests.length).toBeGreaterThan(0);
        expect(requests).toEqual([]);
        fallbackRequests.length = 0;
      }
      await run('bypassPermissions', undefined, { endpoint: proxyEndpoint, model, providerId: 'selected' });
      expect(requests.length).toBeGreaterThan(0);
      expect(requests[0].sdkSessionId).toMatch(/^[0-9a-f-]{36}$/);
      expect(requests[0].sdkSessionId).not.toBe('cc-hosted-bypassPermissions');
      expect(requests.every((request) => request.apiKey === 'selected-native-test-key')).toBe(true);
      expect(fallbackRequests).toEqual([]);
    });
  });
});

/**
 * E2E regression: A's existing shared task must continue after an account merged
 * from B replaces its exhausted account. Older tests never connected a real CLI
 * to the allocator and only checked strings supplied to a fake native handle.
 * Minimum input: a real old Claude thread with a successful tool result, two
 * isolated CLI profiles, and an exhausted bound account on cold resume / send.
 * Tier: existing E2E (real CLI, loopback HTTP, real controller-side file tools).
 * OAuth status/quota and share authentication are fixtures; the CLI uses a fake
 * API key against loopback, preserving production's no-OAuth-redirect rule.
 * SQLite and Electron input-coordinator ports use an in-memory row store, while
 * message persistence, history-to-handoff generation and wire injection are real.
 */
describe.skipIf(!available || process.platform === 'win32')('shared account handoff with a real Claude CLI', () => {
  let root = '';
  let priorData = '';
  let priorSession: ReturnType<typeof getActiveAppSession>;
  beforeAll(() => {
    root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-cc-pool-handoff-')));
    const isolatedHome = path.join(root, 'home');
    fs.mkdirSync(isolatedHome, { recursive: true });
    for (const key of ['HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA']) vi.stubEnv(key, isolatedHome);
    // Re-root every account store and CLI home before creating fixture profiles.
    priorData = getUserDataDir();
    priorSession = getActiveAppSession();
    configureUserDataDir(path.join(root, 'profile'));
    commitVolatileAppSession('local', undefined, true);
    poolCli.active = true;
  });
  afterAll(async () => {
    poolCli.active = false;
    poolCli.limited.clear();
    poolCli.signedOut.clear();
    commitVolatileAppSession(priorSession.mode, priorSession.dataOwnerId, true);
    configureUserDataDir(priorData);
    vi.unstubAllEnvs();
    await fs.promises.rm(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  });

  async function exercise(original: 'a' | 'b', failure: 'cold' | 'run' | 'cold-auth' | 'send-auth', disconnectHandoff = false) {
    commitVolatileAppSession('local', undefined, true);
    poolCli.limited.clear();
    poolCli.signedOut.clear();
    const caseRoot = path.join(root, randomUUID());
    const project = path.join(caseRoot, 'project');
    fs.mkdirSync(project, { recursive: true });
    const marker = `CONTEXT_${randomUUID()}`;
    const completed = path.join(project, 'completed-step.txt');
    const remaining = path.join(project, 'remaining-step.txt');
    const task = randomUUID();
    const shareRoute = `share:${randomUUID()}`;
    const guest = `share-guest-${randomUUID()}`;
    const accounts = Object.fromEntries(['a', 'b'].map(id => [id, `cindy-${accountOwnerPrefix()}-${randomUUID()}`]));
    const replacement = original === 'a' ? 'b' : 'a';
    await updatePool('anthropic', () => ({ strategy: 'order', accounts: Object.values(accounts).map(id => ({ id, paused: false, limit: 4, weight: 1 })) }));
    // A's published entry remains fixed in either account direction. B is
    // merged only after A's original native task has produced durable history.
    const published = await createSubscriptionProvider('anthropic', accounts[original], 'Fixture A', () => randomUUID().replaceAll('-', '').slice(0, 8));
    const donor = await createSubscriptionProvider('anthropic', accounts[replacement], 'Fixture B', () => randomUUID().replaceAll('-', '').slice(0, 8));
    await setRemoteProviderInvocationEnabled(published, true);
    const row: AgentSwitchSessionRow = { id: task, status: 'active', agentKind: 'cc', model: MODEL,
      providerId: published, agentDeviceId: shareRoute, remoteHostId: null, orcaRole: null, sdkSessionId: null, workingDir: project };
    const history: Array<HandoffSourceMessage & { clientId: string; sessionId: string }> = [];
    const pending = createAgentHandoffPendingRegistry(async () => null);
    const persistence = createMessagePersistence({
      assistantSamplingSettlements, broadcastTap: { captureDataOwnerBroadcastScope: () => null },
      createDbMessage: async (sessionId: string, body: Record<string, unknown>) => {
        const stored = { ...body, sessionId, createdAt: body.createdAt ?? Date.now() };
        history.push(stored as typeof history[number]); return stored;
      },
      updateDbMessageContent: async (_id: string, clientId: string, content: unknown) => {
        const stored = history.find(item => item.clientId === clientId); if (stored) stored.content = content; return stored;
      },
      broadcastMessageRow: async () => {}, broadcastMessageAgentMetaUpdate: async () => {},
      commitMessageMediaRefs: async () => {}, findVisibleToolUseMessageByAliases: async () => null,
      onPersistenceError: (error: unknown) => { throw error; },
    } as unknown as MessagePersistencePorts);
    persistence.noteSessionAgentKind(task, 'cc');
    const observations: Array<{ nativeId: string; body: string }> = [];
    let oldNative = '';
    let failOriginal = false;
    const server = createServer((req, res) => {
      let body = '';
      req.on('data', chunk => { body += chunk; });
      req.on('end', () => {
        if (req.url?.includes('count_tokens')) { res.writeHead(200, { 'content-type': 'application/json' }).end('{"input_tokens":100}'); return; }
        const parsed = JSON.parse(body || '{}') as { tools?: Array<{ name: string }>; messages?: Array<{ role: string; content: unknown }> };
        if (!parsed.tools?.some(tool => tool.name.startsWith('mcp__cindy_exec__'))) {
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(text('ok')); return;
        }
        const nativeId = String(req.headers['x-claude-code-session-id'] ?? '');
        observations.push({ nativeId, body });
        if (failOriginal && nativeId === oldNative) {
          res.writeHead(429, { 'content-type': 'application/json', 'retry-after': '0' })
            .end(JSON.stringify({ type: 'error', error: { type: 'rate_limit_error', message: 'usage limit exceeded' } })); return;
        }
        const results = (parsed.messages ?? []).flatMap(message => Array.isArray(message.content)
          ? message.content.filter((block: { type?: string }) => block.type === 'tool_result') : []);
        if (nativeId === oldNative) {
          const step = results.length === 0
            ? toolUse(0, 'mcp__cindy_exec__Bash', { command: `printf '%s\n' '${marker}' > completed-step.txt; cat completed-step.txt`, description: 'Finish step one and return its receipt' })
            : text('Step one completed. Remaining step two: write remaining-step.txt with exactly the receipt from step one. Do not repeat step one.');
          res.writeHead(200, { 'content-type': 'text/event-stream' }).end(step); return;
        }
        // The new CLI must obtain its receipt from the production handoff. The
        // gateway does not insert the known marker if the new request lacks it.
        const transferred = body.match(/CONTEXT_[0-9a-f-]{36}/)?.[0];
        const hasPlan = body.includes('Remaining step two:') && body.includes('Do not repeat step one.');
        const answer = transferred && hasPlan
          ? results.length === 0 ? toolUse(0, 'mcp__cindy_exec__Write', { file_path: remaining, content: transferred }) : text('Remaining step completed.')
          : text('MISSING_HANDOFF_CONTEXT');
        res.writeHead(200, { 'content-type': 'text/event-stream' }).end(answer);
      });
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    const endpoint = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const engines = new Map<string, ClaudeCodeAgent>();
    const startupAuthDenied = new Set<string>();
    const starts: StartSessionOptions[] = [];
    const nativeAgent = withSubscriptionAccounts({ kind: 'claude-code', startSession: async (options: StartSessionOptions) => {
      starts.push(options);
      const profile = options[NATIVE_SUBSCRIPTION_ACCOUNT]!.configDir;
      let engine = engines.get(profile);
      if (!engine) {
        engine = new ClaudeCodeAgent({ binaryPath: CLAUDE, logger: noopLogger,
          runtimeConfig: { endpoint, behaviorFlags: { ENABLE_TOOL_SEARCH: 'false', CLAUDE_CODE_MAX_RETRIES: '0' } },
          auth: { getState: async () => ({ authenticated: !startupAuthDenied.has(profile), authSource: 'api-key' }),
            triggerLogin: async () => ({ authenticated: true }), logout: async () => {},
            getAuthEnv: async () => ({ ANTHROPIC_API_KEY: 'invalid-pool-e2e-key', CLAUDE_CONFIG_DIR: profile }) },
        });
        engines.set(profile, engine);
      }
      // Real SDK/CLI execution in the selected profile. Synthetic API transport
      // is deliberate: native subscription auth must never be redirected to a test gateway.
      // The fixture adapter selects a normal custom API source only below the
      // real pool lease. It preserves the chosen account's isolated config dir;
      // the task/share/provider, allocator and host admission above stay intact.
      return engine.startSession({ ...options, providerId: 'pool-e2e-loopback',
        deviceHosted: { ...options.deviceHosted!, guestProvider: options.deviceHosted?.guestProvider
          ? { ...options.deviceHosted.guestProvider, providerId: 'pool-e2e-loopback' } : undefined } });
    } } as unknown as BaseAgent);
    const guestSwitch = createProviderGroupGuestSwitch();
    const order: string[] = [];
    const directory = createProviderGroupDirectory({ listLocalProviders: async () => [], localDeviceName: () => 'fixture',
      listDevices: async () => [], readDeviceProviders: async () => [], listReceivedShares: () => [], isMobilePlatform: () => false, now: Date.now });
    const router = createProviderGroupRouter({ directory, readGroup: () => null, listBindings: () => ({}), isTurnRunning: () => false, now: Date.now, random: () => 0 });
    const externalLoad = createProviderGroupExternalLoad({ now: Date.now });
    const host = createRemoteAgentHost({ runsRoot: path.join(caseRoot, 'host'),
      isAgentAvailable: kind => kind === 'claude-code', startHosted: input => nativeAgent.startSession(hostedStartOptions(input)),
      isControllerAuthorized: controller => controller === guest, controllerTrust: () => 'guest',
      providerAccess: { resolve: async () => published, isAllowed: (provider, _controller, model) => provider === published && subscriptionRouteAllowsModel(provider, model, { remote: true }) },
      bindGuestProviderRoute: async () => ({ routeToken: 'fixture-guest-route', modelIds: [MODEL], release() {} }),
      captureOwner: activeOwnerScopeKey, isOwnerCurrent: owner => owner === activeOwnerScopeKey(),
      canSwitchLocalAccount: input => canSwitchHostedSubscriptionAccount(input.providerId, input.hostSessionId, input.model),
      groupRelay: createProviderGroupGuestRelay({ readGroup: () => null, scope: () => ({ router, externalLoad, isCurrent: () => true }),
        connect: () => { throw new Error('Fixture has no remote member'); }, now: Date.now, log: { warn() {} } }),
    });
    const handles: AgentSessionHandle[] = [];
    const perHandleEvents = new Map<AgentSessionHandle, AgentEvent[]>();
    const events: AgentEvent[] = [];
    let active!: AgentSessionHandle;
    const open = async (resume?: string) => {
      try {
        active = await startRemoteAgentSession('claude-code', { sessionId: task, workingDir: project, model: MODEL,
          providerId: published, permissionMode: 'bypassPermissions', ...(resume ? { resumeSessionId: resume } : {}) }, {
          invoke: async args => JSON.parse(JSON.stringify(await host.handle(guest, JSON.parse(JSON.stringify(args[0]))) ?? null)),
          rgPath: RG, prepareMcp: async () => ({ servers: new Map(), dispose() {} }), collectProjectFiles: async () => [],
          isGitRepo: async () => false, mapEvent: remoteAgentEventMapper, newId: randomUUID,
          groupSwitch: { token: guestSwitch.takeForOpen(task), offer: token => { order.push('token'); guestSwitch.offer(task, token); } },
        });
        handles.push(active);
        const opened = active;
        const localEvents: AgentEvent[] = []; perHandleEvents.set(opened, localEvents);
        row.sdkSessionId = active.id; guestSwitch.release(task);
        active.setInteractionResolver(async () => ({ kind: 'permission', behavior: 'allow' }));
        void (async () => {
          for await (const event of opened.events()) {
            localEvents.push(event); events.push(event); order.push(event.type);
            persistSessionStreamEventCore({ persistence, orcaTeamServiceForEvents: null, log: noopLogger,
              broadcastSubagentRunsChanged() {} }, { id: task, workDir: project } as Session, { event, eventAgentMeta: null });
            if (event.type === 'done' || event.type === 'error') {
              persistence.flushAssistantBlock(task); persistence.flushOrphanToolResults(task, null);
            }
          }
        })();
      } catch (error) { order.push('start-failed'); throw error; }
    };
    const relocate = async (isCurrent = () => true) => {
      await active.close({ reason: 'navigation' });
      await persistence.drainPersistQueue();
      const relocated = await relocateForFreshStart({ getSessionRow: async () => ({ ...row }),
        listMessagesForHandoff: async () => structuredClone(history),
        applyAgentSwitchToDb: async (_id, patch) => { Object.assign(row, patch); }, setSessionProvider() {},
        insertBoundaryMessage: async () => randomUUID(), applyResumeFallbackAtomically: async () => {},
        setPendingHandoff: (id, note, generation) => { if (!disconnectHandoff) pending.set(id, note, generation); },
        readPendingHandoffGeneration: id => pending.readGeneration(id), log: noopLogger,
      }, { sessionId: task, providerId: published, agentDeviceId: shareRoute, sharedRelocation: true,
        assertCurrent: () => { if (!isCurrent()) throw new Error('superseded'); } });
      expect(relocated.nativeId).toBeNull();
    };
    const sendContinuation = async () => {
      await open();
      const message = { type: 'user' as const, content: 'Continue the remaining work.' };
      const note = await pending.peek(task);
      const wire = note ? prependHandoffToUserMessage(message, note) : message;
      await active.send(wire as Parameters<AgentSessionHandle['send']>[0]);
      pending.consume(task);
      await vi.waitFor(() => expect(perHandleEvents.get(active)?.some(event => event.type === 'done')).toBe(true), { timeout: 30_000, interval: 20 });
      return 'resumed' as const;
    };
    const service = createProviderGroupService({ router, directory, readGroup: () => null,
      readBinding: () => null, writeBinding: async () => {}, isReleased: () => false, markReleased: async () => {},
      readSessionRow: async () => ({ ...row, agentDeviceId: shareRoute, agentKind: 'claude-code' }), resolveImplicitProvider: async () => published,
      persistRoute: async () => {}, hasAssistantHistory: async () => true, isFailoverEligible: async () => true,
      leaseRecovery: () => ({}), isLeaseCurrent: () => true, rearmContinue: () => 2, cancelContinue() {},
      switchAgentLocation: async (_id, _route, opts) => relocate(opts?.isCurrent),
      isTurnRunning: () => false, hasLiveSession: () => true, continueSession: sendContinuation,
      fallback: () => { throw new Error('Unexpected fallback'); }, readResetAt: () => null, now: Date.now,
      guestSwitch, log: noopLogger,
    });
    try {
      await open(); oldNative = active.id;
      const user = 'Complete step one, report its receipt and the remaining step, then wait.';
      history.push({ clientId: randomUUID(), sessionId: task, role: 'user', content: user, createdAt: Date.now() });
      await active.send({ type: 'user', content: user });
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done')).toHaveLength(1), { timeout: 30_000, interval: 20 });
      await persistence.drainPersistQueue();
      expect(observations.some(request => request.nativeId === oldNative)).toBe(true);
      expect(fs.readFileSync(completed, 'utf8').trim()).toBe(marker);
      expect(history.some(message => message.role === 'tool_result' && JSON.stringify(message.content).includes(marker))).toBe(true);
      expect(history.some(message => message.role === 'assistant' && JSON.stringify(message.content).includes('Remaining step two:'))).toBe(true);
      await runSubscriptionAccountCommand({ action: 'merge', providerId: donor, target: published });
      expect(accountProviderId('anthropic', accounts[replacement])).toBe(published);
      const originalDir = accountDirectory('anthropic', accounts[original]);
      const hostTask = hostSessionIdFor(guest, task);
      expect(readAccountBinding(`native:${oldNative}`, 'anthropic')?.accountId).toBe(accounts[original]);
      if (failure === 'cold' || failure === 'cold-auth') {
        await active.close({ reason: 'navigation' });
        if (failure === 'cold-auth') startupAuthDenied.add(originalDir);
        else {
          poolCli.limited.add(originalDir);
          await refreshSubscriptionPool(published, true);
        }
        // cold-auth passes cached allocator admission, then the real
        // ClaudeCodeAgent auth gate throws its definite no-process error.
        await expect(open(oldNative)).rejects.toThrow(failure === 'cold-auth' ? 'not authenticated' : 'SUBSCRIPTION_ACCOUNT_LIMITED');
        expect(order).toContain('token');
        expect(order.indexOf('token')).toBeLessThan(order.indexOf('start-failed'));
        const recovery = await service.prepareGuestStartSwitch(task);
        expect(recovery).not.toBeNull();
        try { await relocate(recovery!.isCurrent); } finally { recovery!.dispose(); }
        await sendContinuation();
      } else {
        if (failure === 'send-auth') {
          poolCli.signedOut.add(originalDir);
          await updatePool('anthropic', value => ({ ...value, accounts: value.accounts.map(account => account.id === accounts[original]
            ? { ...account, reloginIdentity: 'previous@example.invalid' } : account) }));
          await refreshSubscriptionPool(published, true);
          const originalRequests = observations.filter(request => request.nativeId === oldNative).length;
          await expect(active.send({ type: 'user', content: 'Continue the remaining work.' })).rejects.toThrow('SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED');
          expect(observations.filter(request => request.nativeId === oldNative)).toHaveLength(originalRequests);
        } else {
          failOriginal = true;
          await active.send({ type: 'user', content: 'Continue the remaining work.' });
        }
        await vi.waitFor(() => expect(events.some(event => event.type === 'error')).toBe(true), { timeout: 30_000, interval: 20 });
        expect(order.indexOf('token')).toBeLessThan(order.indexOf('error'));
        expect(guestSwitch.hasOffer(task)).toBe(true);
        if (failure === 'send-auth') {
          const authError = events.find(event => event.type === 'error')!.data as { message: string; usageLimit?: boolean };
          expect(authError.message).toContain('SUBSCRIPTION_ACCOUNT_LOGIN_REQUIRED');
          expect(authError.usageLimit).not.toBe(true);
          expect(events.filter(event => event.type === 'error')).toHaveLength(1);
        }
        await service.onTurnError(task, events.find(event => event.type === 'error')!.data as { sdkError: string }, 1);
      }
      await vi.waitFor(() => expect(events.filter(event => event.type === 'done').length).toBeGreaterThanOrEqual(2), { timeout: 30_000, interval: 20 });
      const freshNative = active.id;
      expect(freshNative).not.toBe(oldNative);
      expect(readAccountBinding(`native:${oldNative}`, 'anthropic')?.accountId).toBe(accounts[original]);
      expect(readAccountBinding(`native:${freshNative}`, 'anthropic')?.accountId).toBe(accounts[replacement]);
      expect(readAccountBinding(`task:${hostTask}`, 'anthropic')?.accountId).toBe(accounts[replacement]);
      expect(starts.at(-1)?.resumeSessionId).toBeUndefined();
      // Inspect only native transcript filenames, never auth/config file contents.
      const originalFiles = fs.readdirSync(originalDir, { recursive: true }).map(String);
      const replacementFiles = fs.readdirSync(accountDirectory('anthropic', accounts[replacement]), { recursive: true }).map(String);
      expect(originalFiles.some(file => file.endsWith(`${oldNative}.jsonl`))).toBe(true);
      expect(originalFiles.some(file => file.endsWith(`${freshNative}.jsonl`))).toBe(false);
      expect(replacementFiles.some(file => file.endsWith(`${freshNative}.jsonl`))).toBe(true);
      expect(replacementFiles.some(file => file.endsWith(`${oldNative}.jsonl`))).toBe(false);
      expect(row).toMatchObject({ id: task, providerId: published, agentDeviceId: shareRoute });
      const freshRequests = observations.filter(request => request.nativeId === freshNative);
      expect(freshRequests.length).toBeGreaterThan(0);
      if (disconnectHandoff) {
        expect(freshRequests.every(request => !request.body.includes(marker))).toBe(true);
        expect(fs.existsSync(remaining)).toBe(false);
      }
      expect(freshRequests[0].body.includes(marker), 'fresh CLI request must include old tool receipt').toBe(true);
      expect(freshRequests[0].body).toContain('Remaining step two:');
      expect(freshRequests[0].body).toContain('Do not repeat step one.');
      expect(fs.readFileSync(remaining, 'utf8')).toBe(marker);
      expect(fs.readFileSync(completed, 'utf8').trim()).toBe(marker);
      expect(events.some(event => event.type === 'tool_use' && JSON.stringify(event.data).includes('Write'))).toBe(true);
      expect(events.filter(event => event.type === 'tool_use' && (event.data as { toolName?: string }).toolName === 'Bash')).toHaveLength(1);
    } finally {
      for (const handle of handles) await handle.close({ reason: 'navigation' }).catch(() => undefined);
      await host.dispose();
      await persistence.drainPersistQueue();
      persistence.clearSessionPersistState(task);
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  }

  it.each(['a', 'b'].flatMap(original => ['cold', 'run'].map(failure => ({ original, failure }))))(
    'continues the same shared task from account $original after $failure exhaustion', { timeout: 90_000 },
    async ({ original, failure }) => exercise(original as 'a' | 'b', failure as 'cold' | 'run'));
  it.each(['cold-auth', 'send-auth'] as const)('continues the same shared task after %s rejection without relabeling it as quota', { timeout: 90_000 },
    async failure => exercise('a', failure));
  it('fails to finish the remaining action when the production handoff sink is disconnected', { timeout: 90_000 }, async () => {
    await expect(exercise('a', 'cold', true)).rejects.toThrow('fresh CLI request must include old tool receipt');
  });
});
