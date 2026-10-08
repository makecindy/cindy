/**
 * 设备托管会话属于另一个账号(供应商分享的受邀者)时，Claude Code 不执行任何 hooks、
 * 不加载会话目录之外的 CLAUDE.md，也不带本机安装的托管技能、插件清单与通讯录说明；
 * 只能用分享的供应商：请求带路由令牌、可选模型只列该供应商的、不套用本机的子代理模型设置。
 * 同账号托管会话不变。
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  DEVICE_HOSTED_GUEST_ROUTE_HEADER,
  type AgentDeps,
  type DeviceHostedGuestProvider,
  type DeviceHostedSession,
} from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { Logger } from '../../../interfaces/logger.js';
import { CONTACTS_RULES_DISABLED } from '../../../contacts/system-prompt.js';

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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-hosted-guest-'));
  tempDirs.push(dir);
  return dir;
}

const GHOST_ROSTER = 'HOST GHOST ROSTER';

interface CapturedOptions {
  plugins?: Array<{ type: string; path: string }>;
  systemPrompt?: { append?: string };
  settings?: {
    disableAllHooks?: boolean;
    claudeMdExcludes?: string[];
    availableModels?: string[];
    env?: Record<string, string>;
  };
  env?: Record<string, string>;
}

const GUEST_PROVIDER: DeviceHostedGuestProvider = {
  providerId: 'shared-provider',
  modelIds: ['shared/model-a', 'shared/model-b'],
  routeToken: 'guest-route-token',
};

const HOST_MODELS = ['shared/model-a', 'shared/model-b', 'other/model-c'].map((id) => ({
  id,
  displayName: id,
  contextWindow: 200_000,
  efforts: [],
  defaultEffort: null,
}));

async function startHostedSession(
  guest: boolean,
  overrides: { guestProvider?: DeviceHostedGuestProvider | null; providerId?: string } = {},
): Promise<{ options: CapturedOptions; sessionRoot: string }> {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const sessionRoot = path.join(await makeTempDir(), 'workspaces', 'c1', 's1');
  const mirrorRoot = path.join(sessionRoot, 'fs');
  const workingDir = path.join(mirrorRoot, 'workspace');
  await fs.mkdir(workingDir, { recursive: true });
  await fs.mkdir(path.join(configDir, 'managed', 'learn'), { recursive: true });
  await fs.writeFile(path.join(configDir, 'managed', 'learn', 'SKILL.md'), '---\nname: learn\ndescription: Fixture\n---\nBody');
  sdkMock.query.mockReturnValue(createFakeQuery());

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
  const deps: AgentDeps = {
    auth,
    runtimeConfig: { systemPrompt: 'GLOBAL CINDY HOST PROMPT', subagentModel: 'other/model-c' },
    capabilityAdditions: { availableModels: HOST_MODELS },
    binaryPath: process.execPath,
    logger: createNoopLogger(),
    getGhostRosterPrompt: () => GHOST_ROSTER,
    getContactsPromptState: () => 'disabled',
    getManagedSkills: async () => [{
      kind: 'agent-skill',
      name: 'learn',
      path: path.join(configDir, 'managed', 'learn', 'SKILL.md'),
      source: 'skill',
      enabled: true,
      claudeCommandName: 'cindy:learn',
    }],
  };
  const deviceHosted: DeviceHostedSession = {
    workingDir,
    extraDirs: [],
    writableDirs: [],
    platform: 'darwin',
    shell: 'zsh',
    isGitRepo: false,
    tunnelUrl: 'http://127.0.0.1:4000/t/tok/',
    tunnelToken: 'tok',
    mcpServers: [],
    mirrorRoot,
    ...(guest ? { guest: true } : {}),
    ...(guest && overrides.guestProvider !== null ? { guestProvider: overrides.guestProvider ?? GUEST_PROVIDER } : {}),
  };
  const handle = await new ClaudeCodeAgent(deps).startSession({
    sessionId: 'hosted-session',
    model: 'shared/model-a',
    providerId: overrides.providerId ?? 'shared-provider',
    workingDir,
    permissionMode: 'acceptEdits',
    deviceHosted,
  });
  liveHandles.push(handle);
  const options = sdkMock.query.mock.calls.at(-1)?.[0]?.options as CapturedOptions | undefined;
  if (!options) throw new Error('expected sdk query options');
  return { options, sessionRoot };
}

afterEach(async () => {
  await Promise.all(liveHandles.splice(0).map((handle) => handle.close()));
  for (const [call] of sdkMock.query.mock.calls) {
    for (const plugin of call.options.plugins ?? []) {
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

describe('Claude Code device-hosted guest sessions', () => {
  it('disables hooks, excludes CLAUDE.md above the session and skips host-managed skills', async () => {
    const { options, sessionRoot } = await startHostedSession(true);
    expect(options.settings?.disableAllHooks).toBe(true);
    const parentClaudeMd = path.join(path.dirname(sessionRoot), 'CLAUDE.md').split(path.sep).join('/');
    expect(options.settings?.claudeMdExcludes).toContain(parentClaudeMd);
    expect(options.plugins).toBeUndefined();
    // 不带本机的插件清单与通讯录说明(system prompt 改动已经维护者确认)。
    expect(options.systemPrompt?.append).not.toContain(GHOST_ROSTER);
    expect(options.systemPrompt?.append).not.toContain(CONTACTS_RULES_DISABLED);
  });

  it('routes only through the shared provider: route token, shared models, no host subagent model', async () => {
    const { options } = await startHostedSession(true);
    const header = `${DEVICE_HOSTED_GUEST_ROUTE_HEADER}: guest-route-token`;
    expect(options.env?.ANTHROPIC_CUSTOM_HEADERS?.split('\n')).toContain(header);
    // 最高优先级设置层再写一次，会话中途的项目设置改不掉它。
    expect(options.settings?.env?.ANTHROPIC_CUSTOM_HEADERS).toBe(options.env?.ANTHROPIC_CUSTOM_HEADERS);
    expect(options.settings?.availableModels).toEqual(['shared/model-a', 'shared/model-b']);
    expect(options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBeUndefined();
    expect(options.env?.ANTHROPIC_SMALL_FAST_MODEL).toBe('shared/model-a');
  });

  it('refuses a guest session without a provider boundary or on another provider', async () => {
    await expect(startHostedSession(true, { guestProvider: null })).rejects.toThrow(/REMOTE_AGENT_UNSUPPORTED/);
    await expect(startHostedSession(true, { providerId: 'other-provider' }))
      .rejects.toThrow(/REMOTE_AGENT_PROVIDER_NOT_ALLOWED/);
  });

  it('keeps same-account hosted sessions unchanged', async () => {
    const { options } = await startHostedSession(false);
    expect(options.settings?.disableAllHooks).toBeUndefined();
    expect(options.settings?.claudeMdExcludes).toBeUndefined();
    expect(options.plugins?.length).toBe(1);
    expect(options.systemPrompt?.append).toContain(GHOST_ROSTER);
    expect(options.systemPrompt?.append).toContain(CONTACTS_RULES_DISABLED);
    expect(options.env?.ANTHROPIC_CUSTOM_HEADERS).toBeUndefined();
    expect(options.settings?.env).toBeUndefined();
    expect(options.settings?.availableModels).toEqual(['shared/model-a', 'shared/model-b', 'other/model-c']);
    expect(options.env?.CLAUDE_CODE_SUBAGENT_MODEL).toBe('other/model-c');
  });
});
