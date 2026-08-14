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
 *  - fail-closed 闸绑定的是「resolver 在不在」而非「有没有界面」: 裸 handle 下(含 auto 档)
 *    连可信 MCP 也 deny, 而有 resolver 的无界面会话照旧静默放行
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentDeps,
  McpToolApprovalContext,
  McpToolApprovalPolicy,
  TurnPermissionPolicy,
} from '../../base-agent.js';
import type { PermissionMode } from '../../../types/common.js';
import type { CapabilityRoutingPolicy } from '../../../types/capability-routing.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { InteractionDecision, InteractionRequest } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type {
  McpProvider,
  McpProviderContext,
} from '../../../interfaces/mcp-provider.js';

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

/** 本 session 注册的 MCP server —— canUseTool 只认这批名字做归属判定。 */
const REGISTERED_MCP_SERVERS = [
  'cindy_browser',
  'cindy_contacts',
  'cindy_ssh',
  // 自定义 MCP 的 id 正则允许下划线, 所以可以叫出这种冒充第一方前缀的名字。
  'cindy_browser__evil',
];

function createMcpProviders(names: readonly string[]): McpProvider[] {
  return names.map((name) => ({
    name,
    toClaudeSdkConfig: () => ({ type: 'stdio', command: 'true' }),
  }));
}

function createDeps(
  getMcpToolApprovalPolicy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy,
  mcpServerNames: readonly string[] = REGISTERED_MCP_SERVERS,
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
    mcpProviders: createMcpProviders(mcpServerNames),
    ...(getMcpToolApprovalPolicy ? { getMcpToolApprovalPolicy } : {}),
  };
}

/** 最小可用的 SDK Query 假实现: 消息流永远挂起, 控制方法全部记录调用。 */
function createFakeQuery(
  initMcpServerNames: readonly string[] = [],
  failedInitMcpServerNames: readonly string[] = [],
  mcpServerStatuses: ReadonlyArray<{
    name: string;
    status: string;
    scope?: string;
  }> = initMcpServerNames.map((name) => ({
    name,
    status: 'connected',
    scope: 'dynamic',
  })),
) {
  let initEmitted = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (
            !initEmitted &&
            (initMcpServerNames.length > 0 || failedInitMcpServerNames.length > 0)
          ) {
            initEmitted = true;
            return Promise.resolve({
              done: false as const,
              value: {
                type: 'system',
                subtype: 'init',
                session_id: 'sdk-mcp-policy',
                mcp_servers: initMcpServerNames.map((name) => ({
                  name,
                  status: 'connected',
                })).concat(failedInitMcpServerNames.map((name) => ({
                  name,
                  status: 'failed',
                }))),
              },
            });
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
    setPermissionMode: vi.fn(async () => {}),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    mcpServerStatus: vi.fn(async () => [...mcpServerStatuses]),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
  };
}

/** 与真实 canUseTool 契约对齐 —— 含 allow 分支可能带回的 updatedPermissions。 */
type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: {
    toolUseID: string;
    title?: string;
    description?: string;
    suggestions?: unknown[];
  },
) => Promise<{
  behavior: 'allow' | 'deny';
  updatedInput?: Record<string, unknown>;
  updatedPermissions?: unknown[];
  message?: string;
}>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-mcp-policy-'));
  tempDirs.push(dir);
  return dir;
}

