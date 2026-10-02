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

import { ClaudeCodeAgent } from '../index.js';

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
    runtimeConfig: { systemPrompt: 'GLOBAL CINDY HOST PROMPT' },
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    getGhostRosterPrompt: vi.fn(() => 'GLOBAL GHOST ROSTER'),
    getContactsPromptState: vi.fn(() => 'enabled' as const),
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
    mcpServerStatus: vi.fn(async () => []),
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
  ownSkillPluginRoots?: string[];
  reviewMode?: boolean;
  remote?: boolean;
  ordinary?: boolean;
  managed?: boolean;
  disabled?: boolean;
  allowManaged?: boolean;
  catalogState?: 'failed' | 'disabled' | 'missing' | 'user-collision';
}) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  sdkMock.query.mockReturnValue(createFakeQuery());

  const deps = createDeps();
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
    },
  });

  liveHandles.push(handle);
  const options = (input.remote ? remoteOptions : sdkMock.query.mock.calls.at(-1)?.[0]?.options) as
    | {
        plugins?: Array<{ type: string; path: string }>;
        settingSources?: string[];
        disallowedTools?: string[];
        strictMcpConfig?: boolean;
        settings?: { autoMemoryEnabled?: boolean; autoDreamEnabled?: boolean; skillOverrides?: Record<string, string> };
        systemPrompt?: { append?: string };
      }
    | undefined;
  if (!options) throw new Error('expected sdk query options');
  return options;
}

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
  if (originalClaudeConfigDir === undefined) {
    delete process.env.CLAUDE_CONFIG_DIR;
  } else {
    process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  }
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('Claude Code mounts the Bot\'s own learned Skills', () => {
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

  it('keeps global Cindy identity, roster, contacts, and user prompt out of Bot context', async () => {
    const options = await startBotSession({});
    const prompt = options.systemPrompt?.append ?? '';
    expect(prompt).toContain('BOT SOUL');
    expect(prompt).toContain('BOT HOME CONTEXT');
    expect(prompt).not.toContain('GLOBAL CINDY HOST PROMPT');
    expect(prompt).not.toContain('GLOBAL GHOST ROSTER');
    expect(prompt).not.toContain('GLOBAL USER PROMPT');
    expect(prompt).not.toContain('Smart Contacts');
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
    const result = await agent.listRuntimeSkills({ workingDir: await makeTempDir(), runtimeConfigDir: configDir });
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
    const result = await new ClaudeCodeAgent(deps).listRuntimeSkills({ workingDir: await makeTempDir(), runtimeConfigDir: configDir });
    expect(result.skills.map((skill) => skill.name)).toEqual(['learn', 'cindy-plugin-a:demo', 'cindy-plugin-b:demo']);
  });
});
