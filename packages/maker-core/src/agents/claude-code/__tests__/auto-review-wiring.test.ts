/**
 * Auto-review 接线集成测试:官方 Claude OAuth 在没有 host MCP 时保留原生 Auto classifier；
 * 一旦有 host MCP 或使用第三方路由,映射到 SDK default，让 canUseTool 走 Cindy 当前模型轻量 fallback。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 灰区 → lightweight reviewer 的 allow/block 静默处理，只有 ask 才弹窗
 *   - auto + 确定危险命令 → 弹窗且 suggestion 被剥(不可持久化授权)
 *   - 送审阅器的 model 恒为目录 id(不是 [1m] wire 串),切模后仍然如此
 *   - 审阅器不可用(而非模型判定危险)时,会话里出现一条一次性提示
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  AgentDeps,
  AgentSessionHandle,
  McpToolApprovalContext,
  McpToolApprovalPolicy,
} from '../../base-agent.js';
import {
  AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE,
  AUTO_REVIEW_UNAVAILABLE_CODE,
  type AutoReviewRequest,
} from '../../shared/auto-review-decision.js';
import type { PermissionMode } from '../../../types/common.js';
import type { AuthAdapter } from '../../../interfaces/auth-adapter.js';
import type { InteractionDecision, InteractionRequest } from '../../../types/events.js';
import type { Logger } from '../../../interfaces/logger.js';

const sdkMock = vi.hoisted(() => ({ forkSession: vi.fn(), query: vi.fn() }));
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  forkSession: sdkMock.forkSession,
  query: sdkMock.query,
}));

import { ClaudeCodeAgent } from '../index.js';

const tempDirs: string[] = [];
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;

function noopLogger(): Logger {
  const l: Logger = {
    trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {},
    child() { return l; },
  };
  return l;
}

function createDeps(options: {
  authSource?: 'oauth' | 'api-key';
  reviewAutoPermissionAction?: AgentDeps['reviewAutoPermissionAction'];
  mcpProviderNames?: readonly string[];
  getMcpToolApprovalPolicy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy;
} = {}): AgentDeps {
  const auth: AuthAdapter = {
    async getState() { return { authenticated: true, authSource: options.authSource }; },
    async triggerLogin() { return { authenticated: true }; },
    async logout() {},
    async getAuthEnv() { return {}; },
  };
  return {
    auth,
    runtimeConfig: {},
    binaryPath: process.execPath,
    logger: noopLogger(),
    mcpProviders: (options.mcpProviderNames ?? []).map((name) => ({
      name,
      toClaudeSdkConfig: () => ({ type: 'stdio', command: 'true' }),
    })),
    reviewAutoPermissionAction: options.reviewAutoPermissionAction,
    getMcpToolApprovalPolicy: options.getMcpToolApprovalPolicy,
  };
}

function createFakeQuery(
  initMcpServerNames: readonly string[] = [],
  blockMcpServerStatus = false,
  rejectPermissionModeChange = false,
) {
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
                session_id: 'sdk-auto-review',
                mcp_servers: initMcpServerNames.map((name) => ({ name, status: 'connected' })),
              },
            });
          }
          return new Promise<IteratorResult<unknown>>(() => {});
        },
      };
    },
    setPermissionMode: vi.fn(async () => {
      if (rejectPermissionModeChange) throw new Error('permission transport failed');
    }),
    setModel: vi.fn(async () => {}),
    applyFlagSettings: vi.fn(async () => {}),
    interrupt: vi.fn(async () => {}),
    close: vi.fn(async () => {}),
    rewindFiles: vi.fn(async () => ({ canRewind: false })),
    ...(blockMcpServerStatus
      ? { mcpServerStatus: vi.fn(() => new Promise<never>(() => {})) }
      : {}),
  };
}

type CanUseToolFn = (
  toolName: string,
  input: Record<string, unknown>,
  options: { toolUseID: string; suggestions?: unknown[] },
) => Promise<{ behavior: 'allow' | 'deny'; message?: string }>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-auto-review-'));
  tempDirs.push(dir);
  return dir;
}

async function startSession(
  permissionMode: PermissionMode,
  options: {
    providerId?: string;
    authSource?: 'oauth' | 'api-key';
    reviewVerdict?: 'allow' | 'block' | 'ask';
    reviewer?: AgentDeps['reviewAutoPermissionAction'];
    attachResolver?: boolean;
    model?: string;
    mcpProviderNames?: readonly string[];
    initMcpServerNames?: readonly string[];
    blockMcpServerStatus?: boolean;
    rejectPermissionModeChange?: boolean;
    mcpToolApprovalPolicy?: (context: McpToolApprovalContext) => McpToolApprovalPolicy;
  } = {},
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  const fakeQuery = createFakeQuery(
    options.initMcpServerNames,
    options.blockMcpServerStatus,
    options.rejectPermissionModeChange,
  );
  sdkMock.query.mockReturnValue(fakeQuery);

  const reviewAutoPermissionAction = options.reviewer ?? vi.fn(async () => ({
    verdict: options.reviewVerdict ?? 'allow',
    reason: 'reviewed',
  }));
  const agent = new ClaudeCodeAgent(createDeps({
    authSource: options.authSource,
    reviewAutoPermissionAction,
    mcpProviderNames: options.mcpProviderNames,
    getMcpToolApprovalPolicy: options.mcpToolApprovalPolicy,
  }));
  const handle = await agent.startSession({
    sessionId: 'session-auto-review',
    model: options.model ?? 'claude-opus-4-6',
    providerId: options.providerId ?? 'xd',
    workingDir,
    permissionMode,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn; permissionMode?: string; model?: string }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');

  const seen: InteractionRequest[] = [];
  if (options.attachResolver !== false) {
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      return { kind: 'permission', behavior: 'allow' };
    });
  }

  return {
    agent,
    handle,
    canUseTool: queryOptions.canUseTool,
    fakeQuery,
    queryPermissionMode: queryOptions.permissionMode,
    querySdkModel: queryOptions.model,
    reviewAutoPermissionAction,
    seen,
    workingDir,
  };
}

/** 取 reviewer 第 n 次调用收到的 AutoReviewRequest。 */
function reviewedRequest(
  reviewer: NonNullable<AgentDeps['reviewAutoPermissionAction']>,
  callIndex = 0,
): AutoReviewRequest {
  const request = vi.mocked(reviewer).mock.calls[callIndex]?.[0];
  if (!request) throw new Error(`expected reviewer call #${callIndex}`);
  return request;
}

