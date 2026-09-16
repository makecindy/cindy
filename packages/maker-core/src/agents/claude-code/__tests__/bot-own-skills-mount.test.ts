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
}) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  sdkMock.query.mockReturnValue(createFakeQuery());

  const deps = createDeps();
  let remoteOptions: unknown;
  if (input.remote) {
    deps.remoteCcQueryFactory = async ({ startParams, botSession }) => {
      expect(botSession).toBe(!input.reviewMode && !input.ordinary);
      remoteOptions = startParams.extraOptions;
      return createFakeQuery() as never;
    };
  }
  const agent = new ClaudeCodeAgent(deps);
  await agent.startSession({
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
        mode: 'inherit',
        configured: [],
        catalog: [],
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

  const options = (input.remote ? remoteOptions : sdkMock.query.mock.calls.at(-1)?.[0]?.options) as
    | {
        plugins?: Array<{ type: string; path: string }>;
        settingSources?: string[];
        disallowedTools?: string[];
        strictMcpConfig?: boolean;
        settings?: { autoMemoryEnabled?: boolean; autoDreamEnabled?: boolean };
        systemPrompt?: { append?: string };
      }
    | undefined;
  if (!options) throw new Error('expected sdk query options');
  return options;
}

afterEach(async () => {
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
    expect(options.disallowedTools).toEqual(['Task', 'Agent']);
    expect(options.strictMcpConfig).toBe(true);
    expect(options.settings).toMatchObject({ autoMemoryEnabled: false, autoDreamEnabled: false });
  });

  it('keeps remote Bot tools and memory in the same scope as local Bots', async () => {
    const options = await startBotSession({ remote: true });
    expect(options.disallowedTools).toEqual(['Task', 'Agent']);
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
