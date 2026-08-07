/**
 * Claude 计划模式（planMode 一级开关）单测。
 *
 * 覆盖:
 *  - startSession planMode → SDK query 以 permissionMode='plan' 启动, 底层权限档保留
 *  - setPlanMode 开/关 → q.setPermissionMode 在 plan 与底层档之间切换
 *  - 计划模式期间 setPermissionMode 只记账不 push SDK, 退出时落到最新底层档
 *  - ExitPlanMode 批准 → 自动退出计划模式 (plan_mode_changed 事件 + SDK 切回底层档)
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { PermissionMode } from '../../../types/common.js';
import type { AgentEvent, InteractionDecision, InteractionRequest } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';
import type { CapabilityRoutingPolicy } from '../../../types/capability-routing.js';

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

function createDeps(overrides: Partial<AgentDeps> = {}): AgentDeps {
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
    ...overrides,
  };
}

/** 最小可用的 SDK Query 假实现: 消息流永远挂起, 控制方法全部记录调用。 */
function createFakeQuery(initMcpServerNames: readonly string[] = []) {
  let initEmitted = false;
  return {
    [Symbol.asyncIterator]() {
      return {
        next: () => {
          if (!initEmitted && initMcpServerNames.length > 0) {
            initEmitted = true;
            return Promise.resolve({
              done: false as const,
              value: {
                type: 'system',
                subtype: 'init',
                session_id: 'sdk-plan-mode',
                mcp_servers: initMcpServerNames.map((name) => ({ name, status: 'connected' })),
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
    mcpServerStatus: vi.fn(async () =>
      initMcpServerNames.map((name) => ({ name, status: 'connected', scope: 'dynamic' }))),
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
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-claude-plan-'));
  tempDirs.push(dir);
  return dir;
}

async function startPlanSession(
  planMode: boolean,
  depOverrides: Partial<AgentDeps> = {},
  permissionMode: PermissionMode = 'acceptEdits',
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();

  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const agent = new ClaudeCodeAgent(createDeps(depOverrides));
  const handle = await agent.startSession({
    sessionId: 'session-plan',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode,
    planMode,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { permissionMode?: string; allowedTools?: string[]; canUseTool?: CanUseToolFn }
    | undefined;
  if (!queryOptions) throw new Error('expected sdk query options');
  return { agent, handle, fakeQuery, queryOptions };
}

async function nextEvent(iterator: AsyncIterator<AgentEvent>): Promise<AgentEvent> {
  const result = await Promise.race([
    iterator.next(),
    new Promise<IteratorResult<AgentEvent>>((_, reject) => {
      setTimeout(() => reject(new Error('timed out waiting for event')), 100);
    }),
  ]);
  if (result.done) throw new Error('event stream ended');
  return result.value;
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

describe('ClaudeCodeAgent plan mode', () => {
  it('starts the SDK query in plan mode while keeping the underlying permission mode', async () => {
    const { handle, queryOptions } = await startPlanSession(true);

    expect(queryOptions.permissionMode).toBe('plan');
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('starts with the plain permission mode when planMode is off', async () => {
    const { handle, queryOptions } = await startPlanSession(false);

    expect(queryOptions.permissionMode).toBe('acceptEdits');
    expect(queryOptions.allowedTools).toBeUndefined();
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('passes a session-stable copy of host-owned allowedTools to the local SDK query', async () => {
    const source = ['mcp__cindy__ghost_list', 'mcp__cindy_memory__list_tools'];
    const { handle, queryOptions } = await startPlanSession(false, {
      claudeAllowedTools: source,
    });
    source.push('Bash');

    expect(queryOptions.allowedTools).toEqual([
      'mcp__cindy__ghost_list',
      'mcp__cindy_memory__list_tools',
    ]);
    expect(queryOptions.allowedTools).not.toBe(source);
    await handle.close();
  });

  it('passes the same allowedTools snapshot to remote cc-manager start params', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const starts: Array<Record<string, unknown>> = [];
    const fakeQuery = createFakeQuery();
    const source = ['mcp__cindy__ghost_forge_guide', 'mcp__cindy_helper__list_tools'];

    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      starts.push(args.startParams);
      return fakeQuery as never;
    };
    const agent = new ClaudeCodeAgent(createDeps({
      claudeAllowedTools: source,
      remoteCcQueryFactory,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-allowed-tools',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });
    source.push('Bash');

    expect(starts).toHaveLength(1);
    expect(starts[0]?.allowedTools).toEqual([
      'mcp__cindy__ghost_forge_guide',
      'mcp__cindy_helper__list_tools',
    ]);
    expect(starts[0]?.allowedTools).not.toBe(source);
    expect(sdkMock.query).not.toHaveBeenCalled();
    await handle.close();
  });

  it('overrides remote cc-manager env with a host-materialized Claude route', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const starts: Array<Record<string, unknown>> = [];
    const fakeQuery = createFakeQuery();

    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      starts.push(args.startParams);
      return fakeQuery as never;
    };
    const resolveRemoteClaudeRoute = vi.fn(async () => ({
      endpoint: 'https://provider.example/v1',
      env: {
        ANTHROPIC_API_KEY: 'k-route',
        ANTHROPIC_CUSTOM_HEADERS: 'authorization: Bearer k-route\nx-tenant: acme',
      },
    }));
    const agent = new ClaudeCodeAgent(createDeps({
      // Empty gateway endpoint would fail the old remote gateway guard; routed sessions must not depend on it.
      runtimeConfig: { remoteEndpoint: '' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-materialized-route',
      model: 'custom-model',
      providerId: 'custom-provider',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    expect(resolveRemoteClaudeRoute).toHaveBeenCalledWith({
      providerId: 'custom-provider',
      model: 'custom-model',
    });
    expect(starts).toHaveLength(1);
    const env = starts[0]?.env as Record<string, string> | undefined;
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://provider.example/v1');
    expect(env?.ANTHROPIC_API_KEY).toBe('k-route');
    expect(env?.ANTHROPIC_CUSTOM_HEADERS).toBe('authorization: Bearer k-route\nx-tenant: acme');
    expect(env?.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    await handle.close();
  });

  it('keeps remote OAuth Auto when every local MCP is filtered before transport', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const starts: Array<Record<string, unknown>> = [];
    const fakeQuery = createFakeQuery();
    const oauthAuth: AuthAdapter = {
      async getState() {
        return { authenticated: true, authSource: 'oauth' };
      },
      async triggerLogin() {
        return { authenticated: true };
      },
      async logout() {},
      async getAuthEnv() {
        return {};
      },
    };

    const agent = new ClaudeCodeAgent(createDeps({
      auth: oauthAuth,
      mcpProviders: [{
        name: 'local_sdk_only',
        toClaudeSdkConfig: () => ({ type: 'sdk', name: 'local_sdk_only', instance: {} }) as never,
      }],
      resolveRemoteClaudeRoute: async () => ({
        endpoint: 'https://api.anthropic.com',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
      }),
      remoteCcQueryFactory: async (args) => {
        starts.push(args.startParams);
        return fakeQuery as never;
      },
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-oauth-no-mcp',
      model: 'claude-opus-4-6',
      providerId: 'anthropic',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    expect(starts).toHaveLength(1);
    expect(starts[0]?.mcpServers).toBeUndefined();
    expect(starts[0]?.permissionMode).toBe('auto');
    await handle.close();
  });

  it('tracks a factory-injected MCP downgrade as already default', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery(['cindy_orca']);
    fakeQuery.setPermissionMode.mockRejectedValue(new Error('remote control RPC failed'));
    const oauthAuth: AuthAdapter = {
      async getState() { return { authenticated: true, authSource: 'oauth' }; },
      async triggerLogin() { return { authenticated: true }; },
      async logout() {},
      async getAuthEnv() { return {}; },
    };
    let proposedMode: unknown;

    const agent = new ClaudeCodeAgent(createDeps({
      auth: oauthAuth,
      resolveRemoteClaudeRoute: async () => ({
        endpoint: 'https://api.anthropic.com',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'test-token' },
      }),
      remoteCcQueryFactory: async (args) => {
        proposedMode = args.startParams.permissionMode;
        args.startParams.permissionMode = 'default';
        args.startParams.mcpServers = {
          cindy_orca: { type: 'http', url: 'http://127.0.0.1/mcp/cindy_orca' },
        };
        return fakeQuery as never;
      },
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-factory-downgrade',
      model: 'claude-opus-4-6',
      providerId: 'anthropic',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    expect(proposedMode).toBe('auto');
    await vi.waitFor(() => expect(fakeQuery.mcpServerStatus).toHaveBeenCalled());
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    expect(fakeQuery.close).not.toHaveBeenCalled();
    await handle.close();
  });

  // 凭证形态回落不变量: 远端 route 为 null(网关路径)时必须按 gateway-key 构建 env,
  // 不能让 getAuthEnv 的本地 fallback(订阅 token)与网关 endpoint 并存 —— 否则订阅
  // token 会被发往网关(泄漏)。resolver 未注入(旧 host)同理。
  function createGatewayAwareAuth(): AuthAdapter {
    return {
      async getState() {
        return { authenticated: true };
      },
      async triggerLogin() {
        return { authenticated: true };
      },
      async logout() {},
      async getAuthEnv(options) {
        return options?.credentialMode === 'gateway-key'
          ? { ANTHROPIC_API_KEY: 'gw-key' }
          : { CLAUDE_CODE_OAUTH_TOKEN: 'tok-sub' }; // 本地 fallback: 订阅已连
      },
    };
  }

  async function startRemoteGatewaySession(depOverrides: Partial<AgentDeps>) {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const starts: Array<Record<string, unknown>> = [];
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      starts.push(args.startParams);
      return fakeQuery as never;
    };
    const agent = new ClaudeCodeAgent(createDeps({
      auth: createGatewayAwareAuth(),
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      ...depOverrides,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-gateway-fallback',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });
    return { starts, handle };
  }

  it('keeps the remote gateway credential shape when the resolved route is null', async () => {
    const resolveRemoteClaudeRoute = vi.fn(async () => null);
    const { starts, handle } = await startRemoteGatewaySession({ resolveRemoteClaudeRoute });

    expect(resolveRemoteClaudeRoute).toHaveBeenCalledOnce();
    expect(starts).toHaveLength(1);
    const env = starts[0]?.env as Record<string, string> | undefined;
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/claude');
    expect(env?.ANTHROPIC_API_KEY).toBe('gw-key');
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    await handle.close();
  });

  it('keeps the remote gateway credential shape when no route resolver is injected (old host)', async () => {
    const { starts, handle } = await startRemoteGatewaySession({});

    expect(starts).toHaveLength(1);
    const env = starts[0]?.env as Record<string, string> | undefined;
    expect(env?.ANTHROPIC_BASE_URL).toBe('https://gw.example/claude');
    expect(env?.ANTHROPIC_API_KEY).toBe('gw-key');
    expect(env?.CLAUDE_CODE_OAUTH_TOKEN).toBeUndefined();
    await handle.close();
  });

  // 远端订阅 token 续命:route env 带 CLAUDE_CODE_OAUTH_TOKEN 且 host 实现强刷时,
  // remoteCcQueryFactory 必须拿到 onOAuthRefresh;回调返回新 token 并把 remoteEnv
  // 原地写新(单一事实源,重连 fresh-start 直接用新 token 起跑)。网关路径绝不接线。
  it('wires onOAuthRefresh for native-OAuth remote routes and refreshes the env in place', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const factoryArgs: Array<{
      startParams: Record<string, unknown>;
      onOAuthRefresh?: (params: unknown) => Promise<unknown>;
    }> = [];
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      factoryArgs.push(args);
      return fakeQuery as never;
    };
    const getFreshSubscriptionToken = vi.fn(async () => 'tok-new');
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
      getFreshSubscriptionToken,
    };
    const agent = new ClaudeCodeAgent(createDeps({
      auth,
      runtimeConfig: { remoteEndpoint: '' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute: async () => ({
        endpoint: 'https://api.anthropic.com',
        env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok-old' },
      }),
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-oauth-refresh',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]?.onOAuthRefresh).toBeDefined();
    await expect(factoryArgs[0]!.onOAuthRefresh!({ sessionId: 'x' })).resolves.toEqual({
      token: 'tok-new',
    });
    expect(getFreshSubscriptionToken).toHaveBeenCalledWith('tok-old');
    const env = factoryArgs[0]?.startParams.env as Record<string, string>;
    expect(env.CLAUDE_CODE_OAUTH_TOKEN).toBe('tok-new');
    await handle.close();
  });

  it('does not wire onOAuthRefresh for gateway-path remote sessions', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const factoryArgs: Array<{ onOAuthRefresh?: (params: unknown) => Promise<unknown> }> = [];
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async (args) => {
      factoryArgs.push(args);
      return fakeQuery as never;
    };
    const auth = createGatewayAwareAuth();
    auth.getFreshSubscriptionToken = vi.fn(async () => 'tok-new');
    const agent = new ClaudeCodeAgent(createDeps({
      auth,
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute: async () => null,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-gateway-no-refresh',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    expect(factoryArgs).toHaveLength(1);
    expect(factoryArgs[0]?.onOAuthRefresh).toBeUndefined();
    await handle.close();
  });

  it('setPlanMode toggles the SDK between plan and the underlying mode', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    await handle.setPlanMode?.(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    expect(handle.getPlanMode?.()).toBe(true);

    await handle.setPlanMode?.(false);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('defers setPermissionMode pushes while plan mode is active', async () => {
    const { handle, fakeQuery } = await startPlanSession(true);

    await handle.setPermissionMode?.('auto');
    // 计划模式期间只记账底层档, 不 push SDK (SDK 停留在 plan)。
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    await handle.setPlanMode?.(false);
    // 退出计划模式落到最新的底层档。Cindy 档 'auto'(Auto-review)映射到 SDK 'default'
    // —— 不再透传 'auto' 给 CC(canUseTool 才会触发,由 Cindy 策略审查),见 toSdkPermissionMode。
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    await handle.close();
  });

  it('auto-exits plan mode after the user approves the plan (ExitPlanMode allow)', async () => {
    const { handle, fakeQuery, queryOptions } = await startPlanSession(true);
    const iterator = handle.events()[Symbol.asyncIterator]();
    const seen: InteractionRequest[] = [];
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      return { kind: 'plan_review', behavior: 'allow' };
    });

    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error('expected canUseTool');
    const result = await canUseTool('ExitPlanMode', { plan: '1. do X' }, { toolUseID: 'tool-1' });

    expect(result.behavior).toBe('allow');
    expect(seen[0]).toMatchObject({ kind: 'plan_review', plan: '1. do X' });
    expect(handle.getPlanMode?.()).toBe(false);
    // fire-and-forget 的 SDK 切档 — 等一个 tick。
    await vi.waitFor(() => {
      expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    });
    const ev = await nextEvent(iterator);
    expect(ev).toMatchObject({ type: 'plan_mode_changed', data: { enabled: false } });
    await handle.close();
  });

  it('reviews post-approval actions against the approved plan', async () => {
    const reviewAutoPermissionAction = vi.fn(async () => ({ verdict: 'allow' as const }));
    const { handle, queryOptions } = await startPlanSession(
      true,
      { reviewAutoPermissionAction },
      'auto',
    );
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      if (req.kind === 'plan_review') return { kind: 'plan_review', behavior: 'allow' };
      return { kind: 'permission', behavior: 'allow' };
    });
    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error('expected canUseTool');

    await handle.send({
      type: 'user',
      content: 'Refactor the parser without changing public behavior',
    });
    await canUseTool(
      'ExitPlanMode',
      { plan: '1. Inspect parser call sites\n2. Update parser\n3. Run focused tests' },
      { toolUseID: 'approve-plan' },
    );
    await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'focused-typecheck' },
    );

    expect(reviewAutoPermissionAction).toHaveBeenCalledWith(expect.objectContaining({
      userIntent:
        'Refactor the parser without changing public behavior\n\n'
        + 'Approved plan:\n1. Inspect parser call sites\n2. Update parser\n3. Run focused tests',
    }));
    await handle.close();
  });

  it('merges user plan edits and feedback into capability routing', async () => {
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
          explicitSelectors: ['$feishu-delegate:message-feishu-coworkers'],
          replacement: { kind: 'cindy-plugin', id: 'xd-feishu' },
        },
      ],
    } as const satisfies CapabilityRoutingPolicy;
    const cases: Array<{
      decision: InteractionDecision;
      expectedBehavior: 'allow' | 'deny';
    }> = [
      {
        decision: {
          kind: 'plan_review',
          behavior: 'allow',
          editedPlan:
            '1. 用 $feishu-delegate:message-feishu-coworkers 查询消息',
        },
        expectedBehavior: 'allow',
      },
      {
        decision: {
          kind: 'plan_review',
          behavior: 'deny',
          reason:
            '请改用 $feishu-delegate:message-feishu-coworkers 并补充范围',
        },
        expectedBehavior: 'allow',
      },
      {
        decision: {
          kind: 'plan_review',
          behavior: 'deny',
          reason: 'system dismissed $feishu-delegate:message-feishu-coworkers',
          dismissed: true,
        },
        expectedBehavior: 'deny',
      },
    ];

    for (const [index, testCase] of cases.entries()) {
      const { handle, queryOptions } = await startPlanSession(true, {
        capabilityRouting,
        getMcpToolApprovalPolicy: () => 'auto-approve',
      });
      handle.setInteractionResolver(async (req): Promise<InteractionDecision> =>
        req.kind === 'plan_review'
          ? testCase.decision
          : { kind: 'permission', behavior: 'allow' },
      );
      await handle.send({ type: 'user', content: '制定一个查询消息的计划' });
      const canUseTool = queryOptions.canUseTool;
      if (!canUseTool) throw new Error('expected canUseTool');
      await canUseTool(
        'ExitPlanMode',
        { plan: '1. 查询消息' },
        { toolUseID: `plan-${index}` },
      );
      await expect(
        canUseTool(
          'mcp__plugin_feishu-delegate_feishu-delegate__read_messages',
          {},
          { toolUseID: `mcp-${index}` },
        ),
      ).resolves.toMatchObject({ behavior: testCase.expectedBehavior });
      await handle.close();
    }
  });

  it('defers the SDK switch when armed mid-turn, and pushes plan at the next send boundary', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // turn 流式中(send 后 fake query 永不结束)从菜单勾计划模式 → 只记账,不动
    // in-flight turn 的 SDK 权限档。
    await handle.send({ type: 'user', content: 'first message' });
    await handle.setPlanMode?.(true);
    expect(handle.getPlanMode?.()).toBe(true);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();

    // 下一条消息消耗武装态 → 此刻补推 plan 档。
    await handle.send({ type: 'user', content: 'plan this' });
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('plan');
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledTimes(1);
    expect(handle.getPlanMode?.()).toBe(false);
    await handle.close();
  });

  it('honors the per-send plan intent snapshot over the current armed state', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // 排队行快照 true + 当前未武装 → SDK 补推 plan 档执行本 turn。
    await handle.send({ type: 'user', content: 'queued plan request' }, { planMode: true });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    await handle.close();
  });

  it('explicit normal send keeps the armed selection for a future message', async () => {
    const { handle, fakeQuery } = await startPlanSession(false);

    // idle 武装(SDK 已推 plan)后, 排队普通消息(快照 false)派发 → SDK 降回底层档
    // 执行本 turn, 武装态保留。
    await handle.setPlanMode?.(true);
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('plan');
    await handle.send({ type: 'user', content: 'queued normal message' }, { planMode: false });
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('acceptEdits');
    expect(handle.getPlanMode?.()).toBe(true);
    await handle.close();
  });

  it('one-shot: send consumes the armed selection, SDK stays in plan for the turn', async () => {
    const { handle, fakeQuery } = await startPlanSession(true);
    const iterator = handle.events()[Symbol.asyncIterator]();

    await handle.send({ type: 'user', content: 'make a plan' });

    // 勾选被消耗 + plan_mode_changed(false) 广播; SDK 不在此时切档
    // (本轮 plan turn 继续, 收尾在批准分支 / onTurnEnd)。
    expect(handle.getPlanMode?.()).toBe(false);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    let sawPlanModeChanged = false;
    for (let i = 0; i < 30 && !sawPlanModeChanged; i++) {
      const ev = await nextEvent(iterator);
      if (ev.type === 'plan_mode_changed') {
        expect(ev.data).toEqual({ enabled: false });
        sawPlanModeChanged = true;
      }
    }
    expect(sawPlanModeChanged).toBe(true);
    await handle.close();
  });

  it('stays in plan mode when the plan is rejected', async () => {
    const { handle, fakeQuery, queryOptions } = await startPlanSession(true);
    handle.setInteractionResolver(async (): Promise<InteractionDecision> => ({
      kind: 'plan_review',
      behavior: 'deny',
      reason: '换个方案',
    }));

    const canUseTool = queryOptions.canUseTool;
    if (!canUseTool) throw new Error('expected canUseTool');
    const result = await canUseTool('ExitPlanMode', { plan: '1. do X' }, { toolUseID: 'tool-1' });

    expect(result.behavior).toBe('deny');
    expect(handle.getPlanMode?.()).toBe(true);
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    await handle.close();
  });

  it('remote setModel rejects route-changing model switches', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
      fakeQuery as never;
    const resolveRemoteClaudeRoute = vi.fn(async (args: { model: string }) =>
      args.model.startsWith('claude-')
        ? { endpoint: 'https://api.anthropic.com', env: { CLAUDE_CODE_OAUTH_TOKEN: 'tok' } }
        : null,
    );
    const agent = new ClaudeCodeAgent(createDeps({
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-setmodel',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    // 同一路由(native OAuth)→ 放行,SDK setModel 被调。
    await handle.setModel?.('claude-sonnet-5');
    expect(fakeQuery.setModel).toHaveBeenCalled();

    // 路由变化(native OAuth → 网关 null)→ 拒绝,不更新模型。
    await expect(handle.setModel?.('deepseek/deepseek-v4-flash')).rejects.toThrow(
      /REMOTE_MODEL_SWITCH_ROUTE_CHANGE/,
    );
    expect(resolveRemoteClaudeRoute).toHaveBeenCalledTimes(3); // startSession + 两次 setModel
    await handle.close();
  });

  it('remote setModel allows same-route switch despite token rotation', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
      fakeQuery as never;
    // 后台刷新后 nextRoute.env 是新 token,但 remoteEnv(远端 daemon)还是旧值 ——
    // token 值轮换不算路由变化,同路由放行(codex P2 三轮)。
    let callCount = 0;
    const resolveRemoteClaudeRoute = vi.fn(async () => {
      callCount += 1;
      return {
        endpoint: 'https://api.anthropic.com',
        env: { CLAUDE_CODE_OAUTH_TOKEN: callCount === 1 ? 'tok-old' : 'tok-new' },
      };
    });
    const agent = new ClaudeCodeAgent(createDeps({
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-token-rotation',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    // token 值不同(轮换)但 endpoint + token 存在性一致 → 放行。
    await handle.setModel?.('claude-sonnet-5');
    expect(fakeQuery.setModel).toHaveBeenCalled();
    await handle.close();
  });

  it('remote setModel allows same-route switch despite subscription metadata drift', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
      fakeQuery as never;
    // 登录后 backfill 补齐 subscriptionType/rateLimitTier(用户零操作)—— 与 token 同组
    // 按存在性比对,不按值,不误拒(Fable 5 评估 B1)。
    let callCount = 0;
    const resolveRemoteClaudeRoute = vi.fn(async () => {
      callCount += 1;
      return {
        endpoint: 'https://api.anthropic.com',
        env:
          callCount === 1
            ? { CLAUDE_CODE_OAUTH_TOKEN: 'tok' }
            : {
                CLAUDE_CODE_OAUTH_TOKEN: 'tok',
                CLAUDE_CODE_SUBSCRIPTION_TYPE: 'max',
                CLAUDE_CODE_RATE_LIMIT_TIER: 'tier-1',
              },
      };
    });
    const agent = new ClaudeCodeAgent(createDeps({
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-metadata-drift',
      model: 'claude-opus-4-6',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    await handle.setModel?.('claude-sonnet-5');
    expect(fakeQuery.setModel).toHaveBeenCalled();
    await handle.close();
  });

  it('remote setModel rejects when a custom provider key changes (no refresh channel)', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
      fakeQuery as never;
    // 自定义供应商 ANTHROPIC_API_KEY 无 oauth/refresh 通道:用户在设置里改 key 后,
    // 远端 daemon 仍带旧 key,持续 401 —— 必须拒绝(Greptile 六轮)。
    let callCount = 0;
    const resolveRemoteClaudeRoute = vi.fn(async () => {
      callCount += 1;
      return {
        endpoint: 'https://provider.example/v1',
        env: { ANTHROPIC_API_KEY: callCount === 1 ? 'k-old' : 'k-new' },
      };
    });
    const agent = new ClaudeCodeAgent(createDeps({
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-key-change',
      model: 'custom-model',
      providerId: 'custom-provider',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    await expect(handle.setModel?.('another-custom-model')).rejects.toThrow(
      /REMOTE_MODEL_SWITCH_ROUTE_CHANGE/,
    );
    await handle.close();
  });

  it('remote setModel rejects when the target route drops a custom header', async () => {
    const configDir = await makeTempDir();
    process.env.CLAUDE_CONFIG_DIR = configDir;
    const workingDir = await makeTempDir();
    const fakeQuery = createFakeQuery();
    const remoteCcQueryFactory: NonNullable<AgentDeps['remoteCcQueryFactory']> = async () =>
      fakeQuery as never;
    // 初次解析带 x-tenant 定制头;切模时目标路由把它删了 —— 远端 daemon 仍烤着旧头,
    // 必须拒绝(Greptile review #1035:只取 nextRoute 的 key 会把删除误判成一致)。
    let callCount = 0;
    const resolveRemoteClaudeRoute = vi.fn(async () => {
      callCount += 1;
      return callCount === 1
        ? {
            endpoint: 'https://provider.example/v1',
            env: { ANTHROPIC_API_KEY: 'k', ANTHROPIC_CUSTOM_HEADERS: 'x-tenant: acme' },
          }
        : { endpoint: 'https://provider.example/v1', env: { ANTHROPIC_API_KEY: 'k' } };
    });
    const agent = new ClaudeCodeAgent(createDeps({
      runtimeConfig: { remoteEndpoint: 'https://gw.example/claude' },
      remoteCcQueryFactory,
      resolveRemoteClaudeRoute,
    }));
    const handle = await agent.startSession({
      sessionId: 'session-remote-drop-header',
      model: 'custom-model',
      providerId: 'custom-provider',
      workingDir,
      remoteHostId: 'remote-1',
      permissionMode: 'auto',
    });

    await expect(handle.setModel?.('another-custom-model')).rejects.toThrow(
      /REMOTE_MODEL_SWITCH_ROUTE_CHANGE/,
    );
    await handle.close();
  });
});