function permissionRequests(seen: InteractionRequest[]) {
  return seen.flatMap((req) => (req.kind === 'permission' ? [req] : []));
}

/** SDK 在需要审批时会带上会话级 suggestion(可"总是允许");这里模拟它。 */
const SESSION_SUGGESTION = [{ type: 'addRules', destination: 'session', behavior: 'allow' }];

afterEach(async () => {
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('Auto-review wiring: native first, Cindy fallback', () => {
  it('keeps SDK auto for official Claude OAuth without host MCPs', async () => {
    const { handle, queryPermissionMode, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    expect(queryPermissionMode).toBe('auto');
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    await handle.close();
  });

  it('downgrades native OAuth Auto after SDK init reveals a settings MCP', async () => {
    const { handle, fakeQuery, queryPermissionMode } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      initMcpServerNames: ['settings_prompt_mcp'],
      blockMcpServerStatus: true,
    });

    // Settings MCPs are not host-injected, so startup legitimately begins native Auto.
    expect(queryPermissionMode).toBe('auto');
    await vi.waitFor(() => expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default'));
    await handle.close();
  });

  it('closes instead of leaving settings MCPs in native Auto when downgrade fails', async () => {
    const { handle, fakeQuery } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      initMcpServerNames: ['settings_prompt_mcp'],
      rejectPermissionModeChange: true,
    });

    await vi.waitFor(() => expect(fakeQuery.close).toHaveBeenCalledTimes(1));
    await handle.close();
  });

  it('does not close an already-default host-MCP session when SDK init reports settings MCPs', async () => {
    const { handle, fakeQuery, queryPermissionMode } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      mcpProviderNames: ['cindy_orca'],
      initMcpServerNames: ['cindy_orca', 'settings_prompt_mcp'],
      blockMcpServerStatus: true,
      rejectPermissionModeChange: true,
    });

    expect(queryPermissionMode).toBe('default');
    await vi.waitFor(() => expect(fakeQuery.mcpServerStatus).toHaveBeenCalled());
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    expect(fakeQuery.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('uses SDK default for official Claude OAuth when a host MCP is registered', async () => {
    const { handle, canUseTool, queryPermissionMode, seen } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      mcpProviderNames: ['cindy_orca'],
      mcpToolApprovalPolicy: () => 'auto-approve',
    });
    expect(queryPermissionMode).toBe('default');

    const result = await canUseTool(
      'mcp__cindy_orca__create_workers',
      { workers: [] },
      { toolUseID: 'oauth-orca-mcp' },
    );
    expect(result.behavior).toBe('allow');
    expect(seen).toHaveLength(0);
    await handle.close();
  });

  it('shows a real permission interaction for prompt MCPs in official Claude OAuth Auto', async () => {
    const { handle, canUseTool, queryPermissionMode, seen } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      mcpProviderNames: ['custom_prompt_mcp'],
      mcpToolApprovalPolicy: () => 'prompt',
    });
    expect(queryPermissionMode).toBe('default');

    const result = await canUseTool(
      'mcp__custom_prompt_mcp__write_record',
      { value: 'approved by the interaction resolver' },
      { toolUseID: 'oauth-prompt-mcp' },
    );

    expect(result.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(1);
    expect(permissionRequests(seen)[0]).toMatchObject({
      kind: 'permission',
      toolName: 'mcp__custom_prompt_mcp__write_record',
    });
    await handle.close();
  });

  it('uses SDK default for a third-party route so Cindy can review callbacks', async () => {
    const { handle, queryPermissionMode } = await startSession('auto', { providerId: 'xd' });
    expect(queryPermissionMode).toBe('default');
    await handle.close();
  });

  it('can silently allow a gray action without an interaction resolver', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      providerId: 'xd',
      reviewVerdict: 'allow',
      attachResolver: false,
    });
    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'typecheck-without-ui' },
    );
    expect(result.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(seen).toHaveLength(0);
    await handle.close();
  });

  it('keeps the product mode on Auto and switches only the runtime reviewer after native failure', async () => {
    const {
      handle,
      canUseTool,
      fakeQuery,
      reviewAutoPermissionAction,
      seen,
    } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      reviewVerdict: 'allow',
    });

    await handle.useCindyAutoReviewFallback?.();
    expect(fakeQuery.setPermissionMode).toHaveBeenCalledWith('default');
    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'fallback-typecheck' },
    );
    expect(result.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });
});

