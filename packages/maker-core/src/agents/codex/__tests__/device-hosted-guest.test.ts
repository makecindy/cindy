/**
 * 设备托管会话属于另一个账号(供应商分享的受邀者)时，Codex 不带本机用户的插件、技能、MCP、
 * hooks、connectors、记忆、全局说明、插件清单与通讯录说明；经隧道的 MCP 与受邀者带来的技能
 * 保持可用，联网搜索不变；只用分享的供应商(独占的 app-server 带上它，不开 spawn 的模型覆写)。
 * 同账号托管会话不变。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, DeviceHostedSession } from '../../base-agent.js';
import type { Logger } from '../../../interfaces/logger.js';
import { AppServerClient, type RequestProgressDeadline } from '../app-server/client.js';
import { Method } from '../app-server/protocol.js';
import type { CloseHandler, LineHandler, Transport } from '../app-server/transport.js';
import { withoutCodexSpawnModelOverrides } from '../device-hosted-guest.js';
import { CodexAgent } from '../index.js';

vi.mock('../app-server/stdioTransport.js', () => ({
  createStdioTransport: () => {
    throw new Error('tests must not spawn a real Codex app-server');
  },
}));

const GHOST_ROSTER = 'HOST GHOST ROSTER';
const tempDirs: string[] = [];
const agents: CodexAgent[] = [];

function noopLogger(): Logger {
  const logger: Logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return logger; },
  };
  return logger;
}

/** 假传输：让 profile 生命周期请求走真实 AppServerClient 的 pending/超时逻辑。 */
class FakeAppServerTransport implements Transport {
  readonly lines: string[] = [];
  private readonly lineHandlers = new Set<LineHandler>();
  private readonly closeHandlers = new Set<CloseHandler>();

  async writeLine(line: string): Promise<void> {
    this.lines.push(line);
  }

  onLine(handler: LineHandler): () => void {
    this.lineHandlers.add(handler);
    return () => this.lineHandlers.delete(handler);
  }

  onStderr(): () => void {
    return () => undefined;
  }

  onClose(handler: CloseHandler): () => void {
    this.closeHandlers.add(handler);
    return () => this.closeHandlers.delete(handler);
  }

  async close(): Promise<void> {}

  emitLine(value: unknown): void {
    const line = JSON.stringify(value);
    for (const handler of this.lineHandlers) handler(line);
  }
}

/**
 * 让 profile 替换请求走真实 AppServerClient + 假传输(#5774 review)：请求的
 * timeoutMs/extendWhileProgress 由 AppServerClient 的 pending 超时逻辑真实执行，
 * 才能验证接受期限收口后晚到响应仍被 pending 收下、晚到窗口结束后请求被清除。
 * 受控 Promise 会绕过内层超时，即使两层同上限丢响应也测不出来。
 */
function installRealAppServerReplacement(fixture: Awaited<ReturnType<typeof startHosted>>) {
  const transport = new FakeAppServerTransport();
  const client = new AppServerClient({ createTransport: () => transport, logger: noopLogger() });
  client.start();
  const baseRequest = fixture.request.getMockImplementation()!;
  let replacementGated = false;
  let inner: Promise<unknown> = Promise.resolve(undefined);
  fixture.request.mockImplementation(async (
    method: string,
    params: unknown,
    options?: { timeoutMs?: number; extendWhileProgress?: RequestProgressDeadline },
  ) => {
    // startSession 的首次 thread/start 已经发完；此后唯一的 ThreadStart 就是 profile 替换。
    if (method === Method.ThreadStart && !replacementGated) {
      replacementGated = true;
      inner = client.request(method, params, options);
      return inner;
    }
    return baseRequest(method, params);
  });
  return {
    client,
    transport,
    lastRequestId: () => (JSON.parse(transport.lines.at(-1)!) as { id: number }).id,
    innerSettled: () => inner.then(
      () => ({ ok: true }),
      (error: Error) => ({ ok: false, message: error.message }),
    ),
  };
}

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

interface Fixture {
  guest: boolean;
  codexHomeInstructions?: string;
  resume?: boolean;
  /**
   * 受邀者目录(远程 Agent 运行根下按控制端分开)：Codex 用其中的 codex 子目录作 CODEX_HOME。
   * 受邀者默认有；显式 false 模拟没有受邀者目录的旧接线。
   */
  guestHome?: boolean;
  /** 受邀者启动时用的来源；默认就是分享的供应商(xd)。 */
  providerId?: string;
  /** app-server 不给功能清单(旧版本或出错)。 */
  noFeatureList?: boolean;
  /** 宿主提供的任务隧道往来记录。 */
  linkActivity?: DeviceHostedSession['linkActivity'];
}

