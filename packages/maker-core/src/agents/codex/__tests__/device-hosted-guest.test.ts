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
import { Method } from '../app-server/protocol.js';
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
}

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
    runtimeConfig: { systemPrompt: 'GLOBAL CINDY HOST PROMPT' },
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
      case Method.ThreadStart:
        return {
          thread: { id: 'start-thread-id', ...(reportedHome !== codexHome ? { path: path.join(reportedHome, 'sessions', 'rollout.jsonl') } : {}) },
          model: 'gpt-5.5', modelProvider: 'openai', cwd: workingDir,
        };
      case Method.ThreadResume:
        return { thread: { id: 'resume-thread-id' }, model: 'gpt-5.5', modelProvider: 'openai', cwd: workingDir };
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
    hostSkill, systemSkill, pluginSkill, guestSkill, guestHome, codexHome,
  };
}

function threadParams(request: ReturnType<typeof vi.fn>, method: string): Record<string, unknown> {
  const params = request.mock.calls.find(([called]) => called === method)?.[1] as Record<string, unknown> | undefined;
  if (!params) throw new Error(`expected ${method}`);
  return params;
}

afterEach(async () => {
  await Promise.all(agents.splice(0).map((agent) => agent.dispose().catch(() => undefined)));
  vi.restoreAllMocks();
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Codex device-hosted guest sessions', () => {
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
    // 同账号不检查本机 Skill / MCP 清单(Review 与受邀者才逐项关闭)。
    expect(fixture.request.mock.calls.some(([method]) => method === Method.McpServerStatusList)).toBe(false);
    await handle.close();
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
    expect(fixture.prepareCodexResumeSession).toHaveBeenCalled();
    expect(fixture.resolveCodexThreadStorage).toHaveBeenCalled();
    expect(fixture.prepareCodexSkills).toHaveBeenCalled();
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
