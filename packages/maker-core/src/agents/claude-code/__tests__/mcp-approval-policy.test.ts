/**
 * Claude canUseTool 消费 host MCP 审批策略(deps.getMcpToolApprovalPolicy)的单测。
 *
 * 背景: 这个 hook 原本只有 Codex 的 mcpServerElicitation 在查, Claude 侧另有一份
 * 静态 allowedTools 白名单。同一个第一方 MCP 因此两端行为分叉 —— `cindy_browser`
 * 的 call_tool 在 Codex 侧静默执行, 在 Claude 侧每调用一次弹一次窗。
 *
 * 覆盖:
 *  - auto-approve  → 静默放行, 完全不惊动 interactionResolver
 *  - prompt        → 照常弹窗, 会话级 suggestion 保留("总是允许"可用)
 *  - prompt-each-time → 照常弹窗, 但 suggestion 被剥掉(不许持久化授权)
 *  - 策略抛错 / 返回非法值 → 按最保守的 prompt-each-time 处理, 绝不 fail-open
 *  - 非 MCP 内置工具不查策略; MCP 工具名按 `mcp__<server>__<tool>` 正确拆分
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps, McpToolApprovalContext, McpToolApprovalPolicy } from '../../base-agent.js';
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

function createDeps(
  getMcpToolApprovalPolicy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy,
): AgentDeps {
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
    ...(getMcpToolApprovalPolicy ? { getMcpToolApprovalPolicy } : {}),
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
  options: { toolUseID: string; suggestions?: unknown[] },
) => Promise<{ behavior: 'allow' | 'deny'; updatedInput?: Record<string, unknown>; message?: string }>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-mcp-policy-'));
  tempDirs.push(dir);
  return dir;
}

/** 起一个 session 并暴露 SDK query 的 canUseTool + 收到的 interaction 请求。 */
async function startSession(
  policy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy,
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const agent = new ClaudeCodeAgent(createDeps(policy));
  const handle = await agent.startSession({
    sessionId: 'session-mcp-policy',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: 'default',
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');

  const seen: InteractionRequest[] = [];
  handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
    seen.push(req);
    return { kind: 'permission', behavior: 'allow' };
  });

  return { agent, handle, canUseTool: queryOptions.canUseTool, seen };
}

/** 取出 resolver 收到的 permission 请求(测试只会产生这一类)。 */
function permissionRequests(seen: InteractionRequest[]) {
  return seen.flatMap((req) => (req.kind === 'permission' ? [req] : []));
}

const SESSION_SUGGESTION = [{ type: 'addRules', destination: 'session', behavior: 'allow' }];

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

describe('ClaudeCodeAgent canUseTool honors the host MCP approval policy', () => {
  it('auto-approves trusted MCP tools without prompting the user', async () => {
    const { handle, canUseTool, seen } = await startSession(() => 'auto-approve');

    const input = { name: 'browser', args: { action: 'navigate', url: 'https://example.com' } };
    const result = await canUseTool('mcp__cindy_browser__call_tool', input, {
      toolUseID: 't-browser',
    });

    expect(result.behavior).toBe('allow');
    expect(result.updatedInput).toEqual(input);
    // 关键: 没有产生任何权限交互 —— 一次浏览器调研不该攒出上百个弹窗。
    expect(seen).toHaveLength(0);
    await handle.close();
  });

  it('passes the parsed server / tool name and the raw input to the policy', async () => {
    const contexts: McpToolApprovalContext[] = [];
    const { handle, canUseTool } = await startSession((context) => {
      contexts.push(context);
      return 'auto-approve';
    });

    const input = { name: 'contacts_search', args: { query: 'Carol' } };
    await canUseTool('mcp__cindy_contacts__call_tool', input, { toolUseID: 't-contacts' });

    // server 段自身含下划线, 分隔符是双下划线 —— 拆分不能被 `cindy_contacts` 误伤。
    expect(contexts).toEqual([
      { serverName: 'cindy_contacts', toolName: 'call_tool', toolParams: input },
    ]);
    await handle.close();
  });

  it('keeps prompting (with session suggestions) for policy "prompt"', async () => {
    const { handle, canUseTool, seen } = await startSession(() => 'prompt');

    const result = await canUseTool('mcp__cindy_ssh__call_tool', { name: 'ssh_exec' }, {
      toolUseID: 't-ssh',
      suggestions: SESSION_SUGGESTION,
    });

    expect(result.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(1);
    expect(permissionRequests(seen)[0]?.suggestions).toHaveLength(1);
    await handle.close();
  });

  it('strips session suggestions for policy "prompt-each-time"', async () => {
    const { handle, canUseTool, seen } = await startSession(() => 'prompt-each-time');

    await canUseTool('mcp__cindy_contacts__call_tool', { name: 'contacts_delete' }, {
      toolUseID: 't-delete',
      suggestions: SESSION_SUGGESTION,
    });

    const requests = permissionRequests(seen);
    expect(requests).toHaveLength(1);
    // 逐次确认的语义就是不许一次点选永久放行。
    expect(requests[0]?.suggestions).toBeUndefined();
    await handle.close();
  });

  it('falls back to prompt-each-time when the policy throws or returns garbage', async () => {
    const thrower = await startSession(() => {
      throw new Error('policy exploded');
    });
    await thrower.canUseTool('mcp__cindy_browser__call_tool', {}, {
      toolUseID: 't-throw',
      suggestions: SESSION_SUGGESTION,
    });
    const thrownRequests = permissionRequests(thrower.seen);
    expect(thrownRequests).toHaveLength(1);
    expect(thrownRequests[0]?.suggestions).toBeUndefined();
    await thrower.handle.close();

    const garbage = await startSession(() => 'definitely-not-a-policy' as McpToolApprovalPolicy);
    await garbage.canUseTool('mcp__cindy_browser__call_tool', {}, {
      toolUseID: 't-garbage',
      suggestions: SESSION_SUGGESTION,
    });
    const garbageRequests = permissionRequests(garbage.seen);
    expect(garbageRequests).toHaveLength(1);
    expect(garbageRequests[0]?.suggestions).toBeUndefined();
    await garbage.handle.close();
  });

  it('never routes built-in tools through the MCP policy', async () => {
    const calls: McpToolApprovalContext[] = [];
    const { handle, canUseTool, seen } = await startSession((context) => {
      calls.push(context);
      return 'auto-approve';
    });

    for (const tool of ['Bash', 'Write', 'Read', 'WebFetch', 'mcp__notaserver']) {
      await canUseTool(tool, {}, { toolUseID: `t-${tool}` });
    }

    expect(calls).toHaveLength(0);
    // 全部照常走权限链, 不因 MCP 策略被静默放行。
    expect(permissionRequests(seen).map((req) => req.toolName)).toEqual([
      'Bash',
      'Write',
      'Read',
      'WebFetch',
      'mcp__notaserver',
    ]);
    await handle.close();
  });

  it('leaves MCP tools on the original permission chain when no policy is injected', async () => {
    const { handle, canUseTool, seen } = await startSession();

    await canUseTool('mcp__cindy_browser__call_tool', {}, { toolUseID: 't-nopolicy' });

    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});