/** app-server 的功能清单，分两页返回。 */
const FEATURE_PAGES: Record<string, { data: Array<{ name: string; stage: string; enabled: boolean }>; nextCursor: string | null }> = {
  first: {
    data: [
      { name: 'shell_tool', stage: 'stable', enabled: true },
      { name: 'view_image', stage: 'stable', enabled: true },
      { name: 'shell_snapshot', stage: 'stable', enabled: true },
      { name: 'image_generation', stage: 'stable', enabled: true },
      { name: 'in_app_local_automation', stage: 'stable', enabled: true },
      { name: 'network_proxy', stage: 'beta', enabled: false },
    ],
    nextCursor: 'page-2',
  },
  'page-2': {
    data: [
      { name: 'multi_agent', stage: 'stable', enabled: true },
      { name: 'item_ids', stage: 'removed', enabled: true },
      { name: 'web_search_request', stage: 'deprecated', enabled: false },
      { name: 'future_local_tool', stage: 'underDevelopment', enabled: true },
    ],
    nextCursor: null,
  },
};

const SHARED_PROVIDER = { providerId: 'xd', modelIds: ['gpt-5.5'], routeToken: 'route-token' };

async function startHosted(fixture: Fixture) {
  const sessionRoot = path.join(await makeTempDir('maker-core-codex-guest-'), 'workspaces', 'c1', 's1');
  const mirrorRoot = path.join(sessionRoot, 'fs');
  const workingDir = path.join(mirrorRoot, 'workspace');
  await fs.mkdir(workingDir, { recursive: true });
  const codexHome = await makeTempDir('maker-core-codex-home-');
  if (fixture.codexHomeInstructions !== undefined) {
    await fs.writeFile(path.join(codexHome, 'AGENTS.md'), fixture.codexHomeInstructions);
  }
  const hostSkill = path.join(codexHome, 'skills', 'private', 'SKILL.md');
  const systemSkill = path.join(codexHome, 'skills', '.system', 'imagegen', 'SKILL.md');
  const pluginSkill = path.join(codexHome, 'plugins', 'cache', 'personal', 'secret-plugin', '1.0.0', 'skills', 's', 'SKILL.md');
  const guestSkill = path.join(workingDir, '.agents', 'skills', 'guest', 'SKILL.md');

  const getGhostRosterPrompt = vi.fn(() => GHOST_ROSTER);
  const getContactsPromptState = vi.fn(() => 'enabled' as const);
  const getDisabledSkillPaths = vi.fn(() => [hostSkill]);
  const prepareCodexSkills = vi.fn(async () => {});
  const prepareCodexResumeSession = vi.fn(async () => undefined);
  const resolveCodexThreadStorage = vi.fn(async () => undefined);
  const recordCodexThreadLocation = vi.fn(async () => {});
  const guestHome = (fixture.guestHome ?? fixture.guest)
    ? path.join(await makeTempDir('maker-core-guest-home-'), 'c1')
    : undefined;
  const deps: AgentDeps = {
    auth: {
      async getState() { return { authenticated: true }; },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    },
    runtimeConfig: {
      systemPrompt: 'GLOBAL CINDY HOST PROMPT',
      taskShellEnv: () => ({ CINDY_INPUT_HANDOFF_ROUTE: 'host-route' }),
    },
    binaryPath: process.execPath,
    logger: noopLogger(),
    getGhostRosterPrompt,
    getContactsPromptState,
    getDisabledSkillPaths,
    prepareCodexSkills,
    prepareCodexResumeSession,
    resolveCodexThreadStorage,
    recordCodexThreadLocation,
  };
  const agent = new CodexAgent(deps);
  // 斜杠技能解析走工具宿主的技能清单；测试里直接给出同一份清单。
  Object.defineProperty(agent, 'listSkillsForCwd', {
    value: async () => ({ skills: skillList(), errors: [] }),
  });
  agents.push(agent);

  function skillList() {
    return [
      { name: 'private', description: 'host', path: hostSkill, scope: 'user' as const, enabled: true },
      { name: 'imagegen', description: 'bundled', path: systemSkill, scope: 'system' as const, enabled: true },
      { name: 's', description: 'plugin', path: pluginSkill, scope: 'user' as const, enabled: true },
      { name: 'guest', description: 'guest', path: guestSkill, scope: 'repo' as const, enabled: true },
    ];
  }
  const request = vi.fn(async (method: string, params: unknown): Promise<unknown> => {
    switch (method) {
      case Method.SkillsList: {
        const { cwds = [workingDir] } = params as { cwds?: string[] };
        return { data: cwds.map((cwd) => ({ cwd, skills: skillList(), errors: [] })) };
      }
      case Method.ConfigRead:
        return {
          config: {
            mcp_servers: {
              local_docs: { command: '/usr/bin/local-docs', enabled: true },
              cindy_contacts: { url: 'http://127.0.0.1:9/mcp/cindy_contacts', enabled: true },
            },
            plugins: {
              'configured@personal': {
                mcp_servers: { configured_server: { url: 'https://example.invalid/mcp' } },
              },
            },
          },
        };
      case Method.McpServerStatusList:
        return {
          data: [
            { name: 'codex_apps', tools: {} },
            { name: 'local_docs', tools: {} },
            { name: 'cindy_contacts', tools: {} },
            { name: 'configured_server', tools: {} },
          ],
          nextCursor: null,
        };
      case Method.EnvironmentAdd:
        return {};
      case Method.ExperimentalFeatureList:
        if (fixture.noFeatureList) throw new Error('unknown method');
        return FEATURE_PAGES[(params as { cursor?: string }).cursor ?? 'first'];
      case Method.ThreadStart:
        return {
          thread: { id: 'start-thread-id', ...(reportedHome !== codexHome ? { path: path.join(reportedHome, 'sessions', 'rollout.jsonl') } : {}) },
          model: 'gpt-5.5', modelProvider: 'openai', cwd: workingDir,
        };
      case Method.ThreadResume:
        return { thread: { id: 'resume-thread-id' }, model: 'gpt-5.5', modelProvider: 'openai', cwd: workingDir };
      case Method.ThreadFork:
        return { thread: { id: 'fork-thread-id' }, model: 'gpt-5.5', modelProvider: 'openai' };
      case Method.TurnStart:
        return { turn: { id: 'turn-1' } };
      default:
        return {};
    }
  });
  // 真实的 app-server 报告的是它实际使用的 CODEX_HOME：受邀者会话是受邀者目录。
  let reportedHome = codexHome;
  const host = {
    activeSubscriptions: 0,
    retire: vi.fn(async () => {}),
    notifySubscribersOfForcedRetire: vi.fn(),
    ensureStarted: vi.fn(async () => ({ userAgent: 'mock-codex/0.159.2', codexHome: reportedHome })),
    ensureStartedWithTimeout: vi.fn(async () => ({ userAgent: 'mock-codex/0.159.2', codexHome: reportedHome })),
    request,
    subscribeThread: vi.fn(() => ({ release: vi.fn() })),
    unsubscribeThread: vi.fn(async () => {}),
    hasThreadSubscription: vi.fn(() => false),
    isCodexProxyActive: vi.fn(() => false),
    isCodexBrowserUseAvailable: vi.fn(() => false),
    getCodexBrowserUseVersion: vi.fn(() => null),
    waitForMcpTool: vi.fn(async () => false),
    getRemoteCompactionProviderId: vi.fn(() => null),
    getCindyRemoteCompactionProviderId: vi.fn(() => null),
    getLocalCompactionProviderId: () => null,
    getCustomProviderModelProviderId: vi.fn(() => null),
    getCustomProviderThreadPolicy: vi.fn(() => ({ dynamicIdentity: false, disableSubagents: false, disableModelOverrides: false })),
    getSessionMcpConfig: vi.fn(() => ({})),
    getSubagentModelFallback: vi.fn(() => undefined),
    getSubagentRoute: vi.fn(() => undefined),
    getObservedSubagentIdentity: vi.fn(() => undefined),
    getOpenAiWebSocketsEnabled: vi.fn(() => true),
    getConnectionId: () => 'test-connection',
    reserveDescendantLineage: vi.fn(),
    registerDescendantLineage: vi.fn(),
    discardPendingDescendantLineage: vi.fn(),
  };
  const getHost = vi.fn(async (_remoteHostId?: string, _mode?: string, options?: { keyOverride?: string; historyHome?: string }) => {
    if (options?.historyHome) reportedHome = options.historyHome;
    (agent as unknown as { hosts: Map<string, unknown> }).hosts.set(options?.keyOverride ?? 'local', host);
    return host;
  });
  Object.defineProperty(agent, 'getHost', { value: getHost });

  const deviceHosted: DeviceHostedSession = {
    workingDir,
    extraDirs: [],
    writableDirs: [],
    platform: 'darwin',
    shell: 'zsh',
    isGitRepo: false,
    tunnelUrl: 'http://127.0.0.1:4000/',
    tunnelToken: 'tok',
    mcpServers: ['cindy_contacts'],
    mirrorRoot,
    ...(fixture.guest ? { guest: true, guestProvider: SHARED_PROVIDER } : {}),
    ...(guestHome ? { guestHome } : {}),
    ...(fixture.linkActivity ? { linkActivity: fixture.linkActivity } : {}),
  };
  const started = agent.startSession({
    sessionId: 'hosted-session',
    model: 'gpt-5.5',
    ...(fixture.guest ? { providerId: fixture.providerId ?? SHARED_PROVIDER.providerId } : {}),
    workingDir,
    permissionMode: 'acceptEdits',
    deviceHosted,
    ...(fixture.resume ? { resumeSessionId: '0199aaaa-bbbb-7ccc-8ddd-eeeeffff0000' } : {}),
  });
  return {
    started, request, getHost, getGhostRosterPrompt, getContactsPromptState, getDisabledSkillPaths,
    prepareCodexSkills, prepareCodexResumeSession, resolveCodexThreadStorage, recordCodexThreadLocation,
    hostSkill, systemSkill, pluginSkill, guestSkill, guestHome, codexHome, agent, workingDir,
  };
}