describe('Auto-review wiring: safe builtin tools auto-approve silently', () => {
  it('read-only tool → allow without hitting the resolver', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    const r = await canUseTool('Read', { file_path: '/anywhere/x' }, { toolUseID: 't1' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('read-only shell (ls) → allow without resolver', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    const r = await canUseTool('Bash', { command: 'ls -la && git status' }, { toolUseID: 't2' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('in-workspace file write → allow without resolver', async () => {
    const { handle, canUseTool, seen, workingDir } = await startSession('auto');
    const r = await canUseTool('Write', { file_path: path.join(workingDir, 'a.ts') }, { toolUseID: 't3' });
    expect(r.behavior).toBe('allow');
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });
});

describe('Auto-review wiring: lightweight reviewer controls gray actions', () => {
  it('re-checks the latest permission mode after an in-flight review', async () => {
    let resolveReview: ((value: { verdict: 'allow'; reason: string }) => void) | undefined;
    const reviewer = vi.fn(() => new Promise<{ verdict: 'allow'; reason: string }>((resolve) => {
      resolveReview = resolve;
    }));
    const { handle, canUseTool, seen } = await startSession('auto', { reviewer });

    const pending = canUseTool('Write', { file_path: '/tmp/late-mode.conf' }, { toolUseID: 'late-ask' });
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.setPermissionMode!('ask');
    resolveReview!({ verdict: 'allow', reason: 'reviewed' });
    await expect(pending).resolves.toMatchObject({ behavior: 'allow' });
    // allow 来自用户确认而非旧 reviewer verdict，且 session grant 已被剥离。
    expect(permissionRequests(seen)).toHaveLength(1);
    expect(permissionRequests(seen)[0]?.suggestions).toBeUndefined();

    let resolveFull: ((value: { verdict: 'allow'; reason: string }) => void) | undefined;
    const fullReviewer = vi.fn(() => new Promise<{ verdict: 'allow'; reason: string }>((resolve) => {
      resolveFull = resolve;
    }));
    // 新建一个 auto 会话，避免上一段 Ask 的本地状态影响断言。
    await handle.close();
    const next = await startSession('auto', { reviewer: fullReviewer });
    const fullPending = next.canUseTool('Write', { file_path: '/tmp/late-full.conf' }, { toolUseID: 'late-full' });
    await vi.waitFor(() => expect(fullReviewer).toHaveBeenCalledOnce());
    await next.handle.setPermissionMode!('bypassPermissions');
    resolveFull!({ verdict: 'allow', reason: 'reviewed' });
    await expect(fullPending).resolves.toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(next.seen)).toHaveLength(0);
    await next.handle.close();
  });

  it('reviewer allow → proceeds silently without hitting the resolver', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      reviewVerdict: 'allow',
    });
    const r = await canUseTool(
      'Write',
      { file_path: '/tmp/gray-write.conf' },
      { toolUseID: 't4', suggestions: SESSION_SUGGESTION },
    );
    expect(r.behavior).toBe('allow');
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviewer block → denies silently and tells the agent to choose a safer action', async () => {
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewVerdict: 'block',
    });
    const result = await canUseTool('Bash', { command: 'npm install left-pad' }, { toolUseID: 't5' });
    expect(result).toMatchObject({ behavior: 'deny', message: 'reviewed' });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviewer ask → prompts once with session suggestions stripped', async () => {
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewVerdict: 'ask',
    });
    await canUseTool(
      'Bash',
      { command: 'npm install left-pad' },
      { toolUseID: 't5-ask', suggestions: SESSION_SUGGESTION },
    );
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.suggestions).toBeUndefined();
    await handle.close();
  });

  it('deterministic privilege boundary → prompts without calling the reviewer', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto');
    await canUseTool('Bash', { command: 'sudo rm -rf build' }, { toolUseID: 't6', suggestions: SESSION_SUGGESTION });
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    expect(reqs[0]?.suggestions).toBeUndefined();
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    await handle.close();
  });
});

