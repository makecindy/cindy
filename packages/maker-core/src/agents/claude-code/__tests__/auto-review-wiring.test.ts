import { AUTO_REVIEW_DELEGATED_CONTINUATION, AUTO_REVIEW_USER_INTENT, type DeviceHostedSession } from '../../base-agent.js';
/**
 * Auto-review 接线集成测试:官方 Claude OAuth 在没有 host MCP 时保留原生 Auto classifier；
 * 一旦有 host MCP 或使用第三方路由,映射到 SDK default，让 canUseTool 走 Cindy 当前模型轻量 fallback。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 灰区 → lightweight reviewer 的 allow/block 静默处理，只有 ask 才弹窗
 *   - auto + 高风险命令 → 送审阅器，只有 ask 才逐次确认
 *   - 送审阅器的 model 恒为目录 id(不是 [1m] wire 串),切模后仍然如此
 *   - 审阅器不可用(而非模型判定危险)时,会话里出现一条一次性提示
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';
import { AUTO_REVIEW_SOURCE_CONTENT, MAIN_OWNED_SEND_CONTEXT } from '../../base-agent.js';

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
  type PersonalTurnObservation,
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
import { normalizeRuleGroup } from '../../shared/approval-rules/normalize.js';
import { parseApprovalRuleSnapshot } from '../../shared/approval-rules/schema.js';
import { requirementsOrigin } from '../../shared/approval-rules/requirements.js';

it.each(['ask', 'auto', 'bypassPermissions'] as const)(
  'enforces a text-only turn at PreToolUse in %s and clears it on the next send',
  async (mode) => {
    const { handle } = await startSession(mode);
    try {
      await handle.send({ type: 'user', content: 'Give a short greeting.' }, { toolsDisabled: true });
      const hooks = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse
        .flatMap((group: { hooks: Array<(...args: unknown[]) => Promise<unknown>> }) => group.hooks);
      for (const toolName of ['Read', 'Bash', 'Write', 'AskUserQuestion', 'mcp__cindy_memory__memory_read']) {
        const input = { hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: {} };
        const results = await Promise.all(hooks.map((hook: (...args: unknown[]) => Promise<unknown>) => hook(input, 'tool-id', { signal: new AbortController().signal })));
        expect(results).toContainEqual(expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) }));
      }
      await expect(handle.send({ type: 'user', content: 'Too-early next request.' })).rejects.toThrow('tool policy');
      await handle.abort();
      await handle.send({ type: 'user', content: 'Normal user request.' });
      const results = await Promise.all(hooks.map((hook: (...args: unknown[]) => Promise<unknown>) => hook(
        { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: {} }, 'tool-id', { signal: new AbortController().signal },
      )));
      expect(results).not.toContainEqual(expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) }));
    } finally { await handle.close(); }
  },
);

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
) => Promise<{
  behavior: 'allow' | 'deny';
  message?: string;
  updatedInput?: Record<string, unknown>;
}>;

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'maker-core-auto-review-'));
  tempDirs.push(dir);
  return dir;
}

// Existing observation fixtures keep their scenarios/expectations; only this
// test transport adapter supplies the new structured Host result contract.
type TestObserve = (request: Parameters<NonNullable<AgentDeps['onClaudeLiveUserRules']>>[0]) =>
  Promise<void | PersonalTurnObservation>;

async function startSession(
  permissionMode: PermissionMode,
  options: {
    observe?: TestObserve;
    observeResult?: AgentDeps['onClaudeLiveUserRules'];
    providerId?: string;
    deviceHosted?: DeviceHostedSession;
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
    extraDirs?: string[];
    writableDirs?: string[];
    interactionResolver?: (request: InteractionRequest) => Promise<InteractionDecision>;
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
  const agent = new ClaudeCodeAgent({ ...createDeps({
    authSource: options.authSource,
    reviewAutoPermissionAction,
    mcpProviderNames: options.mcpProviderNames,
    getMcpToolApprovalPolicy: options.mcpToolApprovalPolicy,
  }), onClaudeLiveUserRules: options.observeResult ?? (options.observe ? async request => {
    const observation = await options.observe!(request);
    return { kind: 'unavailable', reason: 'fixture-native-content-unavailable', ...(observation ? { observation } : {}) };
  } : undefined) });
  const handle = await agent.startSession({
    sessionId: 'session-auto-review',
    sessionInstanceId: 'personal-instance',
    model: options.model ?? 'claude-opus-4-6',
    providerId: options.providerId ?? 'xd',
    workingDir,
    permissionMode,
    deviceHosted: options.deviceHosted,
    extraDirs: options.extraDirs,
    writableDirs: options.writableDirs,
  });
  const queryOptions = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
    | { canUseTool?: CanUseToolFn; permissionMode?: string; model?: string }
    | undefined;
  if (!queryOptions?.canUseTool) throw new Error('expected sdk query canUseTool');

  const seen: InteractionRequest[] = [];
  if (options.attachResolver !== false) {
    handle.setInteractionResolver(async (req): Promise<InteractionDecision> => {
      seen.push(req);
      if (options.interactionResolver) return options.interactionResolver(req);
      return { kind: 'permission', behavior: 'allow' };
    });
  }

  const preToolUse = async (toolName: string, toolInput: unknown) => {
    const opts = sdkMock.query.mock.calls.at(-1)?.[0]?.options as
      { hooks?: { PreToolUse?: Array<{ matcher?: string; hooks: Array<(input: unknown, id: string, ctx: unknown) => Promise<unknown>> }> } };
    const decisions: unknown[] = [];
    for (const matcher of opts.hooks?.PreToolUse ?? []) {
      if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test(toolName)) continue;
      for (const hook of matcher.hooks) {
        decisions.push(await hook({ hook_event_name: 'PreToolUse', tool_name: toolName, tool_input: toolInput, session_id: 's', transcript_path: '', cwd: workingDir }, 'tu', { signal: new AbortController().signal }));
      }
    }
    return decisions
      .map((d) => (d as { hookSpecificOutput?: { permissionDecision?: string } })?.hookSpecificOutput?.permissionDecision)
      .filter(Boolean);
  };

  return {
    agent,
    handle,
    preToolUse,
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
  vi.restoreAllMocks();
  sdkMock.forkSession.mockReset();
  sdkMock.query.mockReset();
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })));
});

describe('Auto-review wiring: native first, Cindy fallback', () => {
  // 2026-10-24: Claude subscription users keep Claude's own Auto review even though Cindy
  // always attaches host MCPs; Cindy's hook hands back only the calls Cindy must decide.
  it('keeps native Claude Auto with host MCPs and routes only Cindy-owned calls back to Cindy', async () => {
    const policies: Record<string, 'auto-approve' | 'prompt' | 'prompt-each-time'> = {
      cindy_orca: 'auto-approve', custom_prompt_mcp: 'prompt', always_confirm_mcp: 'prompt-each-time',
    };
    const { handle, preToolUse, queryPermissionMode, reviewAutoPermissionAction } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      mcpProviderNames: Object.keys(policies),
      mcpToolApprovalPolicy: ({ serverName }) => policies[serverName] ?? 'prompt',
    });
    expect(queryPermissionMode).toBe('auto');
    expect(handle.getAutoReviewOwner?.()).toBe('native');
    // Trusted MCP goes to canUseTool (Host shortcut, no model) so delegated scope is still re-checked.
    expect(await preToolUse('mcp__cindy_orca__create_workers', { workers: [] })).toEqual(['ask']);
    expect(await preToolUse('mcp__always_confirm_mcp__send', { to: 'x' })).toEqual(['ask']);
    // Ordinary MCP calls and shell commands are left to the native classifier alone.
    expect(await preToolUse('mcp__custom_prompt_mcp__write_record', { value: 1 })).toEqual([]);
    expect(await preToolUse('Bash', { command: 'npm test' })).toEqual([]);
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    await handle.close();
  });

  it('keeps native Claude Auto when the SDK init reveals settings MCPs', async () => {
    const { handle, fakeQuery, queryPermissionMode } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      initMcpServerNames: ['settings_prompt_mcp'],
      blockMcpServerStatus: true,
      rejectPermissionModeChange: true,
    });

    expect(queryPermissionMode).toBe('auto');
    await vi.waitFor(() => expect(fakeQuery.mcpServerStatus).toHaveBeenCalled());
    expect(fakeQuery.setPermissionMode).not.toHaveBeenCalled();
    expect(fakeQuery.close).not.toHaveBeenCalled();
    await handle.close();
  });

  it('routes channel-turn tool calls to Cindy because native Auto cannot see requester authority', async () => {
    const { handle, preToolUse } = await startSession('auto', {
      providerId: 'anthropic',
      authSource: 'oauth',
      mcpProviderNames: ['custom_prompt_mcp', 'cindy_orca'],
      mcpToolApprovalPolicy: ({ serverName }) => (serverName === 'cindy_orca' ? 'auto-approve' : 'prompt'),
    });
    await handle.send({ type: 'user', content: 'group request' }, {
      turnPermissionPolicy: {
        origin: { kind: 'im', channel: 'telegram', taskId: 'group-turn' },
        confirmationSurface: 'channel',
        forceConfirmToolCall: () => false,
      },
    });
    expect(handle.getAutoReviewOwner?.()).toBe('cindy');
    expect(await preToolUse('Bash', { command: 'npm test' })).toEqual(['ask']);
    expect(await preToolUse('mcp__custom_prompt_mcp__write_record', { value: 1 })).toEqual(['ask']);
    // A channel policy outranks trusted-MCP approval and read-only shortcuts.
    expect(await preToolUse('Read', { file_path: 'README.md' })).toEqual(['ask']);
    expect(await preToolUse('mcp__cindy_orca__create_workers', { workers: [] })).toEqual(['ask']);
    await handle.close();
  });

  it('keeps SDK auto for official Claude OAuth without host MCPs', async () => {
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
    const { handle, canUseTool, seen, workingDir } = await startSession('auto');
    const r = await canUseTool(
      'Read',
      { file_path: path.join(workingDir, 'x') },
      { toolUseID: 't1' },
    );
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

  it('external writable roots auto-approve writes while read-only references still review', async () => {
    const referenceDir = await makeTempDir();
    const writableDir = await makeTempDir();
    const replacementWritableDir = await makeTempDir();
    const reviewer = vi.fn(async () => ({ verdict: 'block' as const, reason: 'read-only reference' }));
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewer,
      extraDirs: [referenceDir],
      writableDirs: [writableDir],
    });

    await expect(canUseTool(
      'Write',
      { file_path: path.join(writableDir, 'result.txt') },
      { toolUseID: 'external-writable' },
    )).resolves.toMatchObject({ behavior: 'allow' });
    expect(reviewer).not.toHaveBeenCalled();
    expect(permissionRequests(seen)).toHaveLength(0);

    await expect(canUseTool(
      'Write',
      { file_path: path.join(referenceDir, 'spec.md') },
      { toolUseID: 'readonly-reference' },
    )).resolves.toMatchObject({ behavior: 'deny', message: 'Cindy Auto-review denied this tool call: read-only reference' });
    expect(reviewedRequest(reviewer)).toMatchObject({
      workspaceRoots: expect.arrayContaining([referenceDir, writableDir]),
      writableRoots: expect.arrayContaining([writableDir]),
    });
    expect(reviewedRequest(reviewer).writableRoots).not.toContain(referenceDir);
    expect(permissionRequests(seen)).toHaveLength(0);

    await handle.setWritableDirs!([replacementWritableDir]);
    await expect(canUseTool(
      'Write',
      { file_path: path.join(replacementWritableDir, 'new-result.txt') },
      { toolUseID: 'replacement-writable' },
    )).resolves.toMatchObject({ behavior: 'allow' });
    expect(reviewer).toHaveBeenCalledTimes(1);
    await expect(canUseTool(
      'Write',
      { file_path: path.join(writableDir, 'stale-result.txt') },
      { toolUseID: 'revoked-writable' },
    )).resolves.toMatchObject({ behavior: 'deny', message: 'Cindy Auto-review denied this tool call: read-only reference' });
    expect(reviewer).toHaveBeenCalledTimes(2);
    await handle.close();
  });

  it('checks reads against the latest roots after an in-query writable grant revoke', async () => {
    const writableDir = await makeTempDir();
    const { handle, canUseTool, fakeQuery, reviewAutoPermissionAction, seen } =
      await startSession('auto', { writableDirs: [writableDir] });

    await handle.setWritableDirs!([]);
    await handle.setPermissionMode!('ask');
    await handle.setPermissionMode!('auto');
    expect(fakeQuery.setPermissionMode).toHaveBeenLastCalledWith('default');
    await expect(canUseTool(
      'Read',
      { file_path: path.join(writableDir, 'revoked.txt') },
      { toolUseID: 'read-revoked', suggestions: SESSION_SUGGESTION },
    )).resolves.toMatchObject({ behavior: 'allow' });

    expect(fakeQuery.interrupt).not.toHaveBeenCalled();
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(reviewedRequest(reviewAutoPermissionAction).writableRoots).not.toContain(writableDir);
    expect(reviewedRequest(reviewAutoPermissionAction).workspaceRoots).not.toContain(writableDir);
    expect(reviewedRequest(reviewAutoPermissionAction).action).toMatchObject({ path: path.join(writableDir, 'revoked.txt'), requireWorkspaceBoundary: true });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('denies pending file approvals on revoke without dismissing unrelated requests', async () => {
    const writableDir = await makeTempDir();
    let resolveNetwork!: (decision: InteractionDecision) => void;
    const { handle, canUseTool, seen } = await startSession('auto', {
      writableDirs: [writableDir],
      reviewVerdict: 'ask',
      interactionResolver: (request) => new Promise<InteractionDecision>((resolve) => {
        if (request.kind === 'permission' && request.toolName === 'WebFetch') {
          resolveNetwork = resolve;
        }
      }),
    });
    const pendingRead = canUseTool(
      'Read',
      { file_path: '/outside/pending.txt' },
      { toolUseID: 'pending-read-revoke' },
    );
    const pendingNetwork = canUseTool(
      'WebFetch',
      { url: 'https://example.com' },
      { toolUseID: 'pending-network' },
    );
    await vi.waitFor(() => expect(permissionRequests(seen)).toHaveLength(2));
    // AI asks carry the reviewer's reason to the confirmation card.
    expect(permissionRequests(seen)[0]?.metadata).toMatchObject({ autoReviewReason: 'reviewed' });

    await handle.setWritableDirs!([]);

    await expect(pendingRead).resolves.toMatchObject({ behavior: 'deny' });
    resolveNetwork({ kind: 'permission', behavior: 'allow' });
    await expect(pendingNetwork).resolves.toMatchObject({ behavior: 'allow' });
    await handle.close();
  });

  it('canonicalizes every structured write tool through the nearest existing ancestor', async () => {
    const writableDir = await makeTempDir();
    const realDir = path.join(writableDir, 'real-output');
    const linkedDir = path.join(writableDir, 'linked-output');
    await fs.mkdir(realDir);
    await fs.symlink(realDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalRealDir = await fs.realpath(realDir);
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [writableDir],
    });

    const cases = [
      { toolName: 'Write', pathField: 'file_path', fileName: 'write.txt' },
      { toolName: 'Edit', pathField: 'file_path', fileName: 'edit.txt' },
      { toolName: 'MultiEdit', pathField: 'file_path', fileName: 'multi-edit.txt' },
      { toolName: 'NotebookEdit', pathField: 'notebook_path', fileName: 'notebook.ipynb' },
    ] as const;
    for (const testCase of cases) {
      const lexicalPath = path.join(linkedDir, testCase.fileName);
      const result = await canUseTool(
        testCase.toolName,
        { [testCase.pathField]: lexicalPath },
        { toolUseID: `canonical-${testCase.toolName}` },
      );
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: { [testCase.pathField]: path.join(canonicalRealDir, testCase.fileName) },
      });
    }
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('auto-approves a write beneath a writable root that is itself a symlink', async () => {
    const rootParent = await makeTempDir();
    const realRoot = await makeTempDir();
    const linkedRoot = path.join(rootParent, 'linked-root');
    await fs.symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalRealRoot = await fs.realpath(realRoot);
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [linkedRoot],
    });

    await expect(canUseTool(
      'Write',
      { file_path: path.join(linkedRoot, 'result.txt') },
      { toolUseID: 'linked-writable-root' },
    )).resolves.toMatchObject({
      behavior: 'allow',
      updatedInput: { file_path: path.join(canonicalRealRoot, 'result.txt') },
    });
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviews evidence when a writable root cannot be canonicalized', async () => {
    const rootParent = await makeTempDir();
    const realRoot = await makeTempDir();
    const linkedRoot = path.join(rootParent, 'linked-root');
    const lexicalFile = path.join(linkedRoot, 'existing.txt');
    await fs.writeFile(path.join(realRoot, 'existing.txt'), 'before');
    await fs.symlink(realRoot, linkedRoot, process.platform === 'win32' ? 'junction' : 'dir');
    const originalRealpath = fs.realpath.bind(fs);
    vi.spyOn(fs, 'realpath').mockImplementation(async (target) => {
      if (String(target) === linkedRoot) throw new Error('root realpath unavailable');
      return originalRealpath(target);
    });
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [linkedRoot],
    });

    await expect(canUseTool(
      'Edit',
      { file_path: lexicalFile },
      { toolUseID: 'unresolved-writable-root', suggestions: SESSION_SUGGESTION },
    )).resolves.toMatchObject({ behavior: 'allow' });
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(reviewedRequest(reviewAutoPermissionAction).action).toMatchObject({ path: lexicalFile, resolvedPath: await originalRealpath(lexicalFile) });
    expect((reviewedRequest(reviewAutoPermissionAction).action as { resolvedWritableRoots?: string[] }).resolvedWritableRoots).not.toContain(linkedRoot);
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('reviews each structured write whose authorized-looking link escapes the writable root', async () => {
    const writableDir = await makeTempDir();
    const outsideDir = await makeTempDir();
    const linkedDir = path.join(writableDir, 'linked-output');
    await fs.symlink(outsideDir, linkedDir, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalOutsideDir = await fs.realpath(outsideDir);
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [writableDir],
    });

    for (const toolName of ['Write', 'Edit'] as const) {
      const fileName = `${toolName.toLowerCase()}.txt`;
      const result = await canUseTool(
        toolName,
        { file_path: path.join(linkedDir, fileName) },
        { toolUseID: `escape-${toolName}`, suggestions: SESSION_SUGGESTION },
      );
      expect(result).toMatchObject({
        behavior: 'allow',
        updatedInput: { file_path: path.join(canonicalOutsideDir, fileName) },
      });
    }
    expect(reviewAutoPermissionAction).toHaveBeenCalledTimes(2);
    expect(permissionRequests(seen)).toHaveLength(0);
    for (const [request] of vi.mocked(reviewAutoPermissionAction).mock.calls) {
      expect(request?.action).toMatchObject({ path: expect.stringContaining(linkedDir), resolvedPath: expect.stringContaining(canonicalOutsideDir) });
      expect(request?.writableRoots).toContain(writableDir);
    }
    await handle.close();
  });

  it('re-applies system and credential protections to canonical write targets', async () => {
    const writableDir = await makeTempDir();
    const credentialDir = path.join(writableDir, '.ssh');
    const credentialAlias = path.join(writableDir, 'build-cache');
    const systemAlias = path.join(writableDir, 'system-cache');
    await fs.mkdir(credentialDir);
    await fs.symlink(
      credentialDir,
      credentialAlias,
      process.platform === 'win32' ? 'junction' : 'dir',
    );
    const systemRoot = process.platform === 'win32'
      ? (process.env.SystemRoot ?? 'C:\\Windows')
      : '/etc';
    await fs.symlink(systemRoot, systemAlias, process.platform === 'win32' ? 'junction' : 'dir');
    const canonicalCredentialDir = await fs.realpath(credentialDir);
    const canonicalSystemRoot = await fs.realpath(systemRoot);
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [writableDir],
    });

    const credentialResult = await canUseTool(
      'Write',
      { file_path: path.join(credentialAlias, 'key') },
      { toolUseID: 'credential-link', suggestions: SESSION_SUGGESTION },
    );
    expect(credentialResult).toMatchObject({
      behavior: 'allow',
      updatedInput: { file_path: path.join(canonicalCredentialDir, 'key') },
    });
    const systemResult = await canUseTool(
      'Edit',
      { file_path: path.join(systemAlias, 'cindy-review-test') },
      { toolUseID: 'system-link', suggestions: SESSION_SUGGESTION },
    );
    expect(systemResult).toMatchObject({
      behavior: 'allow',
      updatedInput: { file_path: path.join(canonicalSystemRoot, 'cindy-review-test') },
    });
    expect(reviewAutoPermissionAction).toHaveBeenCalledTimes(2);
    expect(reviewedRequest(reviewAutoPermissionAction, 0).action).toMatchObject({ resolvedPath: path.join(canonicalCredentialDir, 'key') });
    expect(reviewedRequest(reviewAutoPermissionAction, 1).action).toMatchObject({ resolvedPath: path.join(canonicalSystemRoot, 'cindy-review-test') });
    expect(permissionRequests(seen)).toHaveLength(0);
    expect(permissionRequests(seen).every((request) => request.suggestions === undefined)).toBe(true);
    await handle.close();
  });

  it(
    'reviews uncertainty when a dangling link prevents proving the write target',
    async () => {
      const writableDir = await makeTempDir();
      const linkedDir = path.join(writableDir, 'dangling-output');
      await fs.symlink(
        path.join(writableDir, 'missing-target'),
        linkedDir,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
        writableDirs: [writableDir],
      });
      const lexicalPaths = [linkedDir, path.join(linkedDir, 'result.txt')];

      for (const [index, lexicalPath] of lexicalPaths.entries()) {
        const result = await canUseTool(
          'Write',
          { file_path: lexicalPath },
          { toolUseID: `unresolved-link-${index}`, suggestions: SESSION_SUGGESTION },
        );
        expect(result).toMatchObject({
          behavior: 'allow',
          updatedInput: { file_path: lexicalPath },
        });
      }
      expect(reviewAutoPermissionAction).toHaveBeenCalledTimes(2);
      for (const [index, [request]] of vi.mocked(reviewAutoPermissionAction).mock.calls.entries()) {
        expect(request?.action).toMatchObject({ path: lexicalPaths[index], resolvedPath: null });
      }
      expect(permissionRequests(seen)).toHaveLength(0);
      expect(permissionRequests(seen).every((request) => request.suggestions === undefined)).toBe(true);
      await handle.close();
    },
  );

  it('rejects stale evidence if a writable directory is revoked while its real path is resolving', async () => {
    const writableDir = await makeTempDir();
    const lexicalPath = path.join(writableDir, 'result.txt');
    const originalRealpath = fs.realpath.bind(fs);
    let markResolutionStarted!: () => void;
    let releaseResolution!: () => void;
    const resolutionStarted = new Promise<void>((resolve) => { markResolutionStarted = resolve; });
    const resolutionGate = new Promise<void>((resolve) => { releaseResolution = resolve; });
    vi.spyOn(fs, 'realpath').mockImplementation(async (target) => {
      if (String(target) === lexicalPath) {
        markResolutionStarted();
        await resolutionGate;
      }
      return originalRealpath(target);
    });
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto', {
      writableDirs: [writableDir],
    });

    const pending = canUseTool(
      'Write',
      { file_path: lexicalPath },
      { toolUseID: 'revoked-during-realpath', suggestions: SESSION_SUGGESTION },
    );
    await resolutionStarted;
    await handle.setWritableDirs!([]);
    releaseResolution();

    await expect(pending).resolves.toMatchObject({
      behavior: 'deny',
      message: 'Directory permissions changed; retry with the current scope.',
    });
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });
});

describe('Auto-review wiring: lightweight reviewer controls gray actions', () => {

  it.each(['allow', 'ask'] as const)('invalidates old %s when identical text refers to a new attachment', async (verdict) => {
    let release!: (decision: { verdict: 'allow' | 'ask' }) => void;
    const reviewer = vi.fn().mockImplementationOnce(() => new Promise<{ verdict: 'allow' | 'ask' }>((resolve) => { release = resolve; }))
      .mockResolvedValue({ verdict: 'allow' });
    const { handle } = await startSession('auto', { reviewer });
    const source = (file: string) => ({ [AUTO_REVIEW_SOURCE_CONTENT]: [
      { type: 'text' as const, text: 'Send this.' }, { type: 'file' as const, path: file },
    ] });
    await handle.send({ type: 'user', content: 'Send this.' }, source('/tmp/attachment-a.txt'));
    const action = { kind: 'other' as const, description: 'send the selected attachment' };
    const old = handle.reviewAutoPermissionAction!(action);
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.steer!({ type: 'user', content: 'Send this.' }, source('/tmp/attachment-b.txt'));
    // The same serialized request now has a different pending decision in the existing cache.
    expect(await handle.reviewAutoPermissionAction!(action)).toMatchObject({ verdict: 'allow' });
    expect(reviewer).toHaveBeenCalledTimes(2);
    expect(reviewer.mock.calls[0][0].userIntent).toBe(reviewer.mock.calls[1][0].userIntent);
    release({ verdict });
    expect(await old).toMatchObject({ verdict: 'block', reason: expect.stringContaining('User instructions changed') });
    await handle.close();
  });

  it('invalidates an in-flight approval when the user withdraws authorization', async () => {
    let release!: (decision: { verdict: 'allow' }) => void;
    const reviewer = vi.fn(() => new Promise<{ verdict: 'allow' }>((resolve) => { release = resolve; }));
    const { handle, canUseTool, seen } = await startSession('auto', { reviewer, mcpProviderNames: ['cindy'], mcpToolApprovalPolicy: () => 'prompt' });
    await handle.send({ type: 'user', content: 'Send the prepared email.' });
    const pending = canUseTool('mcp__cindy__ghost_call', { tool: 'gmail', args: { action: 'send' } }, { toolUseID: 'pending-email' });
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.steer?.({ type: 'user', content: 'Do not send anything.' });
    release({ verdict: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'deny', message: expect.stringContaining('User instructions changed') });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

  it('discards an in-flight allow when external directory permissions change', async () => {
    const writableDir = await makeTempDir();
    let resolveReview: ((value: { verdict: 'allow'; reason: string }) => void) | undefined;
    const reviewer = vi.fn(() => new Promise<{ verdict: 'allow'; reason: string }>((resolve) => {
      resolveReview = resolve;
    }));
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewer,
      writableDirs: [writableDir],
    });

    const pending = canUseTool(
      'Bash',
      { command: 'npm install left-pad', cwd: writableDir },
      { toolUseID: 'late-directory-revoke', suggestions: SESSION_SUGGESTION },
    );
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.setWritableDirs!([]);
    resolveReview!({ verdict: 'allow', reason: 'reviewed before revoke' });

    await expect(pending).resolves.toMatchObject({ behavior: 'deny', message: 'Cindy Auto-review denied this tool call: Directory permissions changed; retry with the current scope.' });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
  });

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

  it.each([false, true])('Auto to Full access applies the owner choice during review (IM policy=%s)', async (restricted) => {
    let release!: (decision: { verdict: 'allow' }) => void;
    const reviewer = vi.fn(() => new Promise<{ verdict: 'allow' }>((resolve) => { release = resolve; }));
    const { handle, canUseTool, seen } = await startSession('auto', {
      reviewer, mcpProviderNames: ['cindy'], mcpToolApprovalPolicy: () => 'prompt-each-time',
    });
    await handle.send({ type: 'user', content: 'Send the approved report.' }, restricted ? {
      turnPermissionPolicy: {
        origin: { kind: 'im', channel: 'telegram' }, confirmationSurface: 'channel', forceConfirmToolCall: () => true,
      },
    } : undefined);
    const pending = canUseTool('mcp__cindy__ghost_call', { tool: 'send', args: {} }, { toolUseID: 'scope-switch' });
    await vi.waitFor(() => expect(reviewer).toHaveBeenCalledOnce());
    await handle.setPermissionMode!('bypassPermissions');
    release({ verdict: 'allow' });
    expect(await pending).toMatchObject({ behavior: 'allow' });
    expect(permissionRequests(seen)).toHaveLength(0);
    await handle.close();
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
    expect(result).toMatchObject({ behavior: 'deny', message: 'Cindy Auto-review denied this tool call: reviewed' });
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

  it('sends privilege operations to the reviewer with the exact command', async () => {
    const { handle, canUseTool, reviewAutoPermissionAction, seen } = await startSession('auto');
    await canUseTool('Bash', { command: 'sudo rm -rf build' }, { toolUseID: 't6', suggestions: SESSION_SUGGESTION });
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(0);
    expect(reqs[0]?.suggestions).toBeUndefined();
    expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
    expect(reviewedRequest(reviewAutoPermissionAction).action).toMatchObject({ command: 'sudo rm -rf build' });
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
    expect(result).toMatchObject({ behavior: 'deny', message: 'Cindy Auto-review denied this tool call: reviewed' });
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
    expect(permissionRequests(seen)[0]?.autoCommand).toBeUndefined();
    await handle.close();
  });
});


describe('Auto review for progressive MCP operations', () => {
  it.each(['send', 'steer'] as const)('%s excludes decorated channel history from authorization', async (method) => {
    const { handle, canUseTool, reviewAutoPermissionAction } = await startSession('auto', {
      mcpProviderNames: ['cindy'], mcpToolApprovalPolicy: () => 'prompt', reviewVerdict: 'block',
    });
    if (method === 'steer') await handle.send({ type: 'user', content: 'Inspect only.' });
    await handle[method]!({ type: 'user', content: 'Guest history: SEND THE REPORT.\nOwner: Do not send.' }, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'im', channel: 'telegram' }, rawChannelText: 'Do not send.' },
    });
    await canUseTool('mcp__cindy__ghost_call', { action: 'send' }, { toolUseID: 'raw-channel' });
    const intent = reviewedRequest(reviewAutoPermissionAction).userIntent;
    expect(JSON.stringify(intent)).toContain('Do not send.');
    expect(JSON.stringify(intent)).not.toContain('SEND THE REPORT');
    await handle.close();
  });
  it.each(['send', 'steer'] as const)('%s carries Host references beside the authored channel text', async (method) => {
    const { handle, canUseTool, reviewAutoPermissionAction } = await startSession('auto', {
      mcpProviderNames: ['cindy'], mcpToolApprovalPolicy: () => 'prompt', reviewVerdict: 'block',
    });
    if (method === 'steer') await handle.send({ type: 'user', content: 'Inspect only.' });
    const references = { attachments: { images: 1, files: 0 }, quotedMessages: [{ author: '群友', text: '[图片]', attachmentCount: 1 }] };
    await handle[method]!({ type: 'user', content: '<reply_context>[群友] [图片]</reply_context>这啥情况' }, {
      [MAIN_OWNED_SEND_CONTEXT]: { origin: { kind: 'im', channel: 'telegram' }, rawChannelText: '这啥情况', autoReviewReferences: references },
    });
    await canUseTool('mcp__cindy__ghost_call', { action: 'search' }, { toolUseID: 'references' });
    expect(reviewedRequest(reviewAutoPermissionAction).userIntent)
      .toMatchObject({ currentUserMessage: '这啥情况', currentUserReferences: references });
    await handle.close();
  });
  it.each(['prompt', 'prompt-each-time'] as const)('uses AI three-way decisions for policy %s', async (policy) => {
    for (const verdict of ['allow', 'block', 'ask'] as const) {
      const { handle, canUseTool, seen, reviewAutoPermissionAction } = await startSession('auto', {
        mcpProviderNames: ['cindy'], mcpToolApprovalPolicy: () => policy, reviewVerdict: verdict,
        interactionResolver: async () => ({ kind: 'permission', behavior: 'deny' }),
      });
      await handle.send({ type: 'user', content: '整理邮箱，先给清单，不发送邮件。' });
      const input = { ghost_id: 'google-gmail', tool: 'gmail', args: { action: 'search', query: 'in:inbox is:unread' } };
      const result = await canUseTool('mcp__cindy__ghost_call', input, { toolUseID: `gmail-${policy}-${verdict}`, suggestions: SESSION_SUGGESTION });
      expect(result.behavior).toBe(verdict === 'allow' ? 'allow' : 'deny');
      expect(reviewAutoPermissionAction).toHaveBeenCalledOnce();
      const request = reviewedRequest(reviewAutoPermissionAction);
      expect(request.userIntent).toContain('不发送邮件');
      expect(JSON.parse((request.action as { description: string }).description)).toMatchObject({ toolName: 'mcp__cindy__ghost_call', input });
      expect(permissionRequests(seen)).toHaveLength(verdict === 'ask' ? 1 : 0);
      if (verdict === 'ask') expect(permissionRequests(seen)[0]?.suggestions).toBeUndefined();
      await handle.close();
    }
  });
});

it.each(['Do not publish.', ''])('keeps live Claude intent %j over stale continuation history', async restriction => {
 const {handle,canUseTool,reviewAutoPermissionAction}=await startSession('auto',{mcpProviderNames:['cindy'],mcpToolApprovalPolicy:()=> 'prompt',reviewVerdict:'block'});
 try {
  await handle.send({type:'user',content:'Publish the release.'});
  await handle.steer!({type:'user',content:restriction});
  await handle.steer!({type:'user',content:'Lead continuation'}, {[AUTO_REVIEW_DELEGATED_CONTINUATION]:true,[AUTO_REVIEW_USER_INTENT]:'Publish the release.'});
  await canUseTool('mcp__cindy__ghost_call',{action:'publish'},{toolUseID:'live-continuation'});
  const intent=reviewedRequest(reviewAutoPermissionAction).userIntent;
  if(restriction) expect(JSON.stringify(intent)).toContain(restriction); else expect(intent).toBe('');
 } finally {await handle.close();}
});


it.each([false, true])('honors Full access for worktree edits and tests without asking (hosted=%s)', async hosted => {
  const { handle, canUseTool, seen, reviewAutoPermissionAction } = await startSession('bypassPermissions', {
    deviceHosted: hosted ? {
      workingDir: '/repo', extraDirs: [], writableDirs: [], platform: 'darwin', shell: '/bin/zsh',
      isGitRepo: true, tunnelUrl: 'http://127.0.0.1:1', tunnelToken: 'test-only', mcpServers: [],
    } : undefined,
    reviewVerdict: 'ask',
  });
  try {
    const input = { command: `cd /repo-contacts-worktree && python3 - <<'PY'
p='cindy-contacts/main.js'
s=open(p,encoding='utf-8').read()
s=s.replace('LIMIT 200', 'ORDER BY id')
open(p,'w',encoding='utf-8').write(s)
PY
node --test .tests/cindy-contacts.test.mjs` };
    expect((await canUseTool(hosted ? 'mcp__cindy_exec__Bash' : 'Bash', input, { toolUseID: 'worktree-edit' })).behavior)
      .toBe('allow');
    expect(seen).toEqual([]);
    expect(reviewAutoPermissionAction).not.toHaveBeenCalled();
  } finally { await handle.close(); }
});

// Unit: actual send -> installed Host observation -> SDK canUseTool. Existing
// callback tests had no personal rules and could not detect shortcut/confirmation bypass.
describe('same-Query personal rules in CC Auto', () => {
  // Unit / first-red contract (2026-10-26): existing tests change a matched
  // deny/ask or the action, not residual text during the SECOND review/card.
  // Use today's schema-valid Cindy residual (not the proposed neutral variant),
  // so grammar/schema rejection cannot masquerade as a timing regression.
  it.each([
    ['review', false], ['review', true], ['confirmation', false], ['confirmation', true],
    ['final-read', false], ['final-read', true],
  ] as const)('binds the second %s to the reviewed original (changed=%s)', async (boundary, changed) => {
    const texts = ['Bash(*private-v1*)', 'Bash(*private-v2*)', 'Bash(*private-v3*)'];
    let version = 0;
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    let reviews = 0;
    let readsAfterSecondReview = 0;
    const reviewer = vi.fn(async () => {
      if (++reviews === 1) return { verdict: 'ask' as const };
      if (boundary === 'review') { entered(); await gate; }
      return { verdict: boundary === 'confirmation' ? 'ask' as const : 'allow' as const };
    });
    let confirmations = 0;
    const h = await startSession('auto', { reviewer, observe: async request => {
      const scope = { ownerId: 'test-owner', executionHostId: 'test-host', harnesses: ['claude-code' as const] };
      return { scope: { ...scope, projectId: request.workingDir }, groups: [], fingerprint: 'no-native-content',
        revalidate: async () => request.execution?.isCurrent() === true,
        readManaged: async () => {
          // Suspend the final read, after the second reviewer and its first
          // revalidation completed. A final refresh must not bless new text.
          if (boundary === 'final-read' && reviews === 2 && ++readsAfterSecondReview === 2) {
            entered(); await gate;
          }
          const group = normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'residual-timing-fixture',
            locator: 'cindy://personal-approval/residual-timing-fixture', dialectVersion: '1', decisionDomain: 'personal-approval' },
          scope, [{ id: 'known', original: 'Bash(pwd)', decision: 'allow',
            matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } },
          { id: 'residual', original: texts[version]!, decision: 'deny', reason: 'unverified wildcard' }]);
          const snapshot = parseApprovalRuleSnapshot({ schemaVersion: 1, revision: group.revision, groups: [group], tombstones: [] });
          return { scope, groups: snapshot.groups, fingerprint: JSON.stringify(snapshot.groups) };
        } };
    }, interactionResolver: async () => {
      confirmations++;
      if (confirmations === 1) version = 1; // First card is now stale: one re-review is necessary.
      else if (boundary === 'confirmation') { entered(); await gate; }
      return { kind: 'permission', behavior: 'allow' };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Show the working directory.' });
      const pending = h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'residual-second-' + boundary });
      await Promise.race([reached, pending.then(result => {
        throw new Error('Callback settled before second boundary: ' + JSON.stringify(result));
      })]);
      expect(reviewer).toHaveBeenCalledTimes(2);
      expect(h.seen).toHaveLength(boundary === 'confirmation' ? 2 : 1);
      for (const [index, original] of texts.slice(0, 2).entries()) {
        const reviewed = reviewedRequest(reviewer, index);
        expect(reviewed.action).toMatchObject({ kind: 'exec', command: 'pwd' });
        expect(reviewed.personalRequirements?.groups[0]?.clauses.map(clause => clause.original))
          .toEqual(['Bash(pwd)', original]);
      }
      if (changed) version = 2;
      release();
      const result = await pending;
      expect.soft(result.behavior).toBe(changed ? 'deny' : 'allow');
      expect(reviewer).toHaveBeenCalledTimes(2);
      expect(confirmations).toBe(boundary === 'confirmation' ? 2 : 1);
      expect(h.seen).toHaveLength(confirmations);
    } finally { release(); await h.handle.close(); }
  });

  it('does not repeat the same live Auto ask after remembering the exact command', async () => {
    let remembered: Extract<InteractionRequest, { kind: 'permission' }>['autoCommand'];
    let liveDecision: 'ask' | 'deny' = 'ask';
    const original: TestObserve = request => observe(liveDecision, 'git push')(request);
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => ({ scope: value.scope, fingerprint: String(!!remembered),
        groups: remembered ? [normalizeRuleGroup({ harness: 'cindy', layer: 'user', sourceId: 'exact-bash:remembered',
          locator: 'cindy://personal-approval/exact-bash/remembered', dialectVersion: '1', decisionDomain: 'personal-approval' },
        { ...value.scope, projectId: undefined }, [{ id: 'remembered', original: 'Bash(git push)', decision: 'allow',
          matcher: { kind: 'cc-command', mode: 'exact', pattern: 'git push' }, tool: { domain: 'exec', name: 'Bash' },
          autoAskExceptions: remembered.autoAskExceptions }])] : [] }) };
    }, reviewer: vi.fn(async () => ({ verdict: 'allow' as const })),
    interactionResolver: async request => {
      if (request.kind === 'permission') remembered = request.autoCommand;
      expect(remembered?.autoAskExceptions).toHaveLength(1);
      return { kind: 'permission', behavior: 'allow' };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'remember-first' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(1);
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'remember-second' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(1);
      remembered = undefined;
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'remember-removed' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(2);
      liveDecision = 'deny';
      // A new accepted input supplies a new native observation; stored allow never overrides its deny.
      await h.handle.abort();
      await h.handle.send({ type: 'user', content: 'Check the operation again.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'remember-native-deny' })).behavior).toBe('deny');
      expect(h.seen).toHaveLength(2);
    } finally { await h.handle.close(); }
  });
  function observe(decision: 'allow' | 'ask' | 'deny', command: string, current = () => true,
    residual = false): TestObserve {
    return async request => ({ scope: { ownerId: 'test-owner', executionHostId: 'test-host', projectId: request.workingDir, harnesses: ['claude-code'] }, fingerprint: 'fixture:' + decision + command + residual,
      groups: [normalizeRuleGroup({ harness: 'claude-code', layer: 'user', sourceId: 'fixture-live',
        locator: 'claude-code-live://userSettings/fixture', dialectVersion: 'live-user-v1', decisionDomain: 'personal-approval' },
      { ownerId: 'test-owner', executionHostId: 'test-host', harnesses: ['claude-code'] }, [
        { id: 'known', original: 'Bash(' + command + ')', decision,
          matcher: { kind: 'cc-command', mode: 'exact', pattern: command } },
        ...(residual ? [{ id: 'unknown', original: 'Bash(*private*)', decision: 'deny' as const, reason: 'unverified wildcard' }] : []),
      ])], revalidate: async () => current() && request.execution?.isCurrent() !== false });
  }
  // Real send/canUseTool: managed state can change after input acceptance,
  // including while the original reviewer or human confirmation is pending.
  it.each(['ask', 'deny', 'allow'] as const)('consumes the current managed %s without another send', async decision => {
    const original = observe('allow', 'unrelated');
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => {
        const active = await observe(decision, 'git push')(request);
        return { ...active!, fingerprint: 'active:' + decision };
      } };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'immediate-' + decision })).behavior)
        .toBe(decision === 'deny' ? 'deny' : 'allow');
      expect(h.seen).toHaveLength(decision === 'ask' ? 1 : 0);
    } finally { await h.handle.close(); }
  });
  it.each(['reviewer', 'confirmation'] as const)('discards an old %s allow when a managed deny becomes active', async boundary => {
    let decision: 'allow' | 'deny' = 'allow';
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = observe('allow', 'unrelated');
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => (await observe(decision, 'git push')(request))! };
    }, reviewer: vi.fn(async () => { if (boundary === 'reviewer') await gate; return { verdict: boundary === 'confirmation' ? 'ask' as const : 'allow' as const }; }),
    interactionResolver: async () => { await gate; return { kind: 'permission', behavior: 'allow' }; } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'immediate-pending' });
      await vi.waitFor(() => expect(boundary === 'reviewer' ? vi.mocked(h.reviewAutoPermissionAction!).mock.calls.length : h.seen.length).toBe(1));
      decision = 'deny'; release();
      expect((await pending).behavior).toBe('deny');
    } finally { release(); await h.handle.close(); }
  });
  it('invalidates the old allow cache, activates ask and deny, and removes the contribution without another input', async () => {
    let active: 'ask' | 'deny' | undefined;
    const original = observe('allow', 'unrelated');
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => {
        const now = (await observe(active ?? 'allow', 'git push')(request))!;
        return { ...now, groups: active ? now.groups : [], fingerprint: active ?? 'removed' };
      } };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'cached-allow' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(0);
      active = 'ask';
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'new-ask' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(1);
      active = undefined;
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'removed-ask' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(1);
      active = 'deny';
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'new-deny' })).behavior).toBe('deny');
    } finally { await h.handle.close(); }
  });
  it('keeps native Auto routing when the managed read is unavailable', async () => {
    const original = observe('allow', 'pwd');
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request); return value && { ...value, readManaged: async () => undefined };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Show the directory.' });
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'unavailable-managed' })).behavior).toBe('allow');
      expect(h.seen).toHaveLength(0);
    } finally { await h.handle.close(); }
  });
  it.each([true, false])('withdraws a pending managed-read failure in FullAccess only if identity remains current (%s)', async current => {
    let release!: () => void; let reading = false; let ownerCurrent = true;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = observe('allow', 'unrelated', () => ownerCurrent);
    const h = await startSession('auto', { observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => { reading = true; await gate; throw new Error('publication changed during read'); } };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'managed-full-access' });
      await vi.waitFor(() => expect(reading).toBe(true));
      await h.handle.setPermissionMode!('bypassPermissions'); ownerCurrent = current; release();
      expect((await pending).behavior).toBe(current ? 'allow' : 'deny');
      expect(h.seen).toHaveLength(0);
    } finally { release(); await h.handle.close(); }
  });
  it('does not let a wide allow plus unknown sibling skip the actual reviewer', async () => {
    const h = await startSession('auto', { observe: observe('allow', 'pwd', () => true, true) });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'personal-residual' })).behavior).toBe('allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce();
      expect(reviewedRequest(h.reviewAutoPermissionAction!).personalRequirements?.groups[0]?.clauses).toHaveLength(2);
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'personal-residual-again' })).behavior).toBe('allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledTimes(2);
    } finally { await h.handle.close(); }
  });
  it('reviews unknown siblings before enforcing the matched program ask', async () => {
    const h = await startSession('auto', { observe: observe('ask', 'pwd', () => true, true) });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'personal-ask-residual' })).behavior).toBe('allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce();
      expect(reviewedRequest(h.reviewAutoPermissionAction!).personalRequirements?.groups[0]?.clauses).toHaveLength(2);
      expect(h.seen).toHaveLength(1);
    } finally { await h.handle.close(); }
  });
  it.each(['ask', 'deny'] as const)('enforces program %s despite ordinary reviewer allow', async decision => {
    const h = await startSession('auto', { observe: observe(decision, 'git push') });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-' + decision })).behavior)
        .toBe(decision === 'deny' ? 'deny' : 'allow');
      expect(h.seen).toHaveLength(decision === 'ask' ? 1 : 0);
      if (decision === 'deny') expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
    } finally { await h.handle.close(); }
  });
  it('keeps personal deny when an existing per-turn confirmation policy wraps the action', async () => {
    const h = await startSession('auto', { observe: observe('deny', 'git push') });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' }, { turnPermissionPolicy: { origin: { kind: 'im', channel: 'telegram' }, confirmationSurface: 'channel', forceConfirmToolCall: () => true } });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-normalized' })).behavior).toBe('deny');
      expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
    } finally { await h.handle.close(); }
  });
  it('rematches the real updated command after confirmation instead of using the old allow', async () => {
    const h = await startSession('auto', { observe: observe('deny', 'git push'), reviewVerdict: 'ask',
      interactionResolver: async () => ({ kind: 'permission', behavior: 'allow', updatedInput: { command: 'git push' } }) });
    try {
      await h.handle.send({ type: 'user', content: 'Download the requested file.' });
      expect((await h.canUseTool('Bash', { command: 'git push origin main' }, { toolUseID: 'personal-updated' })).behavior).toBe('deny');
      expect(h.seen).toHaveLength(1);
    } finally { await h.handle.close(); }
  });
  it.each(['program-ask', 'unknown'] as const)('reviews edited Bash input with its %s instead of reusing the old card', async scenario => {
    const reviewer = vi.fn().mockResolvedValueOnce({ verdict: 'ask' })
      .mockResolvedValue({ verdict: scenario === 'unknown' ? 'ask' : 'allow' });
    let confirmations = 0;
    const h = await startSession('auto', {
      observe: observe(scenario === 'unknown' ? 'allow' : 'ask', 'git push', () => true, scenario === 'unknown'),
      reviewer, interactionResolver: async () => ++confirmations === 1
        ? { kind: 'permission', behavior: 'allow', updatedInput: { command: 'git push' } }
        : { kind: 'permission', behavior: 'deny', reason: 'Decline the edited command.' },
    });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const result = await h.canUseTool('Bash', { command: 'git push origin main' }, { toolUseID: 'personal-edited-' + scenario });
      expect(result.behavior).toBe('deny');
      expect(h.seen).toHaveLength(2);
      expect(h.seen[1]).toMatchObject({ kind: 'permission', input: { command: 'git push' },
        autoCommand: { harness: 'claude-code', command: 'git push' } });
      expect(reviewer).toHaveBeenCalledTimes(scenario === 'unknown' ? 2 : 1);
      if (scenario === 'unknown') {
        const edited = reviewedRequest(reviewer, 1);
        expect(edited.action).toMatchObject({ kind: 'exec', command: 'git push' });
        expect(edited.personalRequirements?.groups[0]?.clauses).toHaveLength(2);
      }
    } finally { await h.handle.close(); }
  });
  // Real callback timing regression: the edited command's reviewer result must
  // not consume an ask published only while that second review was pending.
  it.each(['allow', 'deny', 'full-access'] as const)('rechecks a new ask during edited-command review (%s)', async answer => {
    let activeAsk = false;
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const original = observe('allow', 'unrelated');
    const reviewer = vi.fn().mockResolvedValueOnce({ verdict: 'ask' })
      .mockImplementation(async () => { await gate; return { verdict: 'allow' }; });
    let confirmations = 0;
    const h = await startSession('auto', { reviewer, observe: async request => {
      const value = await original(request);
      return value && { ...value, readManaged: async () => {
        const current = (await observe('ask', 'git push')(request))!;
        return { ...current, groups: activeAsk ? current.groups : [], fingerprint: String(activeAsk) };
      } };
    }, interactionResolver: async () => ++confirmations === 1
      ? { kind: 'permission', behavior: 'allow', updatedInput: { command: 'git push' } }
      : { kind: 'permission', behavior: answer === 'deny' ? 'deny' : 'allow' } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push origin main' }, { toolUseID: 'edited-pending-ask' });
      await vi.waitFor(() => expect(reviewer).toHaveBeenCalledTimes(2));
      activeAsk = true;
      if (answer === 'full-access') await h.handle.setPermissionMode!('bypassPermissions');
      release();
      expect((await pending).behavior).toBe(answer === 'deny' ? 'deny' : 'allow');
      expect(h.seen).toHaveLength(answer === 'full-access' ? 1 : 2);
      if (answer !== 'full-access') expect(h.seen[1]).toMatchObject({ kind: 'permission', input: { command: 'git push' } });
    } finally { release(); await h.handle.close(); }
  });
  it.each(['reviewer', 'confirmation'] as const)('rejects pending %s after a new accepted input', async stage => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await startSession('auto', { observe: observe('allow', 'git push'),
      reviewer: vi.fn(async () => { if (stage === 'reviewer') await gate; return { verdict: stage === 'reviewer' ? 'allow' as const : 'ask' as const }; }),
      interactionResolver: async () => { await gate; return { kind: 'permission', behavior: 'allow' }; } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-new-input' });
      await vi.waitFor(() => stage === 'reviewer'
        ? expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce() : expect(h.seen).toHaveLength(1));
      await h.handle.steer!({ type: 'user', content: 'Stop that work.' });
      release();
      expect((await pending).behavior).toBe('deny');
    } finally { release(); await h.handle.close(); }
  });
  it.each(['allow', 'deny'] as const)('keeps FullAccess and explicit human %s semantics after a personal ask', async behavior => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await startSession('auto', { observe: observe('ask', 'git push'),
      interactionResolver: async () => { await gate; return { kind: 'permission', behavior }; } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-full' });
      await vi.waitFor(() => expect(h.seen).toHaveLength(1));
      if (behavior === 'allow') await h.handle.setPermissionMode!('bypassPermissions');
      release();
      const result = await pending;
      if (behavior === 'deny') await h.handle.setPermissionMode!('bypassPermissions');
      expect(result.behavior).toBe(behavior);
      expect(h.seen).toHaveLength(1);
    } finally { release(); await h.handle.close(); }
  });
  it('keeps the existing FullAccess dismissal while the SDK mode control is still pending', async () => {
    let release!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const h = await startSession('auto', { observe: observe('ask', 'git push'),
      interactionResolver: () => new Promise<InteractionDecision>(() => {}) });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      const pending = h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-full-pending-control' });
      await vi.waitFor(() => expect(h.seen).toHaveLength(1));
      h.fakeQuery.setPermissionMode.mockImplementationOnce(async () => { await gate; });
      const switching = h.handle.setPermissionMode!('bypassPermissions');
      expect((await pending).behavior).toBe('allow');
      release();
      await switching;
    } finally { release(); await h.handle.close(); }
  });
  it('retains a real accepted-turn lease after the observation deadline ends', async () => {
    let requestSeen: Parameters<NonNullable<AgentDeps['onClaudeLiveUserRules']>>[0] | undefined;
    const delegate = observe('deny', 'git push');
    const h = await startSession('auto', { observe: async request => { requestSeen = request; return delegate(request); } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect(requestSeen?.isCurrent()).toBe(false);
      expect(requestSeen?.signal.aborted).toBe(true);
      expect(requestSeen?.execution?.isCurrent()).toBe(true);
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-after-observation' })).behavior).toBe('deny');
    } finally { await h.handle.close(); }
  });
  it.each(['reviewer', 'confirmation'] as const)('discards a stale Host lease after pending %s', async stage => {
    let current = true;
    const h = await startSession('auto', { observe: observe('allow', 'git push', () => current),
      reviewer: async () => { if (stage === 'reviewer') current = false; return { verdict: stage === 'confirmation' ? 'ask' : 'allow' }; },
      interactionResolver: async () => { current = false; return { kind: 'permission', behavior: 'allow' }; } });
    try {
      await h.handle.send({ type: 'user', content: 'Do the requested work.' });
      expect((await h.canUseTool('Bash', { command: 'git push' }, { toolUseID: 'personal-stale' })).behavior).toBe('deny');
    } finally { await h.handle.close(); }
  });
});

// Unit: revision56 acceptance showed native shortcuts bypassing canUseTool.
// Exercise the actual agent-registered hooks independently from its callback;
// the transport stub neither merges decisions nor turns hook ask into callback.
// Existing callback/timing coverage cannot prove that missing routing decision.
describe('whole personal requirements at the registered Bash hook boundary', () => {
  const original = 'Read(private)\r\n  保留完整原文 🧪 e\u0301\n末行  ';
  const observe: TestObserve = async request => {
    const scope = { ownerId: 'test-owner', executionHostId: 'test-host',
      projectId: request.workingDir, harnesses: ['claude-code' as const] };
    const group = normalizeRuleGroup(requirementsOrigin('hook-routing'), scope, [
      { id: 'requirement', original, decision: 'requirement', reason: 'user-authored-verbatim',
        tool: { domain: 'exec', name: 'Bash' } },
      { id: 'known', original: 'Read(explicit exec pwd)', decision: 'allow',
        matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' }, tool: { domain: 'exec', name: 'Bash' } },
    ]);
    const snapshot = parseApprovalRuleSnapshot({ schemaVersion: 1, revision: 1, groups: [group], tombstones: [] });
    return { scope, groups: [], fingerprint: 'no-native-ask-fixture',
      revalidate: async () => request.execution?.isCurrent() === true,
      readManaged: async () => ({ scope, groups: snapshot.groups, fingerprint: JSON.stringify(snapshot.groups) }) };
  };
  it.each(['cindy', 'native', 'default', 'full-access', 'plan', 'descendant', 'no-observer', 'text-only'] as const)(
    'routes only the qualified Cindy Auto root to its callback (%s)', async scenario => {
      const mode = scenario === 'default' ? 'ask' : scenario === 'full-access' ? 'bypassPermissions' : 'auto';
      const h = await startSession(mode, {
        observe: scenario === 'no-observer' ? undefined : observe,
        initMcpServerNames: ['routing-fixture'],
        ...(scenario === 'native' ? { providerId: 'anthropic', authSource: 'oauth' as const } : {}),
      });
      try {
        if (scenario === 'plan') await h.handle.setPlanMode!(true);
        await h.handle.send({ type: 'user', content: 'Show the current directory.' }, { toolsDisabled: scenario === 'text-only' });
        expect(h.handle.requestSessionId).toBe('sdk-auto-review');
        expect(h.handle.getAutoReviewOwner?.()).toBe(scenario === 'native' ? 'native' : 'cindy');
        const registered = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse;
        const results: unknown[] = [];
        for (const matcher of registered) {
          if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('Bash')) continue;
          for (const hook of matcher.hooks) results.push(await hook({
            hook_event_name: 'PreToolUse', session_id: 'sdk-auto-review', cwd: h.workingDir,
            transcript_path: '', tool_name: 'Bash', tool_input: { command: 'pwd' },
            ...(scenario === 'descendant' ? { agent_id: 'child-1', agent_type: 'worker' } : {}),
          }, 'hook-routing-pwd', { signal: new AbortController().signal }));
        }
        const ask = expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'ask' }) });
        if (scenario === 'cindy') expect(results).toContainEqual(ask);
        else expect(results).not.toContainEqual(ask);
        if (scenario === 'text-only') expect(results).toContainEqual(expect.objectContaining({
          hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }),
        }));
        expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
        expect(h.seen).toHaveLength(0);
      } finally { await h.handle.close(); }
    },
  );
  it('already reviews the complete group and allows without a human card when called directly', async () => {
    const h = await startSession('auto', { observe, initMcpServerNames: ['routing-fixture'] });
    try {
      await h.handle.send({ type: 'user', content: 'Show the current directory.' });
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'direct-callback-pwd' })).behavior).toBe('allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce();
      const request = reviewedRequest(h.reviewAutoPermissionAction);
      expect(request.personalRequirements?.groups).toHaveLength(1);
      expect(request.personalRequirements?.groups[0]?.clauses.map(clause => clause.original))
        .toEqual([original, 'Read(explicit exec pwd)']);
      expect(JSON.stringify(request.userIntent)).not.toContain('Read(private)');
      expect(h.seen).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  // These calls enumerate registered handlers only; no SDK decision merger or
  // automatic hook-to-callback execution is supplied by the test transport.
  function registeredBashCall(h: { handle: AgentSessionHandle; workingDir: string },
    registered = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse,
    command = { command: 'pwd' }, signal = new AbortController().signal) {
    return (async () => {
      const results: unknown[] = [];
      for (const matcher of registered) {
        if (matcher.matcher && !new RegExp(`^(?:${matcher.matcher})$`).test('Bash')) continue;
        for (const hook of matcher.hooks) results.push(await hook({
          hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: command,
          session_id: h.handle.requestSessionId, tool_use_id: 'lease-pwd', cwd: h.workingDir,
          transcript_path: '',
        }, 'lease-pwd', { signal }));
      }
      return results;
    })();
  }
  const routeAsk = () => expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'ask' }) });
  const contextDeny = () => expect.objectContaining({ hookSpecificOutput: expect.objectContaining({ permissionDecision: 'deny' }) });

  it.each(['unchanged', 'edited', 'deleted', 'deny'] as const)('refreshes the whole group between route and callback (%s)', async change => {
    let version: 'unchanged' | 'edited' | 'deleted' | 'deny' = 'unchanged';
    const h = await startSession('auto', { initMcpServerNames: ['routing-fixture'], observe: async request => {
      const value = await observe(request);
      if (!value?.readManaged) throw new Error('Expected managed observation');
      return { ...value, readManaged: async () => {
        const managed = await value.readManaged!();
        if (!managed || 'kind' in managed) throw new Error('Expected readable fixture');
        const groups = version === 'deleted' ? [] : managed.groups.map(group => ({ ...group,
          clauses: group.clauses.map(clause => clause.decision === 'requirement' && version === 'edited'
            ? { ...clause, original: original + ' edited' }
            : clause.decision !== 'requirement' && version === 'deny' ? { ...clause, decision: 'deny' as const } : clause) }));
        return { ...managed, groups, fingerprint: JSON.stringify(groups) };
      } };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Show the current directory.' });
      expect(await registeredBashCall(h)).toContainEqual(routeAsk());
      expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
      version = change;
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'lease-pwd' })).behavior).toBe(change === 'deny' ? 'deny' : 'allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledTimes(change === 'deleted' || change === 'deny' ? 0 : 1);
      if (change !== 'deleted' && change !== 'deny') expect(reviewedRequest(h.reviewAutoPermissionAction).personalRequirements?.groups[0]?.clauses[0]?.original)
        .toBe(original + (change === 'edited' ? ' edited' : ''));
      expect(h.seen).toHaveLength(0);
    } finally { await h.handle.close(); }
  });

  it.each(['stop', 'directory', 'input', 'signal', 'full-access'] as const)('rechecks the captured execution while route read is pending (%s)', async change => {
    let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
    let entered!: () => void; const reading = new Promise<void>(resolve => { entered = resolve; });
    const h = await startSession('auto', { initMcpServerNames: ['routing-fixture'], observe: async request => {
      const value = await observe(request);
      if (!value?.readManaged) throw new Error('Expected managed observation');
      return { ...value, readManaged: async () => { entered(); await gate; return value.readManaged!(); } };
    } });
    try {
      await h.handle.send({ type: 'user', content: 'Show the current directory.' });
      const actualInput = { command: 'pwd' }; const cancellation = new AbortController();
      const pending = registeredBashCall(h, undefined, actualInput, cancellation.signal);
      await reading;
      if (change === 'stop') await h.handle.abort();
      if (change === 'directory') await h.handle.setExtraDirs!([await makeTempDir()]);
      if (change === 'input') actualInput.command = 'printf CHANGED';
      if (change === 'signal') cancellation.abort();
      if (change === 'full-access') await h.handle.setPermissionMode!('bypassPermissions');
      release();
      const results = await pending;
      expect(results).not.toContainEqual(routeAsk());
      if (change === 'full-access') expect(results).not.toContainEqual(contextDeny());
      else expect(results).toContainEqual(contextDeny());
      expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
      expect(h.seen).toHaveLength(0);
    } finally { release(); await h.handle.close(); }
  });

  it('never borrows the next Query personal lease from an old registered hook', async () => {
    const h = await startSession('auto', { observe, initMcpServerNames: ['routing-fixture'] });
    try {
      await h.handle.send({ type: 'user', content: 'Show the current directory.' });
      const oldHooks = sdkMock.query.mock.calls.at(-1)![0].options.hooks.PreToolUse;
      expect(await registeredBashCall(h, oldHooks)).toContainEqual(routeAsk());
      await h.handle.abort();
      await h.handle.setExtraDirs!([await makeTempDir()]);
      const nextQuery = createFakeQuery(['routing-fixture']);
      sdkMock.query.mockReturnValue(nextQuery);
      await h.handle.send({ type: 'user', content: 'Show the current directory again.' });
      expect(sdkMock.query.mock.results.at(-1)?.value).toBe(nextQuery);
      expect(await registeredBashCall(h)).toContainEqual(routeAsk());
      const stale = await registeredBashCall(h, oldHooks);
      expect(stale).not.toContainEqual(routeAsk());
      expect(stale).toContainEqual(contextDeny());
    } finally { await h.handle.close(); }
  });

  // Unit C: same actual send/gate/callback, new Host result protocol only.
  // Existing timing cases begin with an accepted verified observation; they miss
  // early handoff/final replacement and candidates never accepted by the queue.
  it.each(['final-unavailable', 'final-native-ask', 'mode-cycle', 'acceptance-failed'] as const)(
    'keeps the input lease and native final content distinct (%s)', async scenario => {
      let observations = 0;
      const h = await startSession('auto', { initMcpServerNames: ['routing-fixture'],
        observeResult: async request => {
          observations++;
          const value = await observe(request);
          if (!value) throw new Error('Expected managed fixture');
          request.onManagedObservation?.(value);
          if (scenario === 'final-native-ask') {
            const native = normalizeRuleGroup({ harness: 'claude-code', layer: 'user', sourceId: 'native-final',
              locator: 'claude-code-live://userSettings/native-final', dialectVersion: 'live-user-v1', decisionDomain: 'personal-approval' },
            value.scope, [{ id: 'ask', original: 'Bash(pwd)', decision: 'ask',
              matcher: { kind: 'cc-command', mode: 'exact', pattern: 'pwd' } }]);
            return { kind: 'saved', revision: 1, observation: { ...value, groups: [native] } };
          }
          // Missing final native content must not erase the independent handoff.
          return { kind: 'unavailable', reason: 'native-content-failed' };
        },
        interactionResolver: async () => ({ kind: 'permission', behavior: 'deny' }),
      });
      try {
        if (scenario === 'acceptance-failed') {
          const queue = sdkMock.query.mock.calls.at(-1)![0].prompt as { push(value: unknown): boolean };
          vi.spyOn(queue, 'push').mockReturnValueOnce(false);
          await expect(h.handle.send({ type: 'user', content: 'Unaccepted input.' })).rejects.toThrow('input queue is closed');
        } else {
          await h.handle.send({ type: 'user', content: 'Report pwd.' });
          if (scenario === 'mode-cycle') {
            await h.handle.setPermissionMode!('ask');
            await h.handle.setPermissionMode!('auto');
          }
        }
        if (scenario === 'acceptance-failed' || scenario === 'mode-cycle') {
          expect(await registeredBashCall(h)).toContainEqual(contextDeny());
          expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'unverified-input' })).behavior).toBe('deny');
          expect(h.reviewAutoPermissionAction).not.toHaveBeenCalled();
          expect(h.seen).toHaveLength(0);
          await h.handle.send({ type: 'user', content: 'New accepted input: report pwd.' });
          expect(observations).toBe(2);
        }
        expect(await registeredBashCall(h)).toContainEqual(routeAsk());
        expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'current-accepted-input' })).behavior)
          .toBe(scenario === 'final-native-ask' ? 'deny' : 'allow');
        expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce();
        expect(h.seen).toHaveLength(scenario === 'final-native-ask' ? 1 : 0);
        if (scenario === 'final-native-ask') {
          expect(reviewedRequest(h.reviewAutoPermissionAction).personalRequirements?.groups[0]?.clauses[0]?.decision).toBe('ask');
        }
      } finally { await h.handle.close(); }
    },
  );

  it('ignores late early-handoff and final results after the next input is accepted', async () => {
    let release!: () => void;
    let entered!: () => void;
    let finished!: () => void;
    const gate = new Promise<void>(resolve => { release = resolve; });
    const reached = new Promise<void>(resolve => { entered = resolve; });
    const completed = new Promise<void>(resolve => { finished = resolve; });
    let attempts = 0;
    const h = await startSession('auto', { initMcpServerNames: ['routing-fixture'], observeResult: async request => {
      const value = await observe(request);
      if (!value) throw new Error('Expected managed fixture');
      if (++attempts === 1) {
        entered(); await gate;
        request.onManagedObservation?.(value); // Deliberately after the bounded deadline.
        finished();
        return { kind: 'unavailable', reason: 'late', observation: value };
      }
      request.onManagedObservation?.(value);
      return { kind: 'unavailable', reason: 'native-content-failed' };
    } });
    try {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'performance'] });
      const sending = h.handle.send({ type: 'user', content: 'First unverified input.' });
      await reached;
      await vi.advanceTimersByTimeAsync(1001);
      await sending;
      vi.useRealTimers();
      expect(await registeredBashCall(h)).toContainEqual(contextDeny());
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'first-unverified' })).behavior).toBe('deny');
      await h.handle.send({ type: 'user', content: 'Next accepted input.' });
      release(); await completed;
      expect(await registeredBashCall(h)).toContainEqual(routeAsk());
      expect((await h.canUseTool('Bash', { command: 'pwd' }, { toolUseID: 'next-after-late' })).behavior).toBe('allow');
      expect(h.reviewAutoPermissionAction).toHaveBeenCalledOnce();
      expect(h.seen).toHaveLength(0);
    } finally { vi.useRealTimers(); release(); await h.handle.close(); }
  });

});
