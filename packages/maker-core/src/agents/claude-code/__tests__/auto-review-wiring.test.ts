/**
 * Auto-review 接线集成测试:官方 Claude OAuth 保留原生 Auto classifier；第三方路由
 * 映射到 SDK default，让 canUseTool 走 Cindy 当前模型轻量 fallback。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 灰区 → lightweight reviewer 的 allow/block 静默处理，只有 ask 才弹窗
 *   - auto + 确定危险命令 → 弹窗且 suggestion 被剥(不可持久化授权)
 *   - 送审阅器的 model 恒为目录 id(不是 [1m] wire 串),切模后仍然如此
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
import type { AutoReviewRequest } from '../../shared/auto-review-decision.js';
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
    mcpProviders: [],
    reviewAutoPermissionAction: options.reviewAutoPermissionAction,
  };
}

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
  } = {},
) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const reviewAutoPermissionAction = options.reviewer ?? vi.fn(async () => ({
    verdict: options.reviewVerdict ?? 'allow',
    reason: 'reviewed',
  }));
  const agent = new ClaudeCodeAgent(createDeps({
    authSource: options.authSource,
    reviewAutoPermissionAction,
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
  it('keeps SDK auto for official Claude OAuth', async () => {
    const { handle, queryPermissionMode, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
    });
    expect(queryPermissionMode).toBe('auto');
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
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

describe('Auto-review wiring: only affects the auto mode', () => {
  it('default mode does not apply the auto-review policy (safe shell still prompts)', async () => {
    const { handle, canUseTool, seen } = await startSession('default');
    await canUseTool('Bash', { command: 'ls -la' }, { toolUseID: 't7' });
    // default 档下内置工具不走 auto-review 策略,照旧交 resolver。
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });
});
