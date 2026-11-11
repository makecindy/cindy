/**
 * 伙伴自己沉淀的技能在 Claude Code 侧的挂载。
 *
 * cc 的 `skillOverrides` 只能开关它**自己发现到的** Skill(`~/.claude/skills` 与
 * 项目 `.claude/skills`)。伙伴的技能躺在 Cindy 自有的 per-bot userData 目录里,
 * 唯一不污染那两个共享目录(会串到别的伙伴和普通任务)的挂载方式,就是把 per-bot
 * 根当 `{type:'local'}` plugin 传给 SDK。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import { LOCAL_AGENT_CLIENT } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({
  forkSession: vi.fn(),
  query: vi.fn(),
}));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

// 设置落盘失败注入: 只有用例显式打开时才拒绝, 其余用例仍走真实实现。
// 记下这次调用实际建出来的暂存目录, 断言只看它们, 不扫系统临时目录
// (并行用例也会建 cindy-claude-skills-* , 全局差集会把别人的算进来)。
const flagSettingsMock = vi.hoisted(() => ({
  fail: false,
  stagingDirs: [] as string[],
  // 本次启动是否把超限设置真的写成了临时文件（内联路径不算）。
  wroteFile: false,
}));

vi.mock('../managed-skill-plugins.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../managed-skill-plugins.js')>();
  return {
    ...actual,
    prepareManagedSkillPlugins: async (
      ...args: Parameters<typeof actual.prepareManagedSkillPlugins>
    ) => {
      const prepared = await actual.prepareManagedSkillPlugins(...args);
      if (prepared.stagingDir) flagSettingsMock.stagingDirs.push(prepared.stagingDir);
      return prepared;
    },
  };
});

vi.mock('../flag-settings-file.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../flag-settings-file.js')>();
  return {
    ...actual,
    materializeClaudeFlagSettings: async (
      ...args: Parameters<typeof actual.materializeClaudeFlagSettings>
    ) => {
      if (flagSettingsMock.fail) throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
      const delivery = await actual.materializeClaudeFlagSettings(...args);
      flagSettingsMock.wroteFile = delivery.kind === 'file';
      return delivery;
    },
  };
});

import { ClaudeCodeAgent } from '../index.js';
import { CLAUDE_INLINE_SETTINGS_ARGV_BUDGET } from '../flag-settings-file.js';

const tempDirs: string[] = [];
const liveHandles: Awaited<ReturnType<ClaudeCodeAgent['startSession']>>[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function createNoopLogger(): Logger {
  const logger: Logger = {
    trace() {},
    debug() {},
    info() {},
    warn() {},
    error() {},
    fatal() {},
    child() {
      return logger;
    },
  };
  return logger;
}

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() {
      return { authenticated: true };
    },
    async triggerLogin() {
      return { authenticated: true };
    },
    async logout() {},
    async getAuthEnv() {
      return {};
    },
  };
  return {
    auth,
    runtimeConfig: {
      systemPrompt: 'GLOBAL CINDY HOST PROMPT',
      answerDeliveryPrompt: 'CINDY ANSWER DELIVERY FIXTURE',
    },
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    getGhostRosterPrompt: vi.fn(() => 'GLOBAL GHOST ROSTER'),
  };
}

/** 消息流永远挂起的最小 SDK Query 假实现。 */
function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async (): Promise<Array<{ name: string; status: string; scope?: string }>> => []),
    setMcpServers: vi.fn(async (servers: Record<string, unknown>) => ({ added: [], removed: servers.custom_magpie ? [] : ['custom_magpie'], errors: {} })),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-bot-skills-'));
  tempDirs.push(dir);
  return dir;
}

const OWN_SKILL_ROOT = '/userdata/bot-skills/bot-1';