/** 起一个 session 并暴露 SDK query 的 canUseTool + 收到的 interaction 请求。 */
async function startSession(
  policy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy,
  options?: {
    mcpServerNames?: readonly string[];
    /** 覆盖 resolver 的决策；默认简单 allow。返回 undefined 表示挂起不决策。 */
    decide?: (req: InteractionRequest) => InteractionDecision | undefined;
    /** true 时不注入 resolver，用于验证 fail-closed 分支。 */
    bare?: boolean;
    permissionMode?: PermissionMode;
    capabilityRouting?: CapabilityRoutingPolicy;
    initMcpServerNames?: readonly string[];
    failedInitMcpServerNames?: readonly string[];
    mcpServerStatuses?: ReadonlyArray<{
      name: string;
      status: string;
      scope?: string;
    }>;
    turnChangeCapture?: AgentDeps['turnChangeCapture'];
    getMcpToolApprovalPresentation?: AgentDeps['getMcpToolApprovalPresentation'];
  },
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const fakeQuery = createFakeQuery(
    options?.initMcpServerNames,
    options?.failedInitMcpServerNames,
    options?.mcpServerStatuses,
  );
  sdkMock.query.mockReturnValue(fakeQuery);

  const deps = createDeps(policy, options?.mcpServerNames);
  deps.capabilityRouting = options?.capabilityRouting;
  deps.turnChangeCapture = options?.turnChangeCapture;
  deps.getMcpToolApprovalPresentation = options?.getMcpToolApprovalPresentation;
  const agent = new ClaudeCodeAgent(deps);
  const handle = await agent.startSession({
    sessionId: 'session-mcp-policy',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode: options?.permissionMode ?? 'default',
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | {
        canUseTool?: CanUseToolFn;
        hooks?: Record<
          string,
          Array<{ hooks: Array<(input: unknown) => Promise<unknown>> }>
        >;
      }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');

  const seen: InteractionRequest[] = [];
  if (!options?.bare) {
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      const decided = options?.decide?.(req);
      if (decided) return decided;
      // undefined = 请求保持挂起，交给 dismissAllPending 结算。
      if (options?.decide) return new Promise<InteractionDecision>(() => {});
      return { kind: 'permission', behavior: 'allow' };
    });
  }

  return {
    agent,
    handle,
    canUseTool: queryOptions.canUseTool,
    hooks: queryOptions.hooks,
    seen,
    workingDir,
  };
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
  it('captures known writes before execution and marks Bash opaque only after execution', async () => {
    const beforeKnownFileWrite = vi.fn(async () => undefined);
    const noteOpaqueWrite = vi.fn();
    const { handle, hooks, workingDir } = await startSession(undefined, {
      turnChangeCapture: { beforeKnownFileWrite, noteOpaqueWrite },
    });
    const pre = hooks?.PreToolUse?.[0]?.hooks[0];
    const post = hooks?.PostToolUse?.[0]?.hooks[0];
    if (!pre || !post) throw new Error('expected turn change capture hooks');

    await pre({
      hook_event_name: 'PreToolUse',
      tool_name: 'Write',
      tool_input: { file_path: 'a.ts', content: 'next' },
    });
    await pre({
      hook_event_name: 'PreToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'touch b.ts' },
    });
    expect(beforeKnownFileWrite).toHaveBeenCalledWith({
      sessionId: 'session-mcp-policy',
      provider: 'claude-code',
      cwd: workingDir,
      targetPath: 'a.ts',
    });
    expect(noteOpaqueWrite).not.toHaveBeenCalled();

    await post({
      hook_event_name: 'PostToolUse',
      tool_name: 'Bash',
      tool_input: { command: 'touch b.ts' },
    });
    expect(noteOpaqueWrite).toHaveBeenCalledWith({
      sessionId: 'session-mcp-policy',
      provider: 'claude-code',
      cwd: workingDir,
    });
    await handle.close();
  });

  it('injects the local route as a PreToolUse guard even in Full access', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: [
            '/feishu-delegate:message-feishu-coworkers',
          ],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const { handle, hooks } = await startSession(undefined, {
      permissionMode: 'bypassPermissions',
      capabilityRouting,
      initMcpServerNames: ['plugin:feishu-delegate:feishu-delegate'],
      mcpServerStatuses: [{
        name: 'plugin:feishu-delegate:feishu-delegate',
        status: 'connected',
        scope: 'dynamic',
      }],
    });
    const preToolUse = hooks?.PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected capability routing hook');
    const toolInput = {
      hook_event_name: 'PreToolUse',
      tool_name:
        'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
    };

    await handle.send({ type: 'user', content: '查一下康康的飞书消息' });
    await expect(preToolUse(toolInput)).resolves.toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });

    await handle.steer({
      type: 'user',
      content:
        '/feishu-delegate:message-feishu-coworkers 改用这个来源',
    });
    await expect(preToolUse(toolInput)).resolves.toEqual({ continue: true });
    await handle.close();
  });

  it('keeps a normalized-prefix-colliding user MCP on the normal permission chain', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: [
            '/feishu-delegate:message-feishu-coworkers',
          ],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const userServerId = 'plugin_feishu-delegate_feishu-delegate';
    const { handle, hooks, canUseTool, seen } = await startSession(
      () => 'prompt',
      {
        capabilityRouting,
        mcpServerNames: [userServerId],
      },
    );
    const preToolUse = hooks?.PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected capability routing hook');
    const toolName = `mcp__${userServerId}__read_messages`;

    await handle.send({ type: 'user', content: '查一下康康的飞书消息' });
    await expect(
      preToolUse({
        hook_event_name: 'PreToolUse',
        tool_name: toolName,
      }),
    ).resolves.toEqual({ continue: true });
    await expect(
      canUseTool(toolName, {}, { toolUseID: 'tool-user-mcp-collision' }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });

  it('uses the SDK init registry to preserve a colliding settings MCP', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const userServerId = 'plugin_feishu-delegate_feishu-delegate';
    const { handle, hooks, canUseTool, seen } = await startSession(
      () => 'prompt',
      {
        capabilityRouting,
        mcpServerNames: [],
        initMcpServerNames: [
          'plugin:feishu-delegate:feishu-delegate',
          userServerId,
        ],
        mcpServerStatuses: [
          {
            name: 'plugin:feishu-delegate:feishu-delegate',
            status: 'connected',
            scope: 'dynamic',
          },
          { name: userServerId, status: 'connected', scope: 'project' },
        ],
      },
    );
    const preToolUse = hooks?.PreToolUse?.[0]?.hooks[0];
    if (!preToolUse) throw new Error('expected capability routing hook');
    const toolName = `mcp__${userServerId}__read_messages`;

    await handle.send({ type: 'user', content: '查一下康康的飞书消息' });
    await vi.waitFor(async () => {
      await expect(
        preToolUse({
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
        }),
      ).resolves.toEqual({ continue: true });
    });
    await expect(
      canUseTool(toolName, {}, { toolUseID: 'tool-settings-mcp-collision' }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();

    const exact = await startSession(() => 'prompt', {
      capabilityRouting,
      mcpServerNames: [],
      initMcpServerNames: ['plugin:feishu-delegate:feishu-delegate'],
      mcpServerStatuses: [{
        name: 'plugin:feishu-delegate:feishu-delegate',
        status: 'connected',
        scope: 'user',
      }],
    });
    const exactPreToolUse = exact.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!exactPreToolUse) throw new Error('expected capability routing hook');
    await exact.handle.send({ type: 'user', content: '查一下康康的飞书消息' });
    await vi.waitFor(async () => {
      await expect(
        exactPreToolUse({
          hook_event_name: 'PreToolUse',
          tool_name:
            'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        }),
      ).resolves.toEqual({ continue: true });
    });
    await exact.handle.close();

    const failed = await startSession(() => 'prompt', {
      capabilityRouting,
      mcpServerNames: [],
      initMcpServerNames: [],
      failedInitMcpServerNames: [userServerId],
    });
    const failedPreToolUse = failed.hooks?.PreToolUse?.[0]?.hooks[0];
    if (!failedPreToolUse) throw new Error('expected capability routing hook');
    await failed.handle.send({ type: 'user', content: '查一下康康的飞书消息' });
    await vi.waitFor(async () => {
      await expect(
        failedPreToolUse({
          hook_event_name: 'PreToolUse',
          tool_name: toolName,
        }),
      ).resolves.toMatchObject({
        hookSpecificOutput: { permissionDecision: 'deny' },
      });
    });
    await failed.handle.close();
  });

  it('runs the per-turn policy before MCP auto-approval and drops session grants', async () => {
    const { handle, canUseTool, seen } = await startSession(
      () => 'auto-approve',
      {
        decide: () => ({
          kind: 'permission',
          behavior: 'allow',
          permissionUpdates: SESSION_SUGGESTION,
        }),
      },
    );
    const turnPermissionPolicy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'wechat', taskId: 'task-claude' },
      confirmationSurface: 'desktop',
      forceConfirmToolCall: (toolName) => toolName.includes('contacts'),
    };
    await handle.send(
      { type: 'user', content: 'delete the duplicate contact' },
      { turnPermissionPolicy },
    );

    const result = await canUseTool(
      'mcp__cindy_contacts__call_tool',
      { name: 'contacts_delete' },
      { toolUseID: 't-policy', suggestions: SESSION_SUGGESTION },
    );

    expect(permissionRequests(seen)).toHaveLength(1);
    expect(permissionRequests(seen)[0]?.suggestions).toBeUndefined();
    expect(result.behavior).toBe('allow');
    expect(result.updatedPermissions).toBeUndefined();
    await handle.close();
  });

  it('rejects a per-turn policy in permission modes that can skip canUseTool', async () => {
    const { handle } = await startSession(undefined, {
      permissionMode: 'bypassPermissions',
    });
    const policy: TurnPermissionPolicy = {
      origin: { kind: 'im', channel: 'wechat', taskId: 'task-full' },
      confirmationSurface: 'desktop',
      forceConfirmToolCall: () => true,
    };

    await expect(
      handle.send(
        { type: 'user', content: 'remove it' },
        { turnPermissionPolicy: policy },
      ),
    ).rejects.toMatchObject({
      name: 'TurnPermissionPolicyUnsupportedError',
      code: 'TURN_PERMISSION_POLICY_UNSUPPORTED',
      permissionMode: 'bypassPermissions',
    });
    await handle.close();
  });

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

  it('uses the host security disclosure for a progressive MCP action', async () => {
    const disclosure = {
      title: 'Allow Xcode to build this project?',
      description:
        'Build scripts may access files outside the project, and output is returned to the Agent.',
    };
    const { handle, canUseTool, seen } = await startSession(() => 'prompt-each-time', {
      mcpServerNames: ['cindy_ios_simulator'],
      getMcpToolApprovalPresentation: () => disclosure,
    });

    await canUseTool(
      'mcp__cindy_ios_simulator__call_tool',
      { name: 'build_app', args: {} },
      {
        toolUseID: 't-build',
        title: 'Generic MCP approval',
        description: 'Generic MCP description',
        suggestions: SESSION_SUGGESTION,
      },
    );

    expect(permissionRequests(seen)).toEqual([
      expect.objectContaining({
        title: disclosure.title,
        description: disclosure.description,
        suggestions: undefined,
      }),
    ]);
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

describe('MCP server attribution cannot be spoofed by tool-name prefixes', () => {
  it('attributes a custom server whose id embeds a trusted prefix to itself', async () => {
    const contexts: McpToolApprovalContext[] = [];
    const { handle, canUseTool } = await startSession((context) => {
      contexts.push(context);
      // 只有真正的第一方 cindy_browser 才可信。
      return context.serverName === 'cindy_browser' ? 'auto-approve' : 'prompt';
    });

    // 自定义 MCP 的 id 允许下划线，`cindy_browser__evil` 是合法 id。按 `__` 盲切会
    // 把它算成 cindy_browser，从而继承第一方信任——这里锁死最长匹配的正确归属。
    const result = await canUseTool('mcp__cindy_browser__evil__call_tool', {}, {
      toolUseID: 't-spoof',
    });

    expect(contexts).toEqual([
      { serverName: 'cindy_browser__evil', toolName: 'call_tool', toolParams: {} },
    ]);
    // 走了权限链而不是静默放行。
    expect(result.behavior).toBe('allow');
    await handle.close();
  });

  it('does not consult the policy for servers this session never registered', async () => {
    const contexts: McpToolApprovalContext[] = [];
    const { handle, canUseTool, seen } = await startSession(
      (context) => {
        contexts.push(context);
        return 'auto-approve';
      },
      { mcpServerNames: ['cindy_browser'] },
    );

    await canUseTool('mcp__cindy_slack__slack_call_tool', {}, { toolUseID: 't-unregistered' });

    expect(contexts).toHaveLength(0);
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});

describe('prompt-each-time never turns into a persisted grant', () => {
  it('drops permission updates that a surface attaches on its own', async () => {
    const { handle, canUseTool } = await startSession(() => 'prompt-each-time', {
      // 模拟 hook-control / IM 卡片流：不看 request.suggestions，自行拼 session 规则。
      decide: () => ({
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [{ type: 'addRules', destination: 'session', behavior: 'allow' }],
      }),
    });

    const result = await canUseTool('mcp__cindy_contacts__call_tool', { name: 'contacts_delete' }, {
      toolUseID: 't-grant',
    });

    expect(result.behavior).toBe('allow');
    // 本次放行，但不给 SDK 落任何会话规则——否则后续调用全部跳过 canUseTool。
    expect(result.updatedPermissions).toBeUndefined();
    await handle.close();
  });

  it('still forwards permission updates for ordinary prompt policy', async () => {
    const { handle, canUseTool } = await startSession(() => 'prompt', {
      decide: () => ({
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [{ type: 'addRules', destination: 'session', behavior: 'allow' }],
      }),
    });

    const result = await canUseTool('mcp__cindy_ssh__call_tool', { name: 'ssh_exec' }, {
      toolUseID: 't-grant-ok',
    });

    expect(result.updatedPermissions).toHaveLength(1);
    await handle.close();
  });

  it('denies a pending forced prompt when the session switches to a laxer mode', async () => {
    const { handle, canUseTool } = await startSession(() => 'prompt-each-time', {
      // 决策永不返回：请求挂起，等模式切换来结算。
      decide: () => undefined,
    });

    const pending = canUseTool('mcp__cindy_contacts__call_tool', { name: 'contacts_merge' }, {
      toolUseID: 't-pending',
    });
    // 让 canUseTool 跑到 dispatchInteraction 并登记 pending。
    await new Promise((resolve) => setImmediate(resolve));

    // CC agent 实现了 setPermissionMode (接口上可选是因为其他 agent 可缺省)。
    await handle.setPermissionMode!('bypassPermissions');

    // 切到 Full access 也不能替用户批准这一次高风险调用。
    expect((await pending).behavior).toBe('deny');
    await handle.close();
  });

  it('still auto-allows ordinary pending prompts on a laxer mode switch', async () => {
    const { handle, canUseTool } = await startSession(() => 'prompt', {
      decide: () => undefined,
    });

    const pending = canUseTool('mcp__cindy_ssh__call_tool', { name: 'ssh_exec' }, {
      toolUseID: 't-pending-ok',
    });
    await new Promise((resolve) => setImmediate(resolve));

    await handle.setPermissionMode!('bypassPermissions');

    expect((await pending).behavior).toBe('allow');
    await handle.close();
  });
});

describe('a custom server cannot take over a builtin name', () => {
  it('把 session 花名册快照追加到 Claude systemPrompt', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    sdkMock.query.mockReturnValue(createFakeQuery());
    const deps = createDeps();
    deps.getGhostRosterPrompt = vi.fn(() => 'GHOST ROSTER PROMPT');
    const handle = await new ClaudeCodeAgent(deps).startSession({
      sessionId: 'session-roster-prompt',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'default',
    });
    const options = sdkMock.query.mock.calls.at(-1)?.[0]?.options as {
      systemPrompt?: { append?: string };
    };
    expect(options.systemPrompt?.append).toContain('GHOST ROSTER PROMPT');
    expect(deps.getGhostRosterPrompt).toHaveBeenCalledWith({ workingDir });
    await handle.close();
  });

  it('passes the runtime session instance id into Claude MCP provider context', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    sdkMock.query.mockReturnValue(createFakeQuery());
    let capturedContext: McpProviderContext | undefined;
    const deps = createDeps();
    deps.mcpProviders = [
      {
        name: 'cindy_probe',
        toClaudeSdkConfig: (context) => {
          capturedContext = context;
          return { type: 'stdio', command: 'true' };
        },
      },
    ];

    const handle = await new ClaudeCodeAgent(deps).startSession({
      sessionId: 'session-instance-context',
      sessionInstanceId: 'instance-claude-context',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'default',
    });

    expect(capturedContext).toMatchObject({
      agentKind: 'claude-code',
      sessionId: 'session-instance-context',
      sessionInstanceId: 'instance-claude-context',
      workingDir,
    });
    await handle.close();
  });

  it('keeps the first registration when two providers share a name', async () => {
    const configs: Array<{ name: string; marker: string }> = [];
    const contexts: McpToolApprovalContext[] = [];
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    sdkMock.query.mockReturnValue(createFakeQuery());

    const deps = createDeps((context) => {
      contexts.push(context);
      return 'auto-approve';
    });
    // host 把用户自定义 MCP 追加在内置之后；同名时后写覆盖会让第三方端点顶替内置
    // server 并继承它的信任。这里两个 provider 同名，断言内置（先注册的）胜出。
    deps.mcpProviders = [
      { name: 'cindy_browser', toClaudeSdkConfig: () => ({ type: 'sdk', marker: 'builtin' }) },
      { name: 'cindy_browser', toClaudeSdkConfig: () => ({ type: 'http', marker: 'custom' }) },
    ] as McpProvider[];

    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-dup-mcp',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'default',
    });

    const mcpServers = sdkMock.query.mock.calls.at(-1)?.[0]?.options?.mcpServers as
      | Record<string, { marker?: string }>
      | undefined;
    configs.push({ name: 'cindy_browser', marker: mcpServers?.cindy_browser?.marker ?? 'missing' });

    expect(configs).toEqual([{ name: 'cindy_browser', marker: 'builtin' }]);
    await handle.close();
  });

  it('treats an unsafe object-key server name as an ordinary key', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    sdkMock.query.mockReturnValue(createFakeQuery());

    const deps = createDeps(() => 'prompt');
    // 自定义 MCP 的 id 正则允许下划线，`__proto__` 是合法 id。普通 `{}` 作 map 时这个键
    // 会打到原型访问器上：server 注册不进去、去重看不见它，map 的原型还被换成 config。
    deps.mcpProviders = [
      { name: '__proto__', toClaudeSdkConfig: () => ({ type: 'http', marker: 'evil' }) },
      { name: 'cindy_browser', toClaudeSdkConfig: () => ({ type: 'sdk', marker: 'builtin' }) },
    ] as McpProvider[];

    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-proto-mcp',
      model: 'claude-opus-4-6',
      workingDir,
      permissionMode: 'default',
    });

    const mcpServers = sdkMock.query.mock.calls.at(-1)?.[0]?.options?.mcpServers as
      | Record<string, unknown>
      | undefined;
    // 作为普通自有键存在，且没有污染原型。
    expect(Object.keys(mcpServers ?? {}).sort()).toEqual(['__proto__', 'cindy_browser']);
    expect(Object.getPrototypeOf({} as Record<string, unknown>)).toBe(Object.prototype);
    expect(({} as { marker?: string }).marker).toBeUndefined();
    await handle.close();
  });
});