/**
 * 送审阅器的是**用户选中的目录模型 id**,不是送 SDK 的 wire 串。
 *
 * host 侧 reviewer 按 (providerId, model) 精确查目录条目定路由,查不到就 fail closed
 * (oneShotCandidates 的 no_candidate)—— 灰区动作会退化成没有 UI 提示的永久 block。
 * Claude 的 wire 串带 [1m] beta 通道后缀(toSdkModelString),而目录条目不带,所以这两个
 * 值必须始终分离:`mutableModel` 只跟随用户选择,wire 串在送 SDK 前单独派生、不回写。
 *
 * Codex 侧的同一约束靠 mutableCatalogModel 兜(它的 app-server 会把规范化后的 wire id
 * **回带**覆盖运行期 model);Claude 没有那条回带路径,不变量由下面两个用例守住 —— 任何
 * 把 wire 串写回 mutableModel 的改动都会让它们变红。见 issue #1575。
 */
describe('Auto-review wiring: the reviewer routes through the catalog model id', () => {
  it('reviews through the catalog id while the SDK receives the [1m] wire id', async () => {
    const { handle, canUseTool, querySdkModel, reviewAutoPermissionAction } = await startSession('auto', {
      model: 'claude-opus-4-6',
      reviewVerdict: 'allow',
    });
    expect(querySdkModel).toBe('claude-opus-4-6[1m]');

    const r = await canUseTool(
      'Write',
      { file_path: '/tmp/catalog-model.conf' },
      { toolUseID: 'catalog-model' },
    );
    expect(r.behavior).toBe('allow');
    expect(reviewedRequest(reviewAutoPermissionAction).model).toBe('claude-opus-4-6');
    await handle.close();
  });

  it('keeps reviewing through the catalog id after setModel switches the route', async () => {
    const { handle, canUseTool, fakeQuery, reviewAutoPermissionAction } = await startSession('auto', {
      model: 'claude-opus-4-6',
      reviewVerdict: 'allow',
    });

    await handle.setModel?.('claude-sonnet-5');
    expect(fakeQuery.setModel).toHaveBeenCalledWith('claude-sonnet-5[1m]');

    await canUseTool(
      'Write',
      { file_path: '/tmp/catalog-model-switched.conf' },
      { toolUseID: 'catalog-model-switched' },
    );
    expect(reviewedRequest(reviewAutoPermissionAction).model).toBe('claude-sonnet-5');
    await handle.close();
  });
});

/**
 * 「审阅器不可用」要在会话里说一次(issue #1574)。
 *
 * 以前 delegate 缺失 / 超时 / 抛错和「模型判定动作危险」在上层都是同一个 `block`,
 * UI 层零呈现 —— 用户看到的是「工具一直被拒、没有弹窗、重启无效」,却拿不到任何原因。
 * 现在前者额外发一条会话级**一次性**提示(走既有的非终止 error 事件 + `[CODE]` 约定),
 * 动作本身仍然 deny,安全边界不变。
 */