function threadParams(request: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  const params = request.mock.calls.find(([called]) => called === method)?.[1] as Record<string, unknown> | undefined;
  if (!params) throw new Error(`expected ${method}`);
  return params;
}

/** host.request 的第三个参数(超时与顺延设置)。 */
function requestOptions(request: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> | undefined {
  return request.mock.calls.find(([called]) => called === method)?.[2] as Record<string, unknown> | undefined;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose().catch(() => undefined)));
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex device-hosted guest sessions', () => {
  // Provider sharing §9.5: even a history-only native fork initializes MCP and
  // connectors. Existing fork tests covered proxy/history ownership only.
  // Minimal input: one guest source and a native turn anchor; tier: unit.
  it.each([false, true])('isolates history-only guest forks before allocating a child (feature inspection fails: %s)', async (inspectionFails) => {
    const fixture = await startHosted({ guest: true });
    const handle = await fixture.started;
    await handle.close();
    fixture.request.mockClear();
    if (inspectionFails) {
      const baseRequest = fixture.request.getMockImplementation()!;
      fixture.request.mockImplementation(async (method, params) => {
        if (method === Method.ExperimentalFeatureList) throw new Error('feature inspection failed');
        return baseRequest(method, params);
      });
    }
    const forked = fixture.agent.forkSdkSession({
      sourceSdkSessionId: 'guest-source', upToMessageId: undefined,
      lastTurnId: 'kept-turn', workingDir: fixture.workingDir,
      hostedGuestHome: fixture.guestHome, providerId: SHARED_PROVIDER.providerId,
    });
    if (inspectionFails) {
      await expect(forked).rejects.toThrow('feature inspection failed');
      expect(fixture.request.mock.calls.some(([method]) => method === Method.ThreadFork)).toBe(false);
    } else {
      await expect(forked).resolves.toMatchObject({ newSdkSessionId: 'fork-thread-id' });
      expect(threadParams(fixture.request, Method.ThreadFork)).toMatchObject({
        config: {
          'mcp_servers.local_docs.enabled': false,
          'mcp_servers.cindy_contacts.enabled': false,
          'plugins."configured@personal".enabled': false,
          'features.apps': false,
          'features.hooks': false,
          'features.future_local_tool': false,
          'memories.use_memories': false,
        },
      });
    }
    expect(fixture.request.mock.calls.some(([method]) => method === Method.TurnStart)).toBe(false);
    expect(fixture.getHost).toHaveBeenLastCalledWith(undefined, expect.anything(), expect.objectContaining({
      nativeStorageOnly: true,
    }));
  });

  // Provider sharing §9.5: rewind must retain the consumer's MCP transport and
  // guest isolation. Startup-only coverage missed that native fork reloads host
  // defaults. Minimal input: a hosted session rewound at a persisted turn anchor;
  // tier: unit, through startSession -> commitRewindFiles -> send.
  it.each([false, true])('keeps the task tool route and capability scope after rewind (guest: %s)', async (guest) => {
    const fixture = await startHosted({ guest });
    const handle = await fixture.started;
    const initial = threadParams(fixture.request, Method.ThreadStart);

    await expect(handle.commitRewindFiles?.('', '', { tailTurnsToDrop: 1, lastTurnId: 'kept-turn' }))
      .resolves.toEqual({ sdkSessionId: 'fork-thread-id' });

    const fork = threadParams(fixture.request, Method.ThreadFork);
    expect(fork).toMatchObject({
      threadId: 'start-thread-id',
      lastTurnId: 'kept-turn',
      approvalPolicy: initial.approvalPolicy,
      sandbox: initial.sandbox,
      environments: initial.environments,
      config: {
        'mcp_servers.local_docs.enabled': false,
        'mcp_servers.cindy_contacts.enabled': true,
        'mcp_servers.cindy_contacts.url': 'http://127.0.0.1:4000/t/tok/mcp/cindy_contacts',
      },
    });
    expect(fork.config).toEqual(initial.config);
    if (guest) expect(fork.config).toMatchObject({
      'features.apps': false,
      'features.hooks': false,
      'features.plugins': false,
      'features.future_local_tool': false,
      'memories.use_memories': false,
    });

    await handle.send({ type: 'user', content: 'continue after rewind' });
    expect(threadParams(fixture.request, Method.TurnStart)).toMatchObject({
      threadId: 'fork-thread-id', environments: initial.environments,
    });
    await handle.close();
  });

  it.each([false, true])('isolates this computer\'s capabilities from a shared user (resume: %s)', async (resume) => {
    const fixture = await startHosted({ guest: true, resume });
    const handle = await fixture.started;
    const params = threadParams(fixture.request, resume ? Method.ThreadResume : Method.ThreadStart);
    const config = params.config as Record<string, unknown>;

    expect(config).toMatchObject({
      'features.hooks': false,
      'features.plugin_hooks': false,
      'features.apps': false,
      'features.plugins': false,
      'features.remote_plugin': false,
      'features.skill_mcp_dependency_install': false,
      'features.js_repl': false,
      'features.computer_use': false,
      'features.browser_use': false,
      'memories.generate_memories': false,
      'memories.use_memories': false,
      // 本机的 MCP 与插件(含插件 MCP)停用。
      'mcp_servers.local_docs.enabled': false,
      'plugins."configured@personal".enabled': false,
      'plugins."configured@personal".mcp_servers.configured_server.enabled': false,
      'plugins."secret-plugin@personal".enabled': false,
      // 经隧道的 MCP 指向受邀者电脑并保持启用。
      'mcp_servers.cindy_contacts.enabled': true,
      'mcp_servers.cindy_contacts.url': 'http://127.0.0.1:4000/t/tok/mcp/cindy_contacts',
    });
    // 联网搜索与同账号托管会话一致，不额外关闭。
    expect(config.web_search).toBeUndefined();
    expect(config['features.multi_agent']).toBeUndefined();
    // Codex 功能按白名单：名单外的(本机开着的、关着的、Codex 新增的)都写 false；名单内的、已移除的、
    // 关着的旧开关不动。功能清单逐页取完。
    expect(config).toMatchObject({
      'features.image_generation': false,
      'features.in_app_local_automation': false,
      'features.network_proxy': false,
      'features.future_local_tool': false,
    });
    // shell 快照由执行环境在受邀者电脑上生成，保持开启。
    for (const key of ['features.shell_tool', 'features.view_image', 'features.shell_snapshot', 'features.item_ids', 'features.web_search_request']) {
      expect(config[key]).toBeUndefined();
    }
    expect(fixture.request.mock.calls.filter(([method]) => method === Method.ExperimentalFeatureList)
      .map(([, params]) => (params as { cursor?: string }).cursor)).toEqual([undefined, 'page-2']);
    // 项目说明经执行环境从受邀者电脑读取，项目根的判定与同账号一致。
    expect(config.project_root_markers).toBeUndefined();
    // 本机用户的技能关闭；Codex 自带的与受邀者带来的保留。
    const skills = config['skills.config'] as Array<{ path: string; enabled: boolean }>;
    expect(skills).toEqual(expect.arrayContaining([
      { path: fixture.hostSkill, enabled: false },
      { path: fixture.pluginSkill, enabled: false },
    ]));
    expect(skills.map((entry) => entry.path)).not.toContain(fixture.systemSkill);
    expect(skills.map((entry) => entry.path)).not.toContain(fixture.guestSkill);
    // 不带本机的插件清单、通讯录说明与技能偏好。
    expect(String(params.developerInstructions ?? '')).not.toContain(GHOST_ROSTER);
    expect(fixture.getGhostRosterPrompt).not.toHaveBeenCalled();
    expect(fixture.getContactsPromptState).not.toHaveBeenCalled();
    expect(fixture.getDisabledSkillPaths).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps same-account hosted sessions unchanged', async () => {
    const fixture = await startHosted({ guest: false });
    const handle = await fixture.started;
    const params = threadParams(fixture.request, Method.ThreadStart);
    const config = params.config as Record<string, unknown>;

    for (const key of [
      'features.hooks', 'features.apps', 'features.plugins', 'features.remote_plugin', 'features.js_repl',
      'memories.use_memories', 'memories.generate_memories', 'project_root_markers',
      'plugins."configured@personal".enabled', 'plugins."secret-plugin@personal".enabled',
    ]) {
      expect(config[key]).toBeUndefined();
    }
    // 只有本机用户自己的技能停用偏好，不做逐项隔离。
    const skillPaths = (config['skills.config'] as Array<{ path: string }> | undefined ?? []).map((entry) => entry.path);
    expect(skillPaths).not.toContain(fixture.pluginSkill);
    expect(skillPaths).not.toContain(fixture.systemSkill);
    expect(config).toMatchObject({
      'mcp_servers.local_docs.enabled': false,
      'mcp_servers.cindy_contacts.enabled': true,
      'mcp_servers.cindy_contacts.url': 'http://127.0.0.1:4000/t/tok/mcp/cindy_contacts',
    });
    expect(String(params.developerInstructions)).toContain(GHOST_ROSTER);
    expect(fixture.getContactsPromptState).toHaveBeenCalled();
    expect(fixture.getDisabledSkillPaths).toHaveBeenCalled();
    // 同账号不检查本机 Skill / MCP 清单(Review 与受邀者才逐项关闭)，Codex 功能也不按白名单收窄。
    expect(fixture.request.mock.calls.some(([method]) => method === Method.McpServerStatusList)).toBe(false);
    expect(fixture.request.mock.calls.some(([method]) => method === Method.ExperimentalFeatureList)).toBe(false);
    expect(config['features.image_generation']).toBeUndefined();
    // Terminal password prompts would reach this computer's owner, not the account running the task.
    expect(config['shell_environment_policy.set.CINDY_INPUT_HANDOFF_ROUTE']).toBeUndefined();
    await handle.close();
  });

  it('refuses a shared user when Codex cannot list its features', async () => {
    const fixture = await startHosted({ guest: true, noFeatureList: true });
    await expect(fixture.started).rejects.toThrow(/Cannot start Codex for a shared user safely/);
    expect(fixture.request.mock.calls.some(([method]) => method === Method.ThreadStart)).toBe(false);
  });

  it('refuses a shared user without its own Codex home', async () => {
    // 没有受邀者目录就只能用本机用户任务共用的 app-server(带着本机的登录与子代理调配)：不启动。
    const fixture = await startHosted({ guest: true, guestHome: false });
    await expect(fixture.started).rejects.toThrow(/^\[REMOTE_AGENT_UNSUPPORTED\]/);
    expect(fixture.getHost).not.toHaveBeenCalled();
    expect(fixture.request.mock.calls.some(([method]) => method === Method.ThreadStart)).toBe(false);
  });

  it('still starts same-account hosted sessions with personal global Codex instructions', async () => {
    const fixture = await startHosted({ guest: false, codexHomeInstructions: 'PRIVATE HOST RULES' });
    const handle = await fixture.started;
    expect(fixture.request.mock.calls.some(([method]) => method === Method.ThreadStart)).toBe(true);
    await handle.close();
  });

  it.each([false, true])('runs a shared user in its own CODEX_HOME with login supplied by the token bridge (resume: %s)', async (resume) => {
    // 本机用户写了全局说明：受邀者有自己的 CODEX_HOME，照常启动，不读到本机的说明。
    const fixture = await startHosted({ guest: true, guestHome: true, resume, codexHomeInstructions: 'PRIVATE HOST RULES' });
    const handle = await fixture.started;
    const guestCodexHome = path.join(fixture.guestHome!, 'codex');
    expect((await fs.stat(guestCodexHome)).isDirectory()).toBe(true);
    const options = fixture.getHost.mock.calls.find(([, , opts]) => opts?.historyHome)?.[2] as Record<string, unknown> | undefined;
    // historyHome ≠ 本机 CODEX_HOME：AppServerHost 走 ephemeral 凭证存储 + token 桥(createCodexAuthTokenReader)，
    // 本机的 auth.json 不复制也不在受邀者目录里刷新。
    expect(options).toMatchObject({ historyHome: guestCodexHome, sqliteHome: guestCodexHome });
    expect(String(options?.keyOverride)).toMatch(/^local-guest:hosted-session/);
    // 独占的 app-server 带上分享的供应商：host 据此只留这个供应商的路由，不开智能子代理调配。
    expect(options?.deviceHostedGuestProviderId).toBe('xd');
    expect(options?.deviceHostedGuestSessionId).toBe('hosted-session');
    expect(options?.deviceHostedGuestModelIds).toEqual(SHARED_PROVIDER.modelIds);
    // 不按 id 到本机用户的 Codex 历史里查找，不把本机托管技能投影进来，也不登记线程位置。
    expect(fixture.prepareCodexResumeSession).not.toHaveBeenCalled();
    expect(fixture.resolveCodexThreadStorage).not.toHaveBeenCalled();
    expect(fixture.prepareCodexSkills).not.toHaveBeenCalled();
    expect(fixture.recordCodexThreadLocation).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps same-account hosted sessions on this computer\'s CODEX_HOME', async () => {
    const fixture = await startHosted({ guest: false, resume: true });
    const handle = await fixture.started;
    expect(fixture.getHost.mock.calls.some(([, , opts]) => opts?.historyHome)).toBe(false);
    expect(fixture.getHost.mock.calls.some(([, , opts]) => opts && 'deviceHostedGuestProviderId' in opts)).toBe(false);
    expect(fixture.getHost.mock.calls.some(([, , opts]) => opts && 'deviceHostedGuestSessionId' in opts)).toBe(false);
    expect(fixture.prepareCodexResumeSession).toHaveBeenCalled();
    expect(fixture.resolveCodexThreadStorage).toHaveBeenCalled();
    expect(fixture.prepareCodexSkills).toHaveBeenCalled();
    await handle.close();
  });

  it.each([false, true])('lets thread requests keep waiting while the tunnel still has traffic (#5764, resume: %s)', async (resume) => {
    const linkActivity = vi.fn(() => ({
      lastActivityAt: 1_234,
      execRequests: 4,
      execResponses: 3,
      execMaxInFlight: 2,
      httpInFlight: 0,
    }));
    const fixture = await startHosted({ guest: true, resume, linkActivity });
    const handle = await fixture.started;
    const optionsOf = (method: string) => requestOptions(fixture.request, method) as {
      timeoutMs?: number;
      extendWhileProgress?: { lastProgressAt(): number | null; idleMs: number; maxMs: number; describe?(): string };
    } | undefined;
    const thread = optionsOf(resume ? Method.ThreadResume : Method.ThreadStart);
    expect(thread).toMatchObject({ timeoutMs: 60_000, extendWhileProgress: { idleMs: 30_000, maxMs: 300_000 } });
    expect(thread?.extendWhileProgress?.lastProgressAt()).toBe(1_234);
    expect(thread?.extendWhileProgress?.describe?.()).toContain('execution environment answered 3/4 requests');
    await handle.send({ type: 'user', content: 'hi' });
    expect(optionsOf(Method.TurnStart)).toMatchObject({ timeoutMs: 60_000, extendWhileProgress: { idleMs: 30_000 } });
    await handle.close();
  });

  it('extends hosted workspace profile lifecycle requests with tunnel progress', async () => {
    const linkActivity = vi.fn(() => ({
      lastActivityAt: 1_234,
      execRequests: 4,
      execResponses: 3,
      execMaxInFlight: 2,
      httpInFlight: 0,
    }));
    const fixture = await startHosted({ guest: true, linkActivity });
    const handle = await fixture.started;
    await handle.setExtraDirs?.(['/shared-profile']);
    await handle.send({ type: 'user', content: 'use the hosted profile' });

    const replacementCall = fixture.request.mock.calls
      .filter(([method]) => method === Method.ThreadStart)[1] as unknown as [string, unknown, unknown] | undefined;
    const replacement = replacementCall?.[2] as Record<string, unknown> | undefined;
    // 内层 host.request = 外层接受期限(60s 基准 / 30s 静默 / 5min 封顶，见
    // criticalThreadRpcOptions)+ 5min 晚到响应窗口：接受期限收口后内层还要能收到
    // 晚到响应跑 onLateResolve 清理，不能两层同上限(#5772 review)。
    expect(replacement).toMatchObject({
      timeoutMs: 360_000,
      extendWhileProgress: { idleMs: 330_000, maxMs: 600_000 },
    });
    const progress = replacement?.extendWhileProgress as {
      lastProgressAt(): number | null;
      describe?(): string;
    };
    expect(progress.lastProgressAt()).toBe(1_234);
    expect(progress.describe?.()).toContain('execution environment answered 3/4 requests');
    await handle.close();
  });

  it('keeps the hosted profile lifecycle acceptance open with tunnel progress and cleans up late responses', async () => {
    let activityAt = 0;
    const linkActivity = vi.fn(() => ({
      lastActivityAt: activityAt,
      execRequests: 4,
      execResponses: 3,
      execMaxInFlight: 2,
      httpInFlight: 0,
    }));
    const fixture = await startHosted({ guest: true, linkActivity });
    const handle = await fixture.started;
    const host = await fixture.getHost.mock.results[0]!.value;
    // 受测的替换请求走真实 AppServerClient + 假传输(#5774 review)：pending 的删除由
    // 真实超时逻辑负责，受控 Promise 会绕过内层超时、测不出两层同上限丢响应。
    const appServer = installRealAppServerReplacement(fixture);
    await handle.setExtraDirs?.(['/shared-profile']);
    activityAt = Date.now() + 45_000;
    vi.useFakeTimers();
    let sendSettled = false;
    try {
      const sendPromise = handle.send(
        { type: 'user', content: 'use the hosted profile' },
        { throwOnStartFailure: true },
      );
      void sendPromise.then(
        () => {
          sendSettled = true;
        },
        () => {
          sendSettled = true;
        },
      );
      await vi.advanceTimersByTimeAsync(60_000);
      // 基准 60s 到点时链路仍有往来：接受期限顺延，不收口。
      expect(sendSettled).toBe(false);
      activityAt = Date.now() + 10_000;
      await vi.advanceTimersByTimeAsync(40_000);
      // 往来停满 30s 才按超时收口(实际等了 100s，超过 60s 基准)。
      await expect(sendPromise).rejects.toThrow(/did not acknowledge within 100000ms/);
      expect(fixture.request.mock.calls.filter(
        ([method]) => method === Method.ThreadStart,
      )).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
    // 接受期限收口后，晚到响应仍被真实 pending 收下并到达 onLateResolve：脱线线程
    // 被退订，而不是被同上限的内层超时删掉 pending 丢弃。
    appServer.transport.emitLine({
      id: appServer.lastRequestId(),
      result: {
        thread: { id: 'late-thread-id' },
        model: 'gpt-5.5',
        modelProvider: 'openai',
        cwd: '/repo',
      },
    });
    await vi.waitFor(() => expect(host.unsubscribeThread).toHaveBeenCalledWith('late-thread-id'));
    await appServer.client.close();
    await handle.close();
  });

  it('clears an unanswered profile replacement after the late response window', async () => {
    // 链路没有往来：外层 60s 基准直接收口，内层靠晚到响应窗口继续存活。
    const linkActivity = vi.fn(() => ({
      lastActivityAt: null,
      execRequests: 0,
      execResponses: 0,
      execMaxInFlight: 0,
      httpInFlight: 0,
    }));
    const fixture = await startHosted({ guest: true, linkActivity });
    const handle = await fixture.started;
    const host = await fixture.getHost.mock.results[0]!.value;
    const appServer = installRealAppServerReplacement(fixture);
    await handle.setExtraDirs?.(['/shared-profile']);
    vi.useFakeTimers();
    try {
      const sendPromise = handle.send(
        { type: 'user', content: 'use the hosted profile' },
        { throwOnStartFailure: true },
      );
      // 失败在 fake timers 推进中发生：先挂处理器，避免 unhandled rejection。
      void sendPromise.catch(() => undefined);
      await vi.advanceTimersByTimeAsync(60_000);
      await expect(sendPromise).rejects.toThrow(/did not acknowledge within 60000ms/);
      // 晚到窗口(5min)到点后 AppServerClient 按超时显式删除 pending：
      // 请求被清除，而不是无限挂在 pending 里泄漏。
      await vi.advanceTimersByTimeAsync(310_000);
      await expect(appServer.innerSettled()).resolves.toMatchObject({
        ok: false,
        message: expect.stringMatching(/timed out after 360000ms/),
      });
    } finally {
      vi.useRealTimers();
    }
    // 窗口结束后才到的响应被丢弃，不会再触发 onLateResolve 的退订清理。
    appServer.transport.emitLine({
      id: appServer.lastRequestId(),
      result: { thread: { id: 'too-late-thread-id' } },
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(host.unsubscribeThread).not.toHaveBeenCalled();
    await appServer.client.close();
    await handle.close();
  });

  it('keeps the fixed limit when the host provides no tunnel activity', async () => {
    const fixture = await startHosted({ guest: false });
    const handle = await fixture.started;
    const options = requestOptions(fixture.request, Method.ThreadStart);
    expect(options).toMatchObject({ timeoutMs: 60_000 });
    expect(options).not.toHaveProperty('extendWhileProgress');
    // 生命周期请求同样走固定 60s 接受期限(不是本地会话的 10s)，内层再留晚到响应窗口。
    await handle.setExtraDirs?.(['/shared-profile']);
    await handle.send({ type: 'user', content: 'use the hosted profile' });
    const replacementCall = fixture.request.mock.calls
      .filter(([method]) => method === Method.ThreadStart)[1] as unknown as [string, unknown, unknown] | undefined;
    const replacement = replacementCall?.[2] as Record<string, unknown> | undefined;
    expect(replacement).toMatchObject({ timeoutMs: 360_000 });
    expect(replacement).not.toHaveProperty('extendWhileProgress');
    await handle.close();
  });

  // 2026-10-22 远程供应商调查：执行环境首次握手超时后，Codex 之后每一轮都跳过它(模型能回答，却没有 Shell 与
  // 文件工具)，链路恢复也不会自己重连。隧道上已没有执行环境连接时，下一轮开始前按同一个 id 重新登记；
  // 连接还开着时不发任何查询(正常发送不多一次往返)。
  it.each([
    ['re-registers a disconnected execution environment', 0, 'disconnected', 2],
    ['leaves an execution environment that is still connecting', 0, 'pending', 1],
    ['does not query a connected execution environment', 1, 'ready', 1],
  ] as const)('%s before the next turn of a hosted session', async (_label, open, status, registered) => {
    const linkActivity = vi.fn(() => ({
      lastActivityAt: 1_234,
      execRequests: 0,
      execResponses: 0,
      execMaxInFlight: 0,
      httpInFlight: 0,
      wsConnectionsOpen: open,
    }));
    const fixture = await startHosted({ guest: true, linkActivity });
    const handle = await fixture.started;
    const base = fixture.request.getMockImplementation()!;
    fixture.request.mockImplementation(async (method: string, params: unknown) => (
      method === Method.EnvironmentStatus
        ? { status, error: 'timed out waiting for exec-server initialize handshake after 10s' }
        : base(method, params)
    ));
    await handle.send({ type: 'user', content: 'hello' });
    const methods = fixture.request.mock.calls.map(([method]) => method);
    expect(methods.filter((method) => method === Method.EnvironmentAdd)).toHaveLength(registered);
    expect(methods.includes(Method.EnvironmentStatus)).toBe(open === 0);
    // 重新登记排在这一轮 turn/start 之前，turn/start 选的仍是同一个环境 id。
    expect(methods.lastIndexOf(Method.EnvironmentAdd)).toBeLessThan(methods.indexOf(Method.TurnStart));
    const environmentIds = fixture.request.mock.calls
      .filter(([method]) => method === Method.EnvironmentAdd)
      .map(([, params]) => (params as { environmentId: string }).environmentId);
    expect(new Set(environmentIds).size).toBe(1);
    const turnEnvironments = threadParams(fixture.request, Method.TurnStart).environments as Array<{ environmentId: string }>;
    expect(turnEnvironments.map((environment) => environment.environmentId)).toEqual([environmentIds[0]]);
    await handle.close();
  });

  it('refuses a shared user on a provider other than the shared one', async () => {
    const fixture = await startHosted({ guest: true, providerId: 'openai' });
    await expect(fixture.started).rejects.toThrow(/^\[REMOTE_AGENT_PROVIDER_NOT_ALLOWED\]/);
    expect(fixture.getHost).not.toHaveBeenCalled();
  });

  it.each([
    ['guest', true, 'private', false],
    ['guest', true, 'guest', true],
    ['same-account', false, 'private', true],
  ] as const)('resolves a leading slash Skill for a %s session only from allowed Skills (/%s)', async (_label, guest, name, resolved) => {
    const fixture = await startHosted({ guest, guestHome: guest });
    const handle = await fixture.started;
    await handle.send({ type: 'user', content: `/${name} go` });
    const turn = threadParams(fixture.request, Method.TurnStart);
    const skillInputs = (turn.input as Array<{ type: string; path?: string }>).filter((item) => item.type === 'skill');
    const expectedPath = name === 'guest' ? fixture.guestSkill : fixture.hostSkill;
    expect(skillInputs.map((item) => item.path)).toEqual(resolved ? [expectedPath] : []);
    await handle.close();
  });

  it('drops the spawn model-override switch from a shared user\'s app-server configuration', () => {
    expect(withoutCodexSpawnModelOverrides([
      '-c', 'model_catalog_json="/tmp/catalog.json"',
      '-c', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
      '--config', 'features.multi_agent_v2.expose_spawn_agent_model_overrides=true',
      '-c', 'model_provider="fixture"',
    ])).toEqual([
      '-c', 'model_catalog_json="/tmp/catalog.json"',
      '-c', 'model_provider="fixture"',
    ]);
  });
});