/**
 * 这道闸绑定的是「resolver 在不在」，**不是**「有没有界面」。两者常被混为一谈，所以
 * 正反两面都要钉住（见 issue #1577）：
 *
 * - 无 resolver（misconfiguration / 不经 Session 直用裸 handle）→ 连可信 MCP 也 deny。
 *   `canReviewWithoutUi` 刻意只对内建工具成立：host 策略回答的是「值不值得打扰用户」，
 *   不代表「没有人在场也可以跑」，而裸 handle 下没有任何人能撤销误判。Auto 档不例外。
 * - 有 resolver 但没有界面（Telegram / 飞书 bot、scheduler 定时任务、Orca headless
 *   worker）→ 可信 MCP 在 dispatch **之前**就短路放行。这类会话恒有 resolver：
 *   `Session` 构造函数里那次 `handle.setInteractionResolver(...)` 必定注入（没接
 *   listener 时该 resolver 自身
 *   返回 deny），所以它们走的从来不是上面那条 fail-closed 分支。少了这条用例，很容易
 *   把「headless 下 orca_worker_bridge 会被拒」当成缺陷去改，反而把裸 handle 的边界拆了。
 */
describe('fail-closed still precedes the MCP policy', () => {
  it('denies trusted MCP tools when no interaction resolver is attached', async () => {
    const { handle, canUseTool } = await startSession(() => 'auto-approve', { bare: true });

    const result = await canUseTool('mcp__cindy_browser__call_tool', {}, { toolUseID: 't-bare' });

    // host 策略说的是"值不值得打扰用户"，不代表"没有用户在场也能跑"。
    expect(result.behavior).toBe('deny');
    await handle.close();
  });

  it('denies trusted MCP tools in auto mode too when no resolver is attached', async () => {
    const { handle, canUseTool } = await startSession(() => 'auto-approve', {
      bare: true,
      permissionMode: 'auto',
    });

    // Auto 只让**内建**工具在无 UI 下由本地规则/轻量 reviewer 自决;mcp__* 被刻意排除。
    const result = await canUseTool('mcp__cindy_browser__call_tool', {}, { toolUseID: 't-bare-auto' });

    expect(result.behavior).toBe('deny');
    await handle.close();
  });

  it('auto-approves trusted MCP tools in auto mode without dispatching an interaction', async () => {
    const { handle, canUseTool, seen } = await startSession(() => 'auto-approve', {
      permissionMode: 'auto',
    });

    const result = await canUseTool('mcp__cindy_browser__call_tool', {}, { toolUseID: 't-auto-trusted' });

    // 无界面会话靠这条短路:逐次弹窗只会让远端 daemon 等审批超时、回报断链。
    expect(result.behavior).toBe('allow');
    // 断言 seen 整体为空,而不只是 permission 类:用例声称的是「完全不 dispatch」,
    // 只查 permission 会让将来改成发 plan_review / ask_user_question 的实现误通过。
    expect(seen).toHaveLength(0);
    await handle.close();
  });
});