async function startBotSession(input: {
  query?: ReturnType<typeof createFakeQuery>;
  duplicateResolver?: AgentDeps['resolveLocalMcpDuplicateChoices'];
  ownSkillPluginRoots?: string[];
  reviewMode?: boolean;
  remote?: boolean;
  ordinary?: boolean;
  localHostOnly?: boolean;
  hostedGuest?: boolean;
  managed?: boolean;
  disabled?: boolean;
  allowManaged?: boolean;
  catalogState?: 'failed' | 'disabled' | 'missing' | 'user-collision';
  projectContext?: boolean;
  availableModels?: NonNullable<AgentDeps['capabilityAdditions']>['availableModels'];
  resolveSessionEnvironment?: AgentDeps['resolveSessionEnvironment'];
}) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  sdkMock.query.mockReturnValue(input.query ?? createFakeQuery());

  const deps = createDeps();
  if (input.availableModels) deps.capabilityAdditions = { availableModels: input.availableModels };
  if (input.resolveSessionEnvironment) deps.resolveSessionEnvironment = input.resolveSessionEnvironment;
  if (input.duplicateResolver) {
    deps.resolveLocalMcpDuplicateChoices = input.duplicateResolver;
    deps.mcpProviders = ['custom_magpie', 'other'].map(name => ({ name,
      toClaudeSdkConfig: () => ({ type: 'http', url: 'http://localhost:3425/mcp' }),
    }));
  }
  if (input.managed) {
    await fs.mkdir(`${configDir}/managed/learn`, { recursive: true });
    await fs.writeFile(`${configDir}/managed/learn/SKILL.md`, '---\nname: learn\ndescription: Fixture\n---\nBody');
    deps.getManagedSkills = async () => [{kind: 'agent-skill', name: 'learn', path: `${configDir}/managed/learn/SKILL.md`,
      source: 'skill', enabled: true, claudeCommandName: 'cindy:learn'}];
    if (input.disabled) deps.getDisabledSkillPaths = () => [`${configDir}/managed/learn`];
  }
  let remoteOptions: unknown;
  if (input.remote) {
    deps.remoteCcQueryFactory = async ({ startParams, botSession }) => {
      expect(botSession).toBe(!input.reviewMode && !input.ordinary);
      remoteOptions = startParams.extraOptions;
      return createFakeQuery() as never;
    };
  }
  const agent = new ClaudeCodeAgent(deps);
  const handle = await agent.startSession({
    sessionId: 'session-bot-skills',
    model: 'claude-opus-4-6',
    workingDir,
    ...(input.hostedGuest ? { deviceHosted: {
      workingDir, platform: process.platform, pathPlatform: process.platform,
      shell: 'fixture-shell', isGitRepo: false,
      extraDirs: [], writableDirs: [],
      tunnelUrl: 'http://127.0.0.1:12345', tunnelToken: 'fixture', mcpServers: ['notebook'],
      guest: true, guestHome: configDir,
      guestProvider: { providerId: 'fixture', modelIds: ['claude-opus-4-6'], routeToken: 'fixture' },
    }, providerId: 'fixture' } : {}),
    ...(input.localHostOnly !== undefined ? {
      [LOCAL_AGENT_CLIENT]: {url:'http://127.0.0.1:12345/mcp/fixture',token:'fixture-token',hostToolsOnly:input.localHostOnly,mcpName:'notebook'},
      makerMemoryEnabled: false,
      makerMemoryIndexSnapshot: 'PRIVATE_MEMORY_INDEX_CANARY',
    } : {}),
    ...(input.remote ? { remoteHostId: 'remote-bot-host' } : {}),
    permissionMode: 'acceptEdits',
    botProfilePrompt: 'BOT SOUL',
    botProfileContextPrompt: 'BOT HOME CONTEXT',
    userPrompt: 'GLOBAL USER PROMPT',
    ...(input.reviewMode ? { reviewMode: true as const } : {}),
    botRuntimeProfile: input.ordinary ? undefined : {
      botId: 'bot-1',
      profileVersion: 1,
      skillPolicy: {
        mode: input.allowManaged !== undefined ? 'allowlist' : 'inherit',
        configured: input.allowManaged ? [input.catalogState === 'user-collision' ? 'learn' : 'cindy:learn'] : [],
        catalog: !input.managed || input.catalogState === 'missing' ? [] : [
          { name: 'cindy:learn', runtimeCommandName: 'cindy:learn', path: `${configDir}/managed/learn`,
            enabled: input.catalogState !== 'disabled',
            runtimeStatus: input.catalogState === 'failed' ? 'failed' as const : 'loaded' as const },
          ...(input.catalogState === 'user-collision'
            ? [{ name: 'learn', path: `${configDir}/user/learn/SKILL.md`, enabled: true }] : []),
        ],
        ...(input.ownSkillPluginRoots
          ? {
              ownSkills: [{ name: 'weekly-report', path: `${OWN_SKILL_ROOT}/skills/weekly-report` }],
              ownSkillPluginRoots: input.ownSkillPluginRoots,
            }
          : {}),
      },
      mcpPolicy: { mode: 'inherit', configured: [], catalog: [] },
      toolsetPolicy: { mode: 'inherit', configured: [], catalog: [] },
      ...(input.projectContext ? { projectContext: true } : {}),
    },
  });

  liveHandles.push(handle);
  const options = (input.remote ? remoteOptions : sdkMock.query.mock.calls.at(-1)?.[0]?.options) as
    | {
        plugins?: Array<{ type: string; path: string }>;
        tools?: string[];
        mcpServers?: Record<string, {type:string;url:string;headers?:Record<string,string>}>;
        settingSources?: string[];
        disallowedTools?: string[];
        strictMcpConfig?: boolean;
        settings?: { autoMemoryEnabled?: boolean; autoDreamEnabled?: boolean; skillOverrides?: Record<string, string>; deniedMcpServers?: Array<{serverName: string}> };
        systemPrompt?: { append?: string };
      }
    | undefined;
  if (!options) throw new Error('expected sdk query options');
  return options;
}

