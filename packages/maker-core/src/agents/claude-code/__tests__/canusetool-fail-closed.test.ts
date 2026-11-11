/**
 * Claude canUseTool 在**没有** interactionResolver 时的 fail-closed 行为单测。
 *
 * 背景: 正常流程里 Session 构造时必定注入 resolver(见 session.ts), 故 handle 上
 * interactionResolver 为 null 只可能是 misconfiguration / 裸 handle 直用。安全拦截
 * 逻辑必须 fail-closed —— 缺 resolver 时只放行已知只读工具, 其它(写文件 / 跑命令 /
 * 外发 / 未知)一律 deny, 不再依赖 SDK permissionMode 兜底。
 *
 * 覆盖:
 *  - 无 resolver + 危险 / 未知工具 → deny
 *  - 无 resolver + 只读工具 → allow(且透传 input)
 *  - 有 resolver → 一律走原 dispatchInteraction 逻辑(含只读工具也交给 resolver),
 *    resolver 的 allow / deny 决策被如实映射
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { InteractionDecision, InteractionRequest } from '../../../types/events.js';
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
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: createNoopLogger(),
  };
}

/** 最小可用的 SDK Query 假实现: 消息流永远挂起, 控制方法全部记录调用。 */
function createFakeQuery() {
  return {
    [Symbol.asyncIterator]() {
      return { next: () => new Promise<IteratorResult<unknown>>(() => {}) };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string },
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-canuse-'));
  tempDirs.push(dir);
  return dir;
}

/** 起一个裸 handle(默认不注入 interactionResolver), 暴露 SDK query 的 canUseTool。 */
async function startBareSession() {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-canuse',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'default',
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');
  return { agent, handle, canUseTool: queryOptions.canUseTool };
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

describe('ClaudeCodeAgent canUseTool fail-closed (no interactionResolver)', () => {
  it('denies mutating / executing / external tools when no resolver is attached', async () => {
    const { handle, canUseTool } = await startBareSession();

    for (const tool of ['Write', 'Edit', 'MultiEdit', 'NotebookEdit', 'Bash', 'WebFetch', 'WebSearch', 'mcp__slack__send']) {
      const result = await canUseTool(tool, { path: '/tmp/x' }, { toolUseID: `t-${tool}` });
      expect(result.behavior, `${tool} should be denied`).toBe('deny');
    }
    await handle.close();
  });

  it('denies unknown tools by default (allowlist, not denylist)', async () => {
    const { handle, canUseTool } = await startBareSession();

    const result = await canUseTool('SomeBrandNewTool', {}, { toolUseID: 't-unknown' });
    expect(result.behavior).toBe('deny');
    await handle.close();
  });

  it('allows known read-only tools when no resolver is attached (and passes input through)', async () => {
    const { handle, canUseTool } = await startBareSession();

    for (const tool of ['Read', 'Glob', 'Grep', 'LS', 'NotebookRead']) {
      const input = { pattern: `x-${tool}` };
      const result = await canUseTool(tool, input, { toolUseID: `t-${tool}` });
      expect(result.behavior, `${tool} should be allowed`).toBe('allow');
      expect(result.updatedInput).toEqual(input);
    }
    await handle.close();
  });
});

describe('ClaudeCodeAgent canUseTool with interactionResolver (unchanged path)', () => {
  it('routes every tool (incl. read-only) through the resolver and honors allow', async () => {
    const { handle, canUseTool } = await startBareSession();
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      return { kind: 'permission', behavior: 'allow', updatedInput: { edited: true } };
    });

    // 危险工具走 resolver → allow, 且用 resolver 返回的 updatedInput。
    const writeResult = await canUseTool('Write', { path: '/tmp/a' }, { toolUseID: 't-write' });
    expect(writeResult.behavior).toBe('allow');
    expect(writeResult.updatedInput).toEqual({ edited: true });

    // 只读工具在**有 resolver**时也交给 resolver(不因白名单短路), 证明白名单只作用于无 resolver 分支。
    const readResult = await canUseTool('Read', { path: '/tmp/b' }, { toolUseID: 't-read' });
    expect(readResult.behavior).toBe('allow');

    expect(seen.map((r) => (r.kind === 'permission' ? r.toolName : r.kind))).toEqual(['Write', 'Read']);
    await handle.close();
  });

  it('honors resolver deny', async () => {
    const { handle, canUseTool } = await startBareSession();
    handle.setInteractionResolver(async (): Promise<InteractionDecision> => ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'user rejected',
    }));

    const result = await canUseTool('Bash', { command: 'rm -rf /' }, { toolUseID: 't-bash' });
    expect(result.behavior).toBe('deny');
    expect(result.message).toBe('User denied this tool call via Cindy: user rejected');
    await handle.close();
  });
});