describe('remote sessions share the same permission semantics', () => {
  /** 起一个远端会话并拿到 daemon 侧的 approval 回调。 */
  async function startRemoteSession(
    policy: (context: McpToolApprovalContext) => McpToolApprovalPolicy,
    options?: {
      attachResolver?: (req: InteractionRequest) => InteractionDecision;
      capabilityRouting?: CapabilityRoutingPolicy;
      mcpServerNames?: readonly string[];
      permissionMode?: PermissionMode;
      initMcpServerNames?: readonly string[];
      failedInitMcpServerNames?: readonly string[];
      getGhostRosterPrompt?: AgentDeps['getGhostRosterPrompt'];
      getMcpToolApprovalPresentation?: AgentDeps['getMcpToolApprovalPresentation'];
    },
  ) {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();

    let onApprovalRequest: ((raw: unknown) => Promise<{ behavior?: string }>) | undefined;
    const deps = createDeps(policy);
    deps.getGhostRosterPrompt = options?.getGhostRosterPrompt;
    deps.getMcpToolApprovalPresentation = options?.getMcpToolApprovalPresentation;
    deps.capabilityRouting = options?.capabilityRouting;
    // 远端只装得到 stdio / sse / http 类 server —— in-process 的会被 filter 掉。
    deps.mcpProviders = (
      options?.mcpServerNames ?? ['cindy_browser', 'cindy_contacts']
    ).map((name) => ({
      name,
      toClaudeSdkConfig: () => ({ type: 'http', url: `https://x/${name}` }),
    })) as McpProvider[];
    let remoteStartParams: Record<string, unknown> | undefined;
    let remoteIdentity: { sessionId: string; sessionInstanceId?: string } | undefined;
    deps.remoteCcQueryFactory = (async (args: {
      sessionId: string;
      sessionInstanceId?: string;
      onApprovalRequest: (raw: unknown) => Promise<{ behavior?: string }>;
      startParams: Record<string, unknown>;
    }) => {
      onApprovalRequest = args.onApprovalRequest;
      remoteStartParams = args.startParams;
      remoteIdentity = {
        sessionId: args.sessionId,
        ...(args.sessionInstanceId
          ? { sessionInstanceId: args.sessionInstanceId }
          : {}),
      };
      return createFakeQuery(
        options?.initMcpServerNames,
        options?.failedInitMcpServerNames,
      ) as never;
    }) as NonNullable<AgentDeps['remoteCcQueryFactory']>;

    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-remote-mcp-policy',
      sessionInstanceId: 'instance-remote-mcp-policy',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: options?.permissionMode ?? 'default',
    });
    const seen: InteractionRequest[] = [];
    if (options?.attachResolver) {
      handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
        seen.push(req);
        return options.attachResolver!(req);
      });
    }
    if (!onApprovalRequest) throw new Error('expected remote onApprovalRequest');
    return { handle, onApprovalRequest, seen, remoteStartParams, remoteIdentity };
  }

  it('passes the runtime session instance id into the remote Claude factory', async () => {
    const { handle, remoteIdentity } = await startRemoteSession(() => 'auto-approve');

    expect(remoteIdentity).toEqual({
      sessionId: 'session-remote-mcp-policy',
      sessionInstanceId: 'instance-remote-mcp-policy',
    });
    await handle.close();
  });

  it('does not inject the local ghost roster into remote Claude sessions', async () => {
    const getGhostRosterPrompt = vi.fn(() => 'GHOST ROSTER PROMPT');
    const { handle, remoteStartParams } = await startRemoteSession(() => 'auto-approve', {
      getGhostRosterPrompt,
    });

    expect(remoteStartParams).toBeDefined();
    expect(JSON.stringify(remoteStartParams)).not.toContain('GHOST ROSTER PROMPT');
    expect(getGhostRosterPrompt).not.toHaveBeenCalled();
    await handle.close();
  });

  it('auto-approves trusted MCP tools without prompting', async () => {
    const { handle, onApprovalRequest, seen } = await startRemoteSession(() => 'auto-approve', {
      attachResolver: () => ({ kind: 'permission', behavior: 'allow' }),
    });

    const result = await onApprovalRequest({
      requestId: 'r-1',
      kind: 'permission',
      toolName: 'mcp__cindy_browser__call_tool',
      input: { name: 'browser', args: { action: 'snapshot' } },
    });

    expect(result.behavior).toBe('allow');
    expect(seen).toHaveLength(0);
    await handle.close();
  });

  it('attributes factory-injected http MCP servers to the MCP policy (collab bridge)', async () => {
    // cc-2a 回归:maker-host remoteCcQueryFactory 会把 cindy_orca /
    // orca_worker_bridge 追加进 startParams.mcpServers (远端协同恢复通道)。
    // 审批归属快照必须在 factory 调用之后按最终清单定稿,否则注入 server 的
    // 工具调用 resolveMcpToolTarget 返回 null、绕过 MCP 策略走原权限链弹窗。
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();

    const seenContexts: McpToolApprovalContext[] = [];
    const deps = createDeps((context) => {
      seenContexts.push(context);
      return 'auto-approve';
    });
    deps.mcpProviders = [];
    let onApprovalRequest: ((raw: unknown) => Promise<{ behavior?: string }>) | undefined;
    deps.remoteCcQueryFactory = (async (args: {
      startParams: Record<string, unknown>;
      onApprovalRequest: (raw: unknown) => Promise<{ behavior?: string }>;
    }) => {
      const params = args.startParams as { mcpServers?: Record<string, unknown> };
      params.mcpServers = {
        ...(params.mcpServers ?? {}),
        cindy_orca: { type: 'http', url: 'http://127.0.0.1:47921/mcp/cindy_orca?session=s1' },
      };
      onApprovalRequest = args.onApprovalRequest;
      return createFakeQuery() as never;
    }) as NonNullable<AgentDeps['remoteCcQueryFactory']>;

    const agent = new ClaudeCodeAgent(deps);
    const handle = await agent.startSession({
      sessionId: 'session-remote-injected-mcp',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'default',
    });
    handle.setInteractionResolver(() => Promise.resolve({ kind: 'permission', behavior: 'allow' }));
    if (!onApprovalRequest) throw new Error('expected remote onApprovalRequest');

    const result = await onApprovalRequest({
      requestId: 'r-injected',
      kind: 'permission',
      toolName: 'mcp__cindy_orca__list_workers',
      input: {},
    });

    expect(result.behavior).toBe('allow');
    // 关键:MCP 策略确实按 cindy_orca 归属被调用,而不是归属 miss 走原权限链。
    expect(seenContexts.some((c) => c.serverName === 'cindy_orca')).toBe(true);
    await handle.close();
  });

  it('drops session grants for prompt-each-time tools', async () => {
    const { handle, onApprovalRequest } = await startRemoteSession(() => 'prompt-each-time', {
      attachResolver: () => ({
        kind: 'permission',
        behavior: 'allow',
        permissionUpdates: [{ type: 'addRules', destination: 'session', behavior: 'allow' }],
      }),
    });

    const result = (await onApprovalRequest({
      requestId: 'r-2',
      kind: 'permission',
      toolName: 'mcp__cindy_contacts__call_tool',
      input: { name: 'contacts_delete' },
    })) as { behavior?: string; permissionUpdates?: unknown[] };

    expect(result.behavior).toBe('allow');
    expect(result.permissionUpdates).toBeUndefined();
    await handle.close();
  });

  it('uses the host security disclosure for remote progressive MCP actions', async () => {
    const disclosure = {
      title: 'Allow Xcode to build this project?',
      description:
        'Build scripts may access files outside the project, and output is returned to the Agent.',
    };
    const { handle, onApprovalRequest, seen } = await startRemoteSession(
      () => 'prompt-each-time',
      {
        mcpServerNames: ['cindy_ios_simulator'],
        getMcpToolApprovalPresentation: () => disclosure,
        attachResolver: () => ({ kind: 'permission', behavior: 'deny' }),
      },
    );

    const result = await onApprovalRequest({
      requestId: 'r-build',
      kind: 'permission',
      toolName: 'mcp__cindy_ios_simulator__call_tool',
      input: { name: 'build_app', args: {} },
      title: 'Generic MCP approval',
      description: 'Generic MCP description',
      suggestions: SESSION_SUGGESTION,
    });

    expect(result.behavior).toBe('deny');
    expect(permissionRequests(seen)).toEqual([
      expect.objectContaining({
        title: disclosure.title,
        description: disclosure.description,
        suggestions: undefined,
      }),
    ]);
    await handle.close();
  });

  it('fails closed instead of allowing when no resolver is attached', async () => {
    const { handle, onApprovalRequest } = await startRemoteSession(() => 'prompt');

    // 改动前这里 return allow —— 裸远端会话可以在无人在场时跑破坏性工具。
    const denied = await onApprovalRequest({
      requestId: 'r-3',
      kind: 'permission',
      toolName: 'Bash',
      input: { command: 'rm -rf /' },
    });
    expect(denied.behavior).toBe('deny');

    // 只读工具仍然放行，与本地 canUseTool 的白名单语义一致。
    const allowed = await onApprovalRequest({
      requestId: 'r-4',
      kind: 'permission',
      toolName: 'Read',
      input: { file_path: '/tmp/x' },
    });
    expect(allowed.behavior).toBe('allow');
    await handle.close();
  });

  it('guards plugin MCPs on remote sessions, including bypass mode, while preserving explicit selection', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
          replacement: {
            kind: 'cindy-plugin',
            id: 'xd-feishu',
          },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const options = {
      capabilityRouting,
      permissionMode: 'bypassPermissions' as const,
      attachResolver: (request: InteractionRequest): InteractionDecision =>
        request.kind === 'plan_review'
          ? {
              kind: 'plan_review',
              behavior: 'allow',
              editedPlan:
                '1. /feishu-delegate:message-feishu-coworkers 查询消息',
            }
          : { kind: 'permission', behavior: 'allow' },
    };

    const natural = await startRemoteSession(() => 'auto-approve', options);
    await natural.handle.send({ type: 'user', content: '查一下我和康康的飞书消息' });
    // The daemon-side PreToolUse guard works even in Full access, so Cindy
    // does not need to weaken the user's selected permission mode.
    expect(natural.remoteStartParams?.permissionMode).toBe(
      'bypassPermissions',
    );
    expect(natural.remoteStartParams?.toolGuards).toEqual([
      {
        toolNamePrefix:
          'mcp__plugin_feishu-delegate_feishu-delegate__',
        sourceServerId: 'plugin:feishu-delegate:feishu-delegate',
        invocation: 'explicit-only',
        explicitSelectors: [
          '/feishu-delegate:message-feishu-coworkers',
        ],
        denialMessage:
          'This downstream source was not explicitly selected. Use Cindy capability xd-feishu.',
      },
    ]);
    await expect(
      natural.onApprovalRequest({
        requestId: 'r-natural-feishu',
        kind: 'permission',
        toolName: 'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await expect(
      natural.onApprovalRequest({
        requestId: 'r-plan-feishu',
        kind: 'plan_review',
        plan: '1. 查询飞书消息',
      }),
    ).resolves.toMatchObject({
      behavior: 'allow',
      editedPlan:
        '1. /feishu-delegate:message-feishu-coworkers 查询消息',
    });
    await expect(
      natural.onApprovalRequest({
        requestId: 'r-edited-plan-feishu',
        kind: 'permission',
        toolName: 'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    // Defense-in-depth: if the SDK does request approval despite bypass mode,
    // unrelated tools still preserve Full access behavior.
    await expect(
      natural.onApprovalRequest({
        requestId: 'r-bypass-bash',
        kind: 'permission',
        toolName: 'Bash',
        input: { command: 'pwd' },
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await natural.handle.close();

    const dismissed = await startRemoteSession(() => 'auto-approve', {
      ...options,
      attachResolver: (request): InteractionDecision =>
        request.kind === 'plan_review'
          ? {
              kind: 'plan_review',
              behavior: 'deny',
              reason:
                'system dismissed /feishu-delegate:message-feishu-coworkers',
              dismissed: true,
            }
          : { kind: 'permission', behavior: 'allow' },
    });
    await dismissed.handle.send({ type: 'user', content: '查一下飞书消息' });
    await dismissed.onApprovalRequest({
      requestId: 'r-dismissed-plan-feishu',
      kind: 'plan_review',
      plan: '1. 查询飞书消息',
    });
    await expect(
      dismissed.onApprovalRequest({
        requestId: 'r-after-dismissed-plan-feishu',
        kind: 'permission',
        toolName: 'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'deny' });
    await dismissed.handle.close();

    const explicit = await startRemoteSession(() => 'auto-approve', options);
    await explicit.handle.send({
      type: 'user',
      content: '/feishu-delegate:message-feishu-coworkers 查一下康康',
    });
    await expect(
      explicit.onApprovalRequest({
        requestId: 'r-explicit-feishu',
        kind: 'permission',
        toolName: 'mcp__plugin_feishu-delegate_feishu-delegate__feishu_read_messages',
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    await explicit.handle.close();
  });

  it('serializes the remote guard while preserving a connected user MCP alias', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const userServerId = 'plugin_feishu-delegate_feishu-delegate';
    const remote = await startRemoteSession(() => 'prompt', {
      attachResolver: () => ({ kind: 'permission', behavior: 'allow' }),
      capabilityRouting,
      mcpServerNames: [userServerId],
    });

    expect(remote.remoteStartParams?.toolGuards).toHaveLength(1);
    await expect(
      remote.onApprovalRequest({
        requestId: 'r-user-mcp-collision',
        kind: 'permission',
        toolName: `mcp__${userServerId}__read_messages`,
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(remote.seen)).toHaveLength(1);
    await remote.handle.close();
  });

  it('uses the remote SDK init registry to preserve a colliding settings MCP', async () => {
    const capabilityRouting = {
      overrides: [
        {
          capabilityId: 'feishu',
          source: {
            kind: 'harness-plugin',
            harness: 'claude-code',
            surface: 'mcp',
            id: 'plugin:feishu-delegate:feishu-delegate',
          },
          invocation: 'explicit-only',
          explicitSelectors: ['/feishu-delegate:message-feishu-coworkers'],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const userServerId = 'plugin_feishu-delegate_feishu-delegate';
    const remote = await startRemoteSession(() => 'prompt', {
      attachResolver: () => ({ kind: 'permission', behavior: 'allow' }),
      capabilityRouting,
      mcpServerNames: [userServerId],
      initMcpServerNames: [
        'plugin:feishu-delegate:feishu-delegate',
        userServerId,
      ],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));

    await expect(
      remote.onApprovalRequest({
        requestId: 'r-settings-user-mcp-collision',
        kind: 'permission',
        toolName: `mcp__${userServerId}__read_messages`,
        input: {},
        metadata: { capabilityRoutingChecked: true },
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(remote.seen)).toHaveLength(1);
    await remote.handle.close();

    const exact = await startRemoteSession(() => 'prompt', {
      attachResolver: () => ({ kind: 'permission', behavior: 'allow' }),
      capabilityRouting,
      mcpServerNames: [userServerId],
      initMcpServerNames: ['plugin:feishu-delegate:feishu-delegate'],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await expect(
      exact.onApprovalRequest({
        requestId: 'r-exact-settings-mcp-collision',
        kind: 'permission',
        toolName:
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
        input: {},
        metadata: { capabilityRoutingChecked: true },
      }),
    ).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(exact.seen)).toHaveLength(1);
    await exact.handle.close();

    const failed = await startRemoteSession(() => 'prompt', {
      attachResolver: () => ({ kind: 'permission', behavior: 'allow' }),
      capabilityRouting,
      mcpServerNames: [userServerId],
      initMcpServerNames: [],
      failedInitMcpServerNames: [userServerId],
    });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(failed.remoteStartParams?.toolGuards).toHaveLength(1);
    await expect(
      failed.onApprovalRequest({
        requestId: 'r-failed-settings-mcp-collision',
        kind: 'permission',
        toolName: `mcp__${userServerId}__read_messages`,
        input: {},
      }),
    ).resolves.toMatchObject({ behavior: 'deny' });
    expect(permissionRequests(failed.seen)).toHaveLength(0);
    await failed.handle.close();
  });
});