// 测试价值：实际 adapter 的 SDK 启动选项是 Claude 工具隔离执行点；普通伙伴挂载用例不覆盖本机接入。
// 最小输入：一个受管技能与独立客户端 MCP；tier unit，无进程或网络。
// 2026-10-22 维护者裁决：接入保持 Cindy 提示词装配，权限由实际工具面约束。
// 普通任务对照锁住完整追加段，不复制提示词常量；禁用记忆仍不得带出已有索引。
it.each([false, true])('local client-only sessions expose only their own tools (shared=%s)', async (hostedGuest) => {
  const ordinary = await startBotSession({ordinary:true,managed:true});
  const partner = await startBotSession({ordinary:true,managed:true,localHostOnly:true,hostedGuest});
  expect(partner.tools).toEqual([]);
  expect(partner.settingSources).toEqual([]);
  expect(partner.plugins ?? []).toEqual([]);
  expect(partner.strictMcpConfig).toBe(true);
  expect(Object.keys(partner.mcpServers ?? {})).toEqual(['notebook']);
  expect(partner.mcpServers?.notebook.headers?.Authorization).toBe('Bearer fixture-token');
  const prompt = partner.systemPrompt?.append ?? '';
  expect(prompt).toContain('GLOBAL CINDY HOST PROMPT');
  expect(prompt).toContain('CINDY ANSWER DELIVERY FIXTURE');
  if (hostedGuest) expect(prompt).not.toContain('GLOBAL GHOST ROSTER');
  else expect(prompt).toContain('GLOBAL GHOST ROSTER');
  expect(prompt).toContain('GLOBAL USER PROMPT');
  expect(prompt).not.toContain('PRIVATE_MEMORY_INDEX_CANARY');
  if (!hostedGuest) expect(prompt).toBe(ordinary.systemPrompt?.append);
  const delegated = await startBotSession({ordinary:true,localHostOnly:false,hostedGuest});
  if (hostedGuest) expect(delegated.tools).toContain('WebSearch');
  else {
    expect(delegated.tools).toBeUndefined();
    expect(delegated.systemPrompt?.append).toBe(prompt);
  }
});

