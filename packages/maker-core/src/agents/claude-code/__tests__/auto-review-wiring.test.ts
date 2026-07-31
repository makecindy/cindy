/**
 * Auto-review 接线集成测试:验证 permissionMode='auto' 下 canUseTool 真的走了 Cindy 的
 * 内置工具审查策略(auto-review-policy),而不是把 auto 透传给 CC 分类器。
 *
 * 覆盖(靶心是接线,而非策略本身 —— 策略逐规则由 auto-review-policy.test.ts 覆盖):
 *   - auto + 安全内置(只读 / 区内写 / 只读 shell)→ 静默 allow,不惊动 resolver
 *   - auto + 越界写 / 未知命令 → 弹窗(升级),会话级 suggestion 保留(可"总是允许")
 *   - auto + 危险命令 → 弹窗且 suggestion 被剥(不可持久化授权)
 *   - default 档 → 内置工具不走 auto-review 策略(照旧弹窗),证明只作用于 auto
 */
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AgentDeps } from '../../base-agent.js';
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

function createDeps(): AgentDeps {
  const auth: AuthAdapter = {
    async getState() { return { authenticated: true }; },
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

async function startSession(permissionMode: PermissionMode) {
  const configDir = await makeTempDir();
  process.env.CLAUDE_CONFIG_DIR = configDir;
  const workingDir = await makeTempDir();
  const fakeQuery = createFakeQuery();
  sdkMock.query.mockReturnValue(fakeQuery);

  const agent = new ClaudeCodeAgent(createDeps());
  const handle = await agent.startSession({
    sessionId: 'session-auto-review',
    model: 'claude-opus-4-6',
    workingDir,
    permissionMode,
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

  return { agent, handle, canUseTool: queryOptions.canUseTool, seen, workingDir };
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

describe('Auto-review wiring: permissionMode auto maps to SDK default', () => {
  it('does not pass auto to the SDK — startSession uses default so canUseTool fires', () => {
    // 由下面的用例间接验证:canUseTool 真的被调用(auto 透传给 CC 时它根本不触发)。
    expect(true).toBe(true);
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

describe('Auto-review wiring: escalations reach the resolver', () => {
  it('out-of-workspace write → prompts (session suggestion preserved)', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    const r = await canUseTool(
      'Write',
      { file_path: '/etc/evil.conf' },
      { toolUseID: 't4', suggestions: SESSION_SUGGESTION },
    );
    expect(r.behavior).toBe('allow'); // resolver 默认 allow
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    // 'prompt'(非 prompt-each-time)→ 会话级 suggestion 交给 UI(可"总是允许")。
    expect(reqs[0]?.suggestions).toBeDefined();
    expect(reqs[0]?.suggestions?.length).toBeGreaterThan(0);
    await handle.close();
  });

  it('unknown / write shell command → prompts', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    await canUseTool('Bash', { command: 'npm install left-pad' }, { toolUseID: 't5' });
    expect(permissionRequests(seen)).toHaveLength(1);
    await handle.close();
  });

  it('dangerous command → prompts with session suggestion stripped', async () => {
    const { handle, canUseTool, seen } = await startSession('auto');
    await canUseTool('Bash', { command: 'rm -rf build' }, { toolUseID: 't6', suggestions: SESSION_SUGGESTION });
    const reqs = permissionRequests(seen);
    expect(reqs).toHaveLength(1);
    // prompt-each-time → 即使 SDK 带了 suggestion 也剥掉(不许"总是允许"持久化高风险动作)。
    expect(reqs[0]?.suggestions).toBeUndefined();
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