describe('Auto-review wiring: reviewer outages surface once per session', () => {
  /**
   * 单一后台消费者收集会话级提示(非终止 error)。
   *
   * 事件流是**单消费者** AsyncQueue:如果改用「每次断言时新建 iterator + 超时丢弃」的
   * 写法,被超时丢弃的那个 pending `next()` 仍挂在 waiters 里,下一条 push 会被它吃掉,
   * 断言就会莫名少一条。所以整个用例只订阅一次。
   */
  function startNoticeCollector(
    handle: Pick<AgentSessionHandle, 'events'>,
  ) {
    const notices: string[] = [];
    // 刻意不返回这个 promise:fakeQuery 的消息流永远挂起,forward loop 不退出,close()
    // 之后事件流也不会 end —— await 它就是等到测试超时。收集器随测试进程一起结束。
    void (async () => {
      for await (const event of handle.events()) {
        if (
          event.type === 'error'
          && typeof event.data === 'object'
          && event.data !== null
          && 'message' in event.data
          && typeof event.data.message === 'string'
        ) {
          notices.push(event.data.message);
        }
      }
    })().catch(() => {
      /* 队列在 teardown 时被丢弃,不是测试失败 */
    });
    return { notices };
  }

  /** 让 push 进队列的事件 fan-out 到收集器。 */
  const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

  it('emits one notice for a broken reviewer, not one per blocked action', async () => {
    // reviewer 抛错 = resolveAutoReviewDecision 走 unavailable 兜底 block。
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    const first = await canUseTool('Write', { file_path: '/tmp/a.conf' }, { toolUseID: 'n1' });
    const second = await canUseTool('Write', { file_path: '/tmp/b.conf' }, { toolUseID: 'n2' });
    expect(first.behavior).toBe('deny');
    expect(second.behavior).toBe('deny');
    await settle();

    // 两次都被拒,但每种提示只说一次 —— 逐条提示会把 Auto 退化成比 Ask 更烦的东西。
    // 没有 resolver 时确认卡也送不出去,所以还会有一条未送达纠正,同样去重。
    expect(notices.filter((message) => message.includes('[AUTO_REVIEW_UNAVAILABLE]'))).toHaveLength(1);
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toHaveLength(1);
    expect(notices).toHaveLength(2);
    await handle.close();
  });

  it('stays silent when the model itself blocks the action', async () => {
    const { handle, canUseTool } = await startSession('auto', { reviewVerdict: 'block' });
    const { notices } = startNoticeCollector(handle);

    const result = await canUseTool('Bash', { command: 'npm install left-pad' }, { toolUseID: 'n3' });
    expect(result).toMatchObject({ behavior: 'deny', message: 'reviewed' });
    await settle();

    // 模型判定的 block 按 Auto 本意保持静默 —— 只把 reason 喂给模型,不打扰用户。
    expect(notices).toHaveLength(0);
    await handle.close();
  });

  it.each([
    'timeout',
    'hook_interaction_timeout',
    'no_resolver_attached',
    'resolver_threw',
    'card send failed: slack timeout',
  ] as const)('does not treat a missing confirmation as a user rejection after auto-review fails (%s)', async (reason) => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    handle.setInteractionResolver(async () => ({
      kind: 'permission',
      behavior: 'deny',
      reason,
    }));
    const { notices } = startNoticeCollector(handle);

    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: `undelivered-${reason}` },
    );
    expect(result.behavior).toBe('deny');
    await settle();

    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(true);
    expect(notices.some((message) => message.includes('not a user rejection'))).toBe(true);
    await handle.close();
  });

  it('keeps a real user deny distinct from a missing confirmation', async () => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    handle.setInteractionResolver(async () => ({
      kind: 'permission',
      behavior: 'deny',
      reason: 'User denied',
    }));
    const { notices } = startNoticeCollector(handle);

    const result = await canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: 'user-deny' },
    );
    expect(result.behavior).toBe('deny');
    await settle();

    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(false);
    await handle.close();
  });

  it.each([
    'close',
    'setPermissionMode',
  ] as const)('does not treat a system-dismissed confirmation as a user rejection after auto-review fails (%s)', async (action) => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    let resolverCalled = false;
    handle.setInteractionResolver(() => {
      resolverCalled = true;
      return new Promise<InteractionDecision>(() => {});
    });
    const { notices } = startNoticeCollector(handle);

    const pending = canUseTool(
      'Bash',
      { command: 'npx tsc --noEmit' },
      { toolUseID: `dismissed-${action}` },
    );
    await vi.waitFor(() => expect(resolverCalled).toBe(true));

    if (action === 'close') {
      await handle.close();
    } else {
      await handle.setPermissionMode?.('ask');
    }
    await expect(pending).resolves.toMatchObject({ behavior: 'deny' });
    await settle();

    expect(notices.some((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toBe(true);
    expect(notices.some((message) => message.includes('not a user rejection'))).toBe(true);
    if (action !== 'close') await handle.close();
  });

  /**
   * 裁决缓存的 key 不含 permissionMode。用户切离 Auto、等审阅器恢复、再切回 Auto 时,
   * 同一个动作会命中先前那条 `unavailable` block —— 审阅器早就好了,动作还是被拒
   * (greptile P1 of #1574)。切档必须连缓存一起清。
   */
  it('drops cached unavailable verdicts when the permission mode changes', async () => {
    let reviewerBroken = true;
    const reviewer = vi.fn(async () => {
      if (reviewerBroken) throw new Error('reviewer offline');
      return { verdict: 'allow' as const };
    });
    const { handle, canUseTool } = await startSession('auto', {
      reviewer,
      attachResolver: false,
    });

    const sameAction = { file_path: '/tmp/cached.conf' };
    const denied = await canUseTool('Write', sameAction, { toolUseID: 'cache-1' });
    expect(denied.behavior).toBe('deny');

    // 用户接管 → 审阅器恢复 → 切回 Auto。
    await handle.setPermissionMode?.('ask');
    reviewerBroken = false;
    await handle.setPermissionMode?.('auto');

    const allowed = await canUseTool('Write', sameAction, { toolUseID: 'cache-2' });
    expect(allowed.behavior).toBe('allow');
    // 缓存真的清了才会有第二次 reviewer 调用。
    expect(reviewer).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  /**
   * ErrorBanner 那份提示只活到下一条非 error 事件(renderer 的 handleStreamEvent 会清
   * recoverableError),所以「整个会话只说一次」会让用户在后续轮次里完全看不到。每轮
   * 至多一条:不刷屏,又保证每一轮遇到时都有机会看见。
   */
  it('re-arms the notice on each new user turn', async () => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    await canUseTool('Write', { file_path: '/tmp/t1.conf' }, { toolUseID: 'turn1-a' });
    await canUseTool('Write', { file_path: '/tmp/t2.conf' }, { toolUseID: 'turn1-b' });
    await settle();
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`))).toHaveLength(1);
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toHaveLength(1);

    await handle.send({ type: 'user', content: 'Try something else then.' });
    await canUseTool('Write', { file_path: '/tmp/t3.conf' }, { toolUseID: 'turn2-a' });
    await settle();
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`))).toHaveLength(2);
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toHaveLength(2);
    await handle.close();
  });

  it('re-arms the notice after the user changes the permission mode', async () => {
    const { handle, canUseTool } = await startSession('auto', {
      reviewer: async () => {
        throw new Error('reviewer offline');
      },
      attachResolver: false,
    });
    const { notices } = startNoticeCollector(handle);

    await canUseTool('Write', { file_path: '/tmp/c.conf' }, { toolUseID: 'n4' });
    await settle();
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`))).toHaveLength(1);
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toHaveLength(1);

    // 用户自己动过档位之后又回到 Auto、又不可用 → 有权再看到一次。
    await handle.setPermissionMode?.('ask');
    await handle.setPermissionMode?.('auto');
    await canUseTool('Write', { file_path: '/tmp/d.conf' }, { toolUseID: 'n5' });
    await settle();
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_UNAVAILABLE_CODE}]`))).toHaveLength(2);
    expect(notices.filter((message) => message.includes(`[${AUTO_REVIEW_CONFIRM_UNDELIVERED_CODE}]`))).toHaveLength(2);
    await handle.close();
  });
});

describe('Auto-review wiring: only affects the auto mode', () => {
  it('default mode does not apply the auto-review policy (safe shell still prompts)', async () => {
    const { handle, canUseTool, seen } = await startSession('default');
    await canUseTool('Bash', { command: 'ls -la' }, { toolUseID: 't7' });
    // default 档下内置工具不走 auto-review 策略,照旧交 resolver。
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});