afterEach(async () => {
  await Promise.all(liveHandles.splice(0).map((handle) => handle.close()));
  // The session owns its plugin staging directories. Wait for asynchronous
  // disposal instead of racing a second rm against it (EPERM on Windows).
  for (const [call] of sdkMock.query.mock.calls) {
    for (const plugin of call.options.plugins ?? []) {
      if (plugin.path === OWN_SKILL_ROOT) continue;
      await vi.waitFor(async () => {
        await expect(fs.stat(path.dirname(plugin.path))).rejects.toMatchObject({ code: 'ENOENT' });
      });
    }
  }
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  flagSettingsMock.wroteFile = false;
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude Code mounts the Bot\'s own learned Skills', () => {
  // #8902: the public startSession must change the actual SDK tool/config inputs,
  // while preserving native user settings and excluding nonlocal/strict runtimes.
  it.each(['cindy', 'claude'] as const)('applies the explicit %s source choice to ordinary local sessions', async choice => {
    const duplicateResolver = vi.fn(async () => ({
      skipHostServers: choice === 'claude' ? ['custom_magpie'] : [],
      denyNativeServers: choice === 'cindy' ? ['magpie'] : [],
      nativeServersToKeep: choice === 'claude' ? ['magpie'] : [],
    }));
    const query = createFakeQuery();
    query.mcpServerStatus.mockResolvedValue([{ name: 'magpie', status: 'connected', scope: 'user' }]);
    const options = await startBotSession({ ordinary: true, duplicateResolver, query });
    expect(Object.keys(options.mcpServers ?? {})).toEqual(['custom_magpie', 'other']);
    if (choice === 'claude') {
      expect(query.setMcpServers).toHaveBeenNthCalledWith(1, options.mcpServers);
      expect(query.setMcpServers).toHaveBeenNthCalledWith(2, { other: options.mcpServers!.other });
      expect(query.setMcpServers.mock.calls[1]![0].other).toBe(options.mcpServers!.other);
    } else expect(query.setMcpServers).not.toHaveBeenCalled();
    expect(options.settings?.deniedMcpServers ?? []).toEqual(choice === 'cindy' ? [{ serverName: 'magpie' }] : []);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
    expect(options.strictMcpConfig).toBeUndefined();
  });
  // PR #9055: files cannot reflect managed policy. Exercise the real startSession
  // assembly with native status absent, disconnected or unreadable; unit, no CLI.
  it.each(['missing', 'failed', 'pending', 'error', 'update-error'])('keeps available connections when native selection is %s', async status => {
    const query = createFakeQuery();
    if (status === 'error') query.mcpServerStatus.mockRejectedValue(new Error('status unavailable'));
    else query.mcpServerStatus.mockResolvedValue(status === 'missing' ? [] : [{ name: 'magpie', status: status === 'update-error' ? 'connected' : status, scope: 'user' }]);
    if (status === 'update-error') query.setMcpServers.mockResolvedValueOnce({ added: [], removed: [], errors: {} })
      .mockRejectedValueOnce(new Error('update unavailable'));
    const options = await startBotSession({ ordinary: true, query,
      duplicateResolver: async () => ({ skipHostServers: ['custom_magpie'], denyNativeServers: [], nativeServersToKeep: ['magpie'] }),
    });
    expect(options.mcpServers).toHaveProperty('custom_magpie');
    expect(query.setMcpServers).toHaveBeenNthCalledWith(1, options.mcpServers);
    expect(query.setMcpServers).toHaveBeenCalledTimes(status === 'update-error' ? 2 : 1);
    // Failed diagnostics must release the input gate, not strand the first turn.
    const prompt = sdkMock.query.mock.calls.at(-1)![0].prompt as AsyncIterable<unknown>;
    const next = prompt[Symbol.asyncIterator]().next();
    await liveHandles.at(-1)!.send({ type: 'user', content: 'use the connection' });
    expect((await next).value).toMatchObject({ type: 'user' });
  });
  // PR #9055: a connected name alone can belong to a host/provider, plugin or
  // project override. Unit: saved user-scope choice + non-user runtime status.
  it.each([['dynamic', 'magpie'], ['project', 'magpie'], [undefined, 'magpie'], ['user', 'other']] as const)(
    'does not replace Cindy with a %s-scoped connection named %s', async (scope, name) => {
      const query = createFakeQuery();
      query.mcpServerStatus.mockResolvedValue([{ name, status: 'connected', scope }]);
      const options = await startBotSession({ ordinary: true, query,
        duplicateResolver: async () => ({ skipHostServers: ['custom_magpie'], denyNativeServers: [], nativeServersToKeep: [name] }),
      });
      expect(query.setMcpServers).toHaveBeenCalledTimes(1);
      expect(query.setMcpServers).toHaveBeenCalledWith(options.mcpServers);
    });
  it.each([{ ordinary: false }, { ordinary: true, remote: true }, { ordinary: true, reviewMode: true }, { ordinary: true, localHostOnly: true }])(
    'does not apply local duplicate choices in isolated/remote runtimes: %j', async context => {
      const duplicateResolver = vi.fn(async () => ({ skipHostServers: ['custom_magpie'], denyNativeServers: ['magpie'] }));
      await startBotSession({ ...context, duplicateResolver });
      expect(duplicateResolver).not.toHaveBeenCalled();
    },
  );
  // 伙伴 V2(项目模式):就是普通项目任务加一层伙伴身份。SDK 选项与普通任务一致(用户/项目设置、
  // 宿主提示词、不收窄 MCP),伙伴身份与自有技能照常挂上。依据:伙伴 = 包装过的项目 + session
  // (主人 2026-11-06)。最小输入:projectContext 开关;unit,无进程。
  it('runs a V2 teammate as an ordinary task with its identity on top', async () => {
    const ordinary = await startBotSession({ ordinary: true });
    const v2 = await startBotSession({ projectContext: true, ownSkillPluginRoots: [OWN_SKILL_ROOT] });
    expect(v2.settingSources).toEqual(ordinary.settingSources);
    expect(v2.strictMcpConfig).toBeUndefined();
    expect(v2.settings?.autoMemoryEnabled).toBe(ordinary.settings?.autoMemoryEnabled);
    expect(v2.plugins).toEqual([{ type: 'local', path: OWN_SKILL_ROOT }]);
    expect(v2.systemPrompt?.append).toContain('GLOBAL USER PROMPT');
    expect(v2.systemPrompt?.append).toContain('BOT SOUL');
    const classic = await startBotSession({});
    expect(classic.settingSources).toEqual([]);
    expect(classic.systemPrompt?.append).not.toContain('GLOBAL USER PROMPT');
  });

  it('passes the per-Bot skill root as a local plugin', async () => {
    const options = await startBotSession({ ownSkillPluginRoots: [OWN_SKILL_ROOT] });
    expect(options.plugins).toEqual([{ type: 'local', path: OWN_SKILL_ROOT }]);
    expect(options.settingSources).toEqual([]);
    expect(options.disallowedTools).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false, autoDreamEnabled: false });
  });

  it('keeps remote Bot tools and memory in the same scope as local Bots', async () => {
    const options = await startBotSession({ remote: true });
    expect(options.disallowedTools).toBeUndefined();
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false, autoDreamEnabled: false });
  });

  it('preserves ordinary session native delegation and MCP settings', async () => {
    const options = await startBotSession({ ordinary: true });
    expect(options.disallowedTools).toBeUndefined();
    expect(options.strictMcpConfig).toBeUndefined();
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
  });

  it('omits the field entirely when the Bot has not learned anything', async () => {
    const options = await startBotSession({});
    expect(options.plugins).toBeUndefined();
  });

  it('carries no Bot skill root into a review session', async () => {
    const options = await startBotSession({
      ownSkillPluginRoots: [OWN_SKILL_ROOT],
      reviewMode: true,
    });
    expect(options.plugins).toBeUndefined();
  });

  it('de-duplicates a repeated root instead of mounting it twice', async () => {
    const options = await startBotSession({
      ownSkillPluginRoots: [OWN_SKILL_ROOT, OWN_SKILL_ROOT],
    });
    expect(options.plugins).toEqual([{ type: 'local', path: OWN_SKILL_ROOT }]);
  });

  it('keeps global Cindy identity, roster, and user prompt out of Bot context', async () => {
    const options = await startBotSession({});
    const prompt = options.systemPrompt?.append ?? '';
    expect(prompt).toContain('BOT SOUL');
    expect(prompt).toContain('BOT HOME CONTEXT');
    expect(prompt).not.toContain('GLOBAL CINDY HOST PROMPT');
    expect(prompt).not.toContain('GLOBAL GHOST ROSTER');
    expect(prompt).not.toContain('GLOBAL USER PROMPT');
  });
});


describe('Cindy managed skills use Claude session plugins', () => {
  it('mounts managed skills for ordinary sessions without setting a global config directory', async () => {
    const options = await startBotSession({ ordinary: true, managed: true });
    expect(options.plugins).toHaveLength(1);
    expect(await fs.readdir(path.join(options.plugins![0]!.path, 'skills'))).toEqual(['learn']);
    expect(options.settingSources).toEqual(['user', 'project', 'local']);
  });
  it('reclaims the session plugin when the handle closes, preserving its source skill', async () => {
    const options = await startBotSession({ ordinary: true, managed: true });
    const root = options.plugins![0]!.path;
    const source = await fs.realpath(path.join(root, 'skills', 'learn'));
    await liveHandles.at(-1)!.close();
    await vi.waitFor(async () => { await expect(fs.stat(path.dirname(root))).rejects.toMatchObject({ code: 'ENOENT' }); });
    expect(await fs.readFile(path.join(source, 'SKILL.md'), 'utf8')).toContain('Fixture');
  });

  it('disables only the namespaced command, preserving a user learn skill', async () => {
    const options = await startBotSession({ ordinary: true, managed: true, disabled: true });
    expect(options.plugins).toBeUndefined();
    expect(options.settings?.skillOverrides?.learn).toBeUndefined();
  });
  it.each([false, true])('respects the Bot managed skill allowlist: %s', async (allowManaged) => {
    const options = await startBotSession({ managed: true, allowManaged });
    if (allowManaged) {
      expect(options.plugins).toHaveLength(1);
      expect(await fs.readdir(path.join(options.plugins![0]!.path, 'skills'))).toEqual(['learn']);
    } else expect(options.plugins).toBeUndefined();
  });
  it.each(['failed', 'disabled', 'missing', 'user-collision'] as const)('does not mount an unproven managed Bot skill: %s', async (catalogState) => {
    const options = await startBotSession({ managed: true, allowManaged: true, catalogState });
    expect(options.plugins).toBeUndefined();
  });
  it('keeps managed commands ahead of Bot plugin aliases', async () => {
    const options = await startBotSession({ managed: true, allowManaged: true, ownSkillPluginRoots: [OWN_SKILL_ROOT] });
    expect(options.plugins).toHaveLength(2);
    expect(await fs.readdir(path.join(options.plugins![0]!.path, 'skills'))).toEqual(['learn']);
    expect(options.plugins![1]!.path).toBe(OWN_SKILL_ROOT);
  });
  it('does not grant ambient managed skills to a Bot with a legacy inherit policy', async () => {
    const options = await startBotSession({ managed: true });
    expect(options.plugins).toBeUndefined();
  });
  it.each([{reviewMode: true}, {remote: true}])('does not send local managed plugins to restricted runtimes %o', async (flags) => {
    const options = await startBotSession({ ...flags, managed: true });
    expect(options.plugins).toBeUndefined();
  });
});


describe('managed skill command collisions', () => {
  async function isolatedWorkingDir(): Promise<string> {
    const workingDir = await makeTempDir();
    // Stop native ancestor discovery at this fixture rather than the user's home.
    await fs.mkdir(path.join(workingDir, '.git'));
    return workingDir;
  }
  it('keeps user /learn and exposes Cindy under its full native name', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const userSkill = path.join(configDir, 'skills', 'learn');
    await fs.mkdir(userSkill, { recursive: true });
    await fs.writeFile(path.join(userSkill, 'SKILL.md'), '---\nname: learn\ndescription: User Learn\n---\nUser body');
    const deps = createDeps();
    deps.getManagedSkills = async () => [{ kind: 'agent-skill', name: 'learn', source: 'skill',
      path: '/cindy/learn/SKILL.md', enabled: true, claudeCommandName: 'cindy:learn' }];
    const agent = new ClaudeCodeAgent(deps);
    const result = await agent.listRuntimeSkills({ workingDir: await isolatedWorkingDir(), runtimeConfigDir: configDir });
    expect(result.skills.map((skill) => skill.name)).toEqual(['cindy:learn', 'learn']);
    expect(result.skills[0]?.runtimeCommandName).toBe('cindy:learn');
    expect(result.skills[1]?.path).toBe(path.join(userSkill, 'SKILL.md'));
  });

  it('keeps the short display name when unambiguous and namespaces collisions between plugins', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const deps = createDeps();
    deps.getManagedSkills = async () => ['cindy', 'cindy-plugin-a', 'cindy-plugin-b'].map((plugin, index) => ({
      kind: 'agent-skill', name: index ? 'demo' : 'learn', source: 'skill', enabled: true,
      path: `/${plugin}/SKILL.md`, claudeCommandName: `${plugin}:${index ? 'demo' : 'learn'}`,
    }));
    const result = await new ClaudeCodeAgent(deps).listRuntimeSkills({ workingDir: await isolatedWorkingDir(), runtimeConfigDir: configDir });
    expect(result.skills.map((skill) => skill.name)).toEqual(['learn', 'cindy-plugin-a:demo', 'cindy-plugin-b:demo']);
  });
});

// 测试价值：托管技能插件的暂存目录在设置落盘失败时必须一起拆掉，否则每次启动失败
// 都会留下一份 cindy-claude-skills-* 目录与技能链接。
// 最小输入：一个受管技能 + 让 materializeClaudeFlagSettings 报 ENOSPC；tier unit。
describe('managed skill staging cleanup when settings materialization fails', () => {
  it('removes the staging dir created before the failure', async () => {
    flagSettingsMock.stagingDirs.length = 0;
    flagSettingsMock.fail = true;
    try {
      await expect(startBotSession({ managed: true, allowManaged: true })).rejects.toMatchObject({
        cause: { code: 'ENOSPC' },
      });
    } finally {
      flagSettingsMock.fail = false;
    }

    expect(flagSettingsMock.stagingDirs).toHaveLength(1);
    await expect(fs.stat(flagSettingsMock.stagingDirs[0]!)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});

// 测试价值
// - 生产入口与可观察结果：ClaudeCodeAgent.startSession。本地伙伴会话在设置落盘后作用域失效时，启动 reject，且不调 sdk query。
// - Bug／规则依据：PR #9776 P1。prepareFlagSettings 的 await 打开异步窗口，回来后必须再调 companionEnvironment.assertCurrent，失效走启动清理而不拉起 SDK。
// - 现有覆盖缺口：同文件只覆盖落盘失败时拆掉托管技能暂存；没有覆盖落盘期间伙伴被删或换主。
// - 最小失败输入：带 botRuntimeProfile 的本地会话，模型白名单序列化后超过 CLAUDE_INLINE_SETTINGS_ARGV_BUDGET，assertCurrent 在落盘 await 之后抛 OWNER_CHANGED。
// - tier：unit。进程内假 SDK 与临时文件，无网络、无真实 CLI。
// - 实测耗时：见 tmp/fix-9776c-vitest.log
describe('companion scope invalidated while flag settings are written', () => {
  it('rejects startSession and does not call the SDK when the Bot scope dies after the settings file is written', async () => {
    const catalogIds = Array.from({ length: 280 }, (_, index) =>
      `vendor/${'gateway'.repeat(12)}-model-${index}`,
    );
    expect(JSON.stringify(catalogIds).length).toBeGreaterThan(CLAUDE_INLINE_SETTINGS_ARGV_BUDGET);

    // buildQuery 开头和落盘前各有一次围栏。计数器放过这两次；
    // 只有落盘 await 回来之后的那一次（此时临时文件已写出）才抛。
    // 拿掉落盘后的复查时，这里不会抛，SDK query 会被调用。
    let scopeChecks = 0;
    await expect(startBotSession({
      availableModels: catalogIds.map((id) => ({
        id,
        displayName: 'Catalog',
        contextWindow: 200_000,
        efforts: [],
        defaultEffort: null,
      })),
      resolveSessionEnvironment: async (sessionId) => {
        expect(sessionId).toBe('session-bot-skills');
        return {
          identity: 'companion-scope',
          assertCurrent() {
            scopeChecks += 1;
            if (scopeChecks > 2 && flagSettingsMock.wroteFile) throw new Error('OWNER_CHANGED');
          },
        };
      },
    })).rejects.toThrow('OWNER_CHANGED');

    expect(sdkMock.query).not.toHaveBeenCalled();
    expect(flagSettingsMock.wroteFile).toBe(true);
    expect(scopeChecks).toBe(3);
  });
});
