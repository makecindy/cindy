/**
 * rewind.test.ts
 * ---------------------------------------------------------------------------
 * 单元测试 commitRewindAtMessage (主代码: maker-orchestration/rewind.ts):
 *   - happy path: 调 maker session.commitRewindFiles(userUuid, priorAsstUuid)
 *     + 软删 messages + 重置 sessions
 *   - SESSION_RUNNING 守卫 (session.isTurnRunning() = true)
 *   - NO_LIVE_QUERY 守卫 (maker.getSession() = undefined)
 *   - NO_PRIOR_ASSISTANT
 *   - 老消息 user uuid 缺失 → 仍调 commitRewindFiles 但 userUuid='', maker 内部跳过
 *     SDK 文件回滚, forkSession=true 在下次 send 时兜底
 *   - commitRewindFiles 抛错 → DB tx 不跑 (commitRewindFiles 内部已经 try/catch
 *     SDK 子任务, 真要抛说明业务级错误, 应当传播)
 *
 * Stage 2 C2 后: SDK 调用 (rewindFiles / close query / pendingRewindTo) 全部封装在
 * maker-core ClaudeCodeAgent.handle 里, 本测试 mock maker session 即可,
 * 不必 mock SDK Query 或 agentManager 内部状态。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

import { enqueueGitRepoWrite } from '../git-snapshot/gitRepoWriteQueue';

// ── mock(必须在延迟 import 前 hoist) ─────────────────────────────────────

const previewRewindFilesMock = vi.fn();
const commitRewindFilesMock = vi.fn();
const isTurnRunningMock = vi.fn(() => false);
const recomputePrRefsForSessionMock = vi.fn();
const executeCodexFileRewindPlanWithThreadRollbackMock = vi.fn();
const executeCodexFileRestorePlanWithThreadRollbackMock = vi.fn();
const detectCwdMock = vi.fn();
const getHeadMock = vi.fn();
const getCurrentBranchMock = vi.fn();
const listSnapshotsMock = vi.fn();
const listShadowSavepointsMock = vi.fn();
const listUnprotectedPathsMock = vi.fn();
const writeWorktreeTreeForPathsMock = vi.fn();
const gitExecMock = vi.fn();

type FakeSession = {
  agentKind: 'claude-code' | 'codex' | 'pi';
  sdkSessionId: string;
  workDir: string;
  remoteHostId: string | null;
  isTurnRunning: () => boolean;
  previewRewindFiles: typeof previewRewindFilesMock;
  commitRewindFiles: typeof commitRewindFilesMock;
};

let fakeSession: FakeSession | undefined = {
  agentKind: 'claude-code',
  sdkSessionId: 'sdk-uuid-old',
  workDir: '/repo',
  remoteHostId: null,
  isTurnRunning: isTurnRunningMock,
  previewRewindFiles: previewRewindFilesMock,
  commitRewindFiles: commitRewindFilesMock,
};

const getSessionMock = vi.fn(() => fakeSession);
const getSessionMetaMock = vi.fn(async () =>
  fakeSession ? { sdkSessionId: fakeSession.sdkSessionId } : null,
);
function useFakeSession(agentKind: 'claude-code' | 'codex' | 'pi') {
  fakeSession = {
    agentKind,
    sdkSessionId:
      agentKind === 'codex'
        ? 'codex-thread-old'
        : agentKind === 'pi'
          ? 'pi-session-old'
          : 'sdk-uuid-old',
    workDir: '/repo',
    remoteHostId: null,
    isTurnRunning: isTurnRunningMock,
    previewRewindFiles: previewRewindFilesMock,
    commitRewindFiles: commitRewindFilesMock,
  };
  getSessionMock.mockImplementation(() => fakeSession);
}

vi.mock('../maker-host/index.js', () => ({
  getMaker: () => ({
    getSession: getSessionMock,
    getSessionMeta: getSessionMetaMock,
  }),
}));

vi.mock('../git-context/prRefsStore.js', () => ({
  recomputePrRefsForSession: recomputePrRefsForSessionMock,
}));

vi.mock('../git-snapshot/codexFileRewindExecutor', () => ({
  executeCodexFileRewindPlanWithThreadRollback: executeCodexFileRewindPlanWithThreadRollbackMock,
}));

vi.mock('../git-snapshot/codexFileRestoreExecutor', () => ({
  executeCodexFileRestorePlanWithThreadRollback: executeCodexFileRestorePlanWithThreadRollbackMock,
}));

vi.mock('../worktree/WorktreeManager.js', () => ({
  detectCwd: detectCwdMock,
}));

vi.mock('../git-snapshot/gitSnapshotService', () => ({
  getHead: getHeadMock,
  getCurrentBranch: getCurrentBranchMock,
  listSnapshots: listSnapshotsMock,
  // 真实实现返回 { entries, truncated };mock 站点允许直接给数组(默认不截断),
  // 截断用例返回完整对象。
  listShadowSavepoints: async (...args: unknown[]) => {
    const value = await listShadowSavepointsMock(...args);
    return Array.isArray(value) ? { entries: value, truncated: false } : value;
  },
  listUnprotectedPaths: listUnprotectedPathsMock,
  writeWorktreeTreeForPaths: writeWorktreeTreeForPathsMock,
  // 单测里不需要真实拆块: preview 的 pathspec 数量远小于命令行上限。
  chunkPathspecArgs: (pathspecs: readonly string[]) =>
    pathspecs.length > 0 ? [Array.from(pathspecs)] : [],
}));

vi.mock('../worktree/gitExec', () => ({ gitExec: gitExecMock }));

const setLastAssistantTranscriptUuidMock = vi.fn();
vi.mock('../messagePersistBroadcaster.js', () => ({
  setLastAssistantTranscriptUuid: setLastAssistantTranscriptUuidMock,
}));

type SelectStep = unknown[];
const selectQueue: SelectStep[] = [];
const txCalls: Array<{ name: string; args: unknown }> = [];

type ChainMethod = 'from' | 'where' | 'orderBy' | 'limit' | 'leftJoin' | 'groupBy';
type SelectChain = Record<ChainMethod, () => SelectChain> & {
  then: (resolve: (v: unknown[]) => unknown) => Promise<unknown>;
};

function makeChain(rows: unknown[]) {
  const chain = {} as SelectChain;
  const passthrough: ChainMethod[] = ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'groupBy'];
  for (const k of passthrough) chain[k] = vi.fn(() => chain);
  // biome-ignore lint/suspicious/noThenProperty: Drizzle query chains are intentionally thenable in this mock.
  chain.then = (resolve: (v: unknown[]) => unknown) =>
    Promise.resolve(rows).then(resolve);
  return chain;
}

const fakeDb = {
  select: vi.fn(() => {
    const next = selectQueue.shift() ?? [];
    return makeChain(next);
  }),
};

const txMock = vi.fn((name: string, args: unknown) => {
  txCalls.push({ name, args });
  return Promise.resolve({});
});

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({ drizzle: fakeDb, tx: txMock }),
}));

let commitRewindAtMessage: typeof import('../maker-orchestration/rewind').commitRewindAtMessage;
let previewRewindAtMessage: typeof import('../maker-orchestration/rewind').previewRewindAtMessage;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const tempDirs: string[] = [];

beforeEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  selectQueue.length = 0;
  txCalls.length = 0;
  txMock.mockClear();
  setLastAssistantTranscriptUuidMock.mockClear();
  previewRewindFilesMock.mockReset();
  commitRewindFilesMock.mockReset();
  commitRewindFilesMock.mockResolvedValue(undefined);
  executeCodexFileRewindPlanWithThreadRollbackMock.mockReset();
  executeCodexFileRewindPlanWithThreadRollbackMock.mockImplementation(
    async (
      _plan: unknown,
      _sessionId: string,
      hooks: { commitThreadRollback: (execution: unknown) => Promise<unknown> },
    ) => ({
      fileRewind: null,
      threadRollback: await hooks.commitThreadRollback(null),
    }),
  );
  executeCodexFileRestorePlanWithThreadRollbackMock.mockReset();
  executeCodexFileRestorePlanWithThreadRollbackMock.mockImplementation(
    async (
      _plan: unknown,
      _sessionId: string,
      hooks: { commitThreadRollback: (execution: unknown) => Promise<unknown> },
    ) => ({
      fileRestore: null,
      threadRollback: await hooks.commitThreadRollback(null),
    }),
  );
  detectCwdMock.mockReset();
  detectCwdMock.mockResolvedValue({ gitInstalled: true, isGitRepo: false, isInsideWorktree: false });
  getHeadMock.mockReset();
  getHeadMock.mockResolvedValue('head');
  getCurrentBranchMock.mockReset();
  getCurrentBranchMock.mockResolvedValue('main');
  listSnapshotsMock.mockReset();
  listSnapshotsMock.mockResolvedValue([]);
  listShadowSavepointsMock.mockReset();
  listShadowSavepointsMock.mockResolvedValue([]);
  listUnprotectedPathsMock.mockReset();
  listUnprotectedPathsMock.mockResolvedValue([]);
  writeWorktreeTreeForPathsMock.mockReset();
  gitExecMock.mockReset();
  recomputePrRefsForSessionMock.mockReset();
  recomputePrRefsForSessionMock.mockResolvedValue(undefined);
  isTurnRunningMock.mockReset();
  isTurnRunningMock.mockReturnValue(false);
  getSessionMock.mockReset();
  getSessionMetaMock.mockReset();
  // restore default fake Session
  useFakeSession('claude-code');
  getSessionMetaMock.mockImplementation(async () =>
    fakeSession ? { sdkSessionId: fakeSession.sdkSessionId } : null,
  );
  if (!commitRewindAtMessage) {
    const mod = await import('../maker-orchestration/rewind');
    commitRewindAtMessage = mod.commitRewindAtMessage;
    previewRewindAtMessage = mod.previewRewindAtMessage;
  }
});

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ── helpers ────────────────────────────────────────────────────────────────

async function waitFor(condition: () => boolean): Promise<void> {
  for (let i = 0; i < 20; i += 1) {
    if (condition()) return;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  throw new Error('condition was not met');
}

function makeSessionRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sess-1',
    title: 'demo',
    workingDir: '/work',
    model: 'claude-sonnet-4-6',
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: 'sdk-uuid-old',
    totalTokenUsage: 100,
    totalCostUsd: 0.5,
    contextTokens: 200,
    contextWindow: 200000,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: 1000,
    agentKind: 'cc',
    parentSessionId: null,
    forkedAtMessageId: null,
    createdAt: 1000,
    updatedAt: 2000,
    ...over,
  };
}

function makeUserMessageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    rowid: 10,
    id: 'msg-id',
    clientId: 'client-id',
    sessionId: 'sess-1',
    role: 'user',
    content: '"hello"',
    toolUseId: null,
    agentMeta: JSON.stringify({
      uuid: 'sdk-msg-uuid-target',
      sdkSessionId: 'sdk-uuid-old',
      transcriptParentUuid: 'sdk-msg-uuid-prior-asst',
    }),
    createdAt: 3000,
    rewindAt: null,
    ...over,
  };
}

function makeAssistantMessageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    rowid: 9,
    id: 'asst-1',
    clientId: 'asst-client-1',
    sessionId: 'sess-1',
    role: 'assistant',
    content: '"hi"',
    toolUseId: null,
    agentMeta: JSON.stringify({ uuid: 'sdk-msg-uuid-prior-asst', sdkSessionId: 'sdk-uuid-old' }),
    createdAt: 2500,
    rewindAt: null,
    ...over,
  };
}

async function writeClaudeJsonl(
  sdkSessionId: string,
  workingDir: string,
  lines: unknown[],
): Promise<void> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-claude-anchor-'));
  tempDirs.push(root);
  process.env.CLAUDE_CONFIG_DIR = root;
  const projectDir = path.join(root, 'projects', workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(projectDir, { recursive: true });
  await fs.writeFile(
    path.join(projectDir, `${sdkSessionId}.jsonl`),
    `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`,
  );
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('commitRewindAtMessage', () => {
  it('happy path: calls maker session.commitRewindFiles(userUuid, priorAsstUuid) + soft-delete + reset', async () => {
    selectQueue.push([makeUserMessageRow()]);                  // target user msg
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);             // prior assistants asc
    selectQueue.push([makeSessionRow({ contextTokens: 0, contextWindow: 0 })]); // post-update select

    const result = await commitRewindAtMessage('sess-1', 'client-id');

    // 段 1: 委托 maker session 一次性做完 SDK 副作用 (rewindFiles + close + 设标记)
    expect(commitRewindFilesMock).toHaveBeenCalledTimes(1);
    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'sdk-msg-uuid-target',       // userUuid
      'sdk-msg-uuid-prior-asst',   // priorAssistantUuid
    );

    // 段 2: 事务已封装为具名 tx — messages.rewind_at + sessions reset 在 worker 侧执行。
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({
      sessionId: 'sess-1',
      targetCreatedAt: 3000,
      targetMessageId: 'msg-id',
      targetClientId: 'client-id',
      targetMessageUuid: 'sdk-msg-uuid-target',
      preserveMessageUuid: 'sdk-msg-uuid-prior-asst',
    });
    expect(typeof (txCall.args as { now: unknown }).now).toBe('number');
    expect(setLastAssistantTranscriptUuidMock).toHaveBeenCalledWith('sess-1', 'sdk-msg-uuid-prior-asst');

    expect(result.id).toBe('sess-1');
  });

  it('requireLatestUser: SDK 副作用前发现更新的可见 user 消息 → REWIND_TARGET_NOT_LATEST,SDK 与 DB 均未执行', async () => {
    selectQueue.push([makeUserMessageRow()]);              // target user msg
    selectQueue.push([{ id: 'msg-newer' }]);               // 前置校验:存在更新的 user 行

    await expect(
      commitRewindAtMessage('sess-1', 'client-id', { requireLatestUser: true }),
    ).rejects.toMatchObject({ code: 'REWIND_TARGET_NOT_LATEST' });

    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls.length).toBe(0);
  });

  it('requireLatestUser: target 仍最新 → 标志透传进 rewind.commit 事务参数(worker 临界区内最终断言)', async () => {
    selectQueue.push([makeUserMessageRow()]);              // target user msg
    selectQueue.push([]);                                  // 前置校验:无更新 user 行
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);         // visible assistants
    selectQueue.push([makeSessionRow()]);                  // post-update select

    await commitRewindAtMessage('sess-1', 'client-id', { requireLatestUser: true });

    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({ requireLatestUser: true });
  });

  it('requireLatestUser: 事务临界区内断言失败不被 warn 吞掉,以 REWIND_TARGET_NOT_LATEST 上抛', async () => {
    selectQueue.push([makeUserMessageRow()]);
    selectQueue.push([]);                                  // 前置校验通过
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);
    txMock.mockRejectedValueOnce(
      new Error('REWIND_TARGET_NOT_LATEST: newer visible user message exists'),
    );

    await expect(
      commitRewindAtMessage('sess-1', 'client-id', { requireLatestUser: true }),
    ).rejects.toMatchObject({ code: 'REWIND_TARGET_NOT_LATEST' });
  });

  it('不传 requireLatestUser(Rewind 按钮路径)→ 无前置校验查询,事务参数不带守卫标志', async () => {
    selectQueue.push([makeUserMessageRow()]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(
      Object.prototype.hasOwnProperty.call(txCall.args, 'requireLatestUser'),
    ).toBe(false);
  });

  it('uses target transcriptParentUuid as prior assistant anchor when DB timestamps are inverted', async () => {
    selectQueue.push([makeUserMessageRow({ createdAt: 3000 })]); // target user msg
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow({ createdAt: 3001 })]); // prior assistant persisted after target
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'sdk-msg-uuid-target',
      'sdk-msg-uuid-prior-asst',
    );
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({
      targetMessageId: 'msg-id',
      targetClientId: 'client-id',
      targetMessageUuid: 'sdk-msg-uuid-target',
      preserveMessageUuid: 'sdk-msg-uuid-prior-asst',
    });
  });

  it('uses JSONL parent chain instead of stale target transcriptParentUuid', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_real_asst', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'compact-boundary-uuid',
        parentUuid: 'real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
      },
      {
        type: 'user',
        uuid: 'sdk-msg-uuid-target',
        parentUuid: 'compact-boundary-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'sdk-msg-uuid-target',
          sdkSessionId: 'sdk-uuid-old',
          transcriptParentUuid: 'stale-db-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-db-parent-uuid', sdkSessionId: 'sdk-uuid-old' }),
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'sdk-msg-uuid-target',
      'real-assistant-uuid',
    );
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({
      targetMessageUuid: 'sdk-msg-uuid-target',
      preserveMessageUuid: 'real-assistant-uuid',
    });
  });

  it('follows compact boundary logicalParentUuid in JSONL parent chain', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'logical-real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_logical_asst', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'system',
        subtype: 'compact_boundary',
        uuid: 'logical-compact-boundary-uuid',
        parentUuid: null,
        logicalParentUuid: 'logical-real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
      },
      {
        type: 'user',
        uuid: 'logical-user-uuid',
        parentUuid: 'logical-compact-boundary-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'logical-user-uuid',
          sdkSessionId: 'sdk-uuid-old',
          transcriptParentUuid: 'stale-db-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-db-parent-uuid', sdkSessionId: 'sdk-uuid-old' }),
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'logical-user-uuid',
      'logical-real-assistant-uuid',
    );
  });

  it('uses DB synthetic assistant uuid as preserve anchor when JSONL resolves the real SDK uuid', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_real_asst', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'user',
        uuid: 'sdk-msg-uuid-target',
        parentUuid: 'real-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'sdk-msg-uuid-target',
          sdkSessionId: 'sdk-uuid-old',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({
          uuid: '4652fd61-a4df-411a-87e7-000000000001',
          requestId: 'msg_real_asst',
          sdkSessionId: 'sdk-uuid-old',
        }),
        createdAt: 3001,
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'sdk-msg-uuid-target',
      'real-assistant-uuid',
    );
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({
      targetMessageUuid: 'sdk-msg-uuid-target',
      preserveMessageUuid: '4652fd61-a4df-411a-87e7-000000000001',
    });
  });

  it('does not use sourceToolAssistantUUID-only tool assistant as rewind anchor', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'top-level-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_top_level', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        uuid: 'tool-assistant-uuid',
        sourceToolAssistantUUID: 'top-level-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_tool_assistant', content: [{ type: 'text', text: 'tool' }] },
      },
      {
        type: 'user',
        uuid: 'tool-user-uuid',
        parentUuid: 'tool-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'tool-user-uuid',
          sdkSessionId: 'sdk-uuid-old',
          transcriptParentUuid: 'tool-assistant-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'top-level-assistant-uuid', sdkSessionId: 'sdk-uuid-old' }),
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'tool-user-uuid',
      'top-level-assistant-uuid',
    );
  });

  it('continues through sourceToolAssistantUUID parent link on tool assistant entries', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'real-top-level-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_real_top_level', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        uuid: 'tool-assistant-uuid',
        sourceToolAssistantUUID: 'real-top-level-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_tool_assistant', content: [{ type: 'text', text: 'tool' }] },
      },
      {
        type: 'user',
        uuid: 'after-tool-user-uuid',
        parentUuid: 'tool-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'after-tool-user-uuid',
          sdkSessionId: 'sdk-uuid-old',
          transcriptParentUuid: 'stale-db-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-db-parent-uuid', sdkSessionId: 'sdk-uuid-old' }),
        createdAt: 3001,
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'after-tool-user-uuid',
      'real-top-level-assistant-uuid',
    );
  });

  it('follows sourceToolAssistantUUID parent link on user/tool-result entries', async () => {
    await writeClaudeJsonl('sdk-uuid-old', '/repo', [
      {
        type: 'assistant',
        uuid: 'tool-result-parent-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { id: 'msg_tool_result_parent', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'user',
        uuid: 'tool-result-user-uuid',
        sourceToolAssistantUUID: 'tool-result-parent-assistant-uuid',
        sessionId: 'sdk-uuid-old',
        message: { content: [{ type: 'tool_result', tool_use_id: 'tool-use-1', content: 'ok' }] },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'tool-result-user-uuid',
          sdkSessionId: 'sdk-uuid-old',
          transcriptParentUuid: 'stale-db-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-db-parent-uuid', sdkSessionId: 'sdk-uuid-old' }),
      }),
    ]);
    selectQueue.push([makeSessionRow()]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'tool-result-user-uuid',
      'tool-result-parent-assistant-uuid',
    );
  });

  it('uses current live SDK session instead of copied per-message sdkSessionId', async () => {
    if (!fakeSession) throw new Error('fake session missing');
    fakeSession.sdkSessionId = 'sdk-uuid-current';
    await writeClaudeJsonl('sdk-uuid-current', '/repo', [
      {
        type: 'assistant',
        uuid: 'current-real-assistant-uuid',
        sessionId: 'sdk-uuid-current',
        message: { id: 'msg_current_asst', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'user',
        uuid: 'current-user-uuid',
        parentUuid: 'current-real-assistant-uuid',
        sessionId: 'sdk-uuid-current',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'current-user-uuid',
          sdkSessionId: 'sdk-uuid-source',
          transcriptParentUuid: 'stale-source-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-source-parent-uuid', sdkSessionId: 'sdk-uuid-source' }),
      }),
    ]);
    selectQueue.push([makeSessionRow({ sdkSessionId: 'sdk-uuid-current' })]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'current-user-uuid',
      'current-real-assistant-uuid',
    );
  });

  it('uses persisted current SDK session when live handle is still pending', async () => {
    if (!fakeSession) throw new Error('fake session missing');
    fakeSession.sdkSessionId = '<pending>';
    getSessionMetaMock.mockResolvedValueOnce({ sdkSessionId: 'sdk-uuid-current' });
    await writeClaudeJsonl('sdk-uuid-current', '/repo', [
      {
        type: 'assistant',
        uuid: 'persisted-current-assistant-uuid',
        sessionId: 'sdk-uuid-current',
        message: { id: 'msg_persisted_current_asst', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'user',
        uuid: 'persisted-current-user-uuid',
        parentUuid: 'persisted-current-assistant-uuid',
        sessionId: 'sdk-uuid-current',
        message: { content: 'next' },
      },
    ]);
    selectQueue.push([
      makeUserMessageRow({
        agentMeta: JSON.stringify({
          uuid: 'persisted-current-user-uuid',
          sdkSessionId: 'sdk-uuid-source',
          transcriptParentUuid: 'stale-source-parent-uuid',
        }),
      }),
    ]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeAssistantMessageRow({
        agentMeta: JSON.stringify({ uuid: 'stale-source-parent-uuid', sdkSessionId: 'sdk-uuid-source' }),
      }),
    ]);
    selectQueue.push([makeSessionRow({ sdkSessionId: 'sdk-uuid-current' })]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'persisted-current-user-uuid',
      'persisted-current-assistant-uuid',
    );
  });

  it('does not advance last assistant transcript anchor when DB tx fails (fail-closed)', async () => {
    txMock.mockImplementationOnce((name: string, args: unknown) => {
      txCalls.push({ name, args });
      return Promise.reject(new Error('tx failed'));
    });
    selectQueue.push([makeUserMessageRow()]);
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);
    selectQueue.push([makeSessionRow()]);

    // 轮 40-w4-t13:DB 事务失败必须上抛(fail-closed)—— SDK 侧 rewind 已把运行态
    // 切到新身份, 静默吞掉会让调用方误以为成功, 重启后恢复错分支(运行态与
    // 持久化分叉)。断言:reject + 不 advance anchor。
    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toThrow(/rewind 持久化失败/);

    expect(commitRewindFilesMock).toHaveBeenCalledWith(
      'sdk-msg-uuid-target',
      'sdk-msg-uuid-prior-asst',
    );
    expect(txCalls.some((c) => c.name === 'rewind.commit')).toBe(true);
    expect(setLastAssistantTranscriptUuidMock).not.toHaveBeenCalled();
  });

  it('throws SESSION_RUNNING when session.isTurnRunning()=true; commitRewindFiles not called, no DB update', async () => {
    isTurnRunningMock.mockReturnValue(true);

    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toMatchObject({ code: 'SESSION_RUNNING' });

    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('throws NO_LIVE_QUERY when maker.getSession returns undefined', async () => {
    fakeSession = undefined;

    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toMatchObject({ code: 'NO_LIVE_QUERY' });

    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('throws NO_PRIOR_ASSISTANT when target user msg has no preceding assistant with uuid', async () => {
    selectQueue.push([makeUserMessageRow({
      agentMeta: JSON.stringify({ uuid: 'sdk-msg-uuid-target', sdkSessionId: 'sdk-uuid-old' }),
    })]); // target without transcript parent
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([]);                     // prior assistants — empty

    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toMatchObject({ code: 'NO_PRIOR_ASSISTANT' });

    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('OLD message (user uuid missing) still commits, calls commitRewindFiles with empty userUuid', async () => {
    selectQueue.push([makeUserMessageRow({ agentMeta: null })]);  // target with NULL agent_meta
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([makeAssistantMessageRow()]);                 // prior assistants
    selectQueue.push([makeSessionRow()]);                          // post-update select

    const result = await commitRewindAtMessage('sess-1', 'client-id');

    // 老消息无 user uuid → 仍调 commitRewindFiles, 但 userUuid='' 让 maker 内部
    // 跳过 SDK 文件回滚 (forkSession=true CLI 端兜底), pendingRewindTo 仍设上
    expect(commitRewindFilesMock).toHaveBeenCalledTimes(1);
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', 'sdk-msg-uuid-prior-asst');

    expect(txCalls.some((c) => c.name === 'rewind.commit')).toBe(true);
    expect(result.id).toBe('sess-1');
  });

  it('Codex: uses tail turn count and does not require prior assistant uuid', async () => {
    useFakeSession('codex');
    commitRewindFilesMock.mockResolvedValueOnce({ sdkSessionId: 'rollback-thread-id' });
    selectQueue.push([makeUserMessageRow({ agentMeta: null })]); // target user
    selectQueue.push([]); // agent_switch 边界守卫:无边界
    selectQueue.push([
      makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 }),
      makeUserMessageRow({ clientId: 'later-user', createdAt: 5000 }),
    ]); // Codex tail turns
    selectQueue.push([makeSessionRow({ agentKind: 'codex' })]); // post-update select

    const result = await commitRewindAtMessage('sess-1', 'client-id');

    expect(commitRewindFilesMock).toHaveBeenCalledTimes(1);
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 2 });
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({
      targetMessageId: 'msg-id',
      sdkSessionId: 'rollback-thread-id',
    });
    expect(setLastAssistantTranscriptUuidMock).not.toHaveBeenCalled();
    expect(result.id).toBe('sess-1');
  });

  it('Pi: executes rewind after lazy activation establishes a live session', async () => {
    fakeSession = undefined;
    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toMatchObject({ code: 'NO_LIVE_QUERY' });
    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
    getSessionMock.mockClear();

    useFakeSession('pi');
    commitRewindFilesMock.mockResolvedValueOnce({ sdkSessionId: 'pi-session-rewound' });
    selectQueue.push([makeUserMessageRow({ agentMeta: null })]);
    selectQueue.push([]);
    selectQueue.push([
      makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 }),
      makeUserMessageRow({ clientId: 'later-user', createdAt: 5000 }),
    ]);
    selectQueue.push([makeSessionRow({ agentKind: 'pi', sdkSessionId: 'pi-session-rewound' })]);

    const result = await commitRewindAtMessage('sess-1', 'client-id');

    expect(getSessionMock).toHaveBeenCalledTimes(2);
    expect(getSessionMock).toHaveBeenLastCalledWith('sess-1');
    expect(commitRewindFilesMock).toHaveBeenCalledOnce();
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 2 });
    expect(txCalls.find((call) => call.name === 'rewind.commit')?.args).toMatchObject({
      sessionId: 'sess-1',
      sdkSessionId: 'pi-session-rewound',
    });
    expect(result.id).toBe('sess-1');
  });

  it('Codex: previews file rewind savepoints before commit (legacy numstat 方向对调)', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listSnapshotsMock.mockResolvedValueOnce([{ commit: 'sp1', sessionId: 'sess-1', kind: 'after-edit', source: 'legacy-xdt', branch: 'main', parentCount: 1, anchor: 'client-id' }]);
    gitExecMock.mockResolvedValueOnce({ stdout: '3\t1\tsrc/a.ts\n-\t-\tbin.dat\n', stderr: '' });
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })]);

    // legacy revert 预览: numstat 是正向 diff, 回退方向的 insertions/deletions 要对调。
    await expect(previewRewindAtMessage('sess-1', 'client-id')).resolves.toEqual({ canRewind: true, filesChanged: ['src/a.ts', 'bin.dat'], insertions: 1, deletions: 3 });
    expect(listShadowSavepointsMock).toHaveBeenCalledWith('/repo', 'sess-1');
  });

  it('Codex: previews shadow file-restore plan (numstat 不对调, untracked 新建文件删除计入)', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listShadowSavepointsMock.mockResolvedValueOnce([
      {
        commit: 'sc1',
        sessionId: 'sess-1',
        kind: 'after-edit',
        source: 'cindy',
        parentCount: 1,
        anchor: 'client-id',
        baselineCommit: 'base1',
        label: '本轮修改',
        time: '2026-08-04T00:00:00+08:00',
      },
    ]);
    writeWorktreeTreeForPathsMock.mockResolvedValueOnce('wtree-sha');
    gitExecMock.mockImplementation(async (args: readonly string[]) => {
      if (args.includes('--name-only')) {
        // affected = diff(baselineCommit, after-edit commit)
        expect(Array.from(args)).toEqual(['diff', '--name-only', '--no-renames', '-z', 'base1', 'sc1']);
        return { stdout: ['src/a.ts', 'new-file.txt', ''].join('\0'), stderr: '' };
      }
      // W 树 → 基线树, 方向即回退方向。new-file.txt 是本轮新建的 untracked 文件:
      // 基线里不存在 → 记 5 行删除。
      expect(Array.from(args)).toEqual([
        'diff', '--numstat', '--no-renames', '-z', 'wtree-sha', 'base1', '--',
        ':(literal)src/a.ts', ':(literal)new-file.txt',
      ]);
      return { stdout: ['2\t7\tsrc/a.ts', '0\t5\tnew-file.txt', ''].join('\0'), stderr: '' };
    });
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })]);

    // 数字不对调: insertions=Σadded, deletions=Σdeleted (含 untracked 新建文件的 5 行删除)。
    await expect(previewRewindAtMessage('sess-1', 'client-id')).resolves.toEqual({
      canRewind: true,
      filesChanged: ['src/a.ts', 'new-file.txt'],
      insertions: 2,
      deletions: 12,
    });
    expect(writeWorktreeTreeForPathsMock).toHaveBeenCalledWith('/repo', ['src/a.ts', 'new-file.txt']);
    expect(gitExecMock).toHaveBeenCalledTimes(2);
  });

  it('Codex: preview refuses file-restore when affected files are currently filtered', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listShadowSavepointsMock.mockResolvedValueOnce([
      {
        commit: 'sc1',
        sessionId: 'sess-1',
        kind: 'after-edit',
        source: 'cindy',
        parentCount: 1,
        anchor: 'client-id',
        baselineCommit: 'base1',
        time: '2026-08-04T00:00:00+08:00',
      },
    ]);
    gitExecMock.mockImplementation(async (args: readonly string[]) => {
      if (args.includes('--name-only')) {
        return { stdout: ['big.bin', ''].join('\0'), stderr: '' };
      }
      throw new Error(`unexpected git call: ${args.join(' ')}`);
    });
    // 受影响文件当前处于安全过滤范围:预览必须拒绝,且不把字节写进对象库。
    listUnprotectedPathsMock.mockResolvedValueOnce(['big.bin']);
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })]);

    const preview = await previewRewindAtMessage('sess-1', 'client-id');

    expect(preview.canRewind).toBe(false);
    expect(preview.error).toContain('big.bin');
    expect(listUnprotectedPathsMock).toHaveBeenCalledWith('/repo', ['big.bin']);
    expect(writeWorktreeTreeForPathsMock).not.toHaveBeenCalled();
  });

  it('Codex: treats unborn Git histories as no-savepoints conversation-only rewind', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listSnapshotsMock.mockResolvedValueOnce([]);
    getHeadMock.mockRejectedValueOnce(new Error('unborn HEAD'));
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })], [makeSessionRow({ agentKind: 'codex' })]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(getHeadMock).not.toHaveBeenCalled();
    expect(executeCodexFileRewindPlanWithThreadRollbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'conversation-only', fallbackReason: 'no-savepoints' }),
      'sess-1',
      expect.objectContaining({ commitThreadRollback: expect.any(Function) }),
    );
    // conversation-only 不进 restore 执行器, 也不动任何文件相关 git 操作。
    expect(executeCodexFileRestorePlanWithThreadRollbackMock).not.toHaveBeenCalled();
    expect(writeWorktreeTreeForPathsMock).not.toHaveBeenCalled();
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 1 });
  });

  it('Codex commit: shadow 链被截断 → 降级 conversation-only(不做部分文件回退)', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    // 截断窗口内仍能看到可入选的 after-edit,但历史不完整 → 不得据此部分回退。
    listShadowSavepointsMock.mockResolvedValueOnce({
      entries: [
        {
          commit: 'sc1',
          sessionId: 'sess-1',
          kind: 'after-edit',
          source: 'cindy',
          parentCount: 1,
          anchor: 'client-id',
          baselineCommit: 'base1',
          label: '本轮修改',
          time: '2026-08-04T00:00:00+08:00',
        },
      ],
      truncated: true,
    });
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })], [makeSessionRow({ agentKind: 'codex' })]);

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(executeCodexFileRewindPlanWithThreadRollbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'conversation-only', fallbackReason: 'savepoint-history-truncated' }),
      'sess-1',
      expect.objectContaining({ commitThreadRollback: expect.any(Function) }),
    );
    expect(executeCodexFileRestorePlanWithThreadRollbackMock).not.toHaveBeenCalled();
    expect(writeWorktreeTreeForPathsMock).not.toHaveBeenCalled();
  });

  it('Codex: waits for pending snapshot writes before reading savepoints', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listSnapshotsMock.mockResolvedValueOnce([]);
    selectQueue.push(
      [makeUserMessageRow({ agentMeta: null })],
      [], // agent_switch 边界守卫:无边界
      [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })],
    );

    let release: (() => void) | undefined;
    const blocker = enqueueGitRepoWrite('/repo', () =>
      new Promise<void>((resolve) => {
        release = resolve;
      }),
    );
    await waitFor(() => Boolean(release));

    const preview = previewRewindAtMessage('sess-1', 'client-id');
    await waitFor(() => detectCwdMock.mock.calls.length > 0);
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(listSnapshotsMock).not.toHaveBeenCalled();
    release?.();
    await blocker;
    await expect(preview).resolves.toEqual({
      canRewind: true,
      filesChanged: [],
      insertions: 0,
      deletions: 0,
    });
    expect(listSnapshotsMock).toHaveBeenCalledOnce();
  });

  it('Codex: delegates thread rollback into the locked file rewind executor', async () => {
    useFakeSession('codex');
    const fileRewind = {
      repoRoot: '/repo', rollbackId: 'rb-1', protectRef: 'refs/xdt/pre-rollback/rb-1', rollbackCommit: 'rollback-commit', revertedCommits: [], skippedCommits: [],
    };
    executeCodexFileRewindPlanWithThreadRollbackMock.mockImplementationOnce(
      async (
        _plan: unknown,
        _sessionId: string,
        hooks: { commitThreadRollback: (execution: unknown) => Promise<unknown> },
      ) => ({
        fileRewind,
        threadRollback: await hooks.commitThreadRollback(fileRewind),
      }),
    );
    commitRewindFilesMock.mockRejectedValueOnce(new Error('thread rollback failed'));
    selectQueue.push([makeUserMessageRow({ agentMeta: null })], [], [
      makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 }),
    ]);

    await expect(commitRewindAtMessage('sess-1', 'client-id')).rejects.toThrow('thread rollback failed');

    expect(executeCodexFileRewindPlanWithThreadRollbackMock).toHaveBeenCalledWith(
      expect.anything(),
      'sess-1',
      expect.objectContaining({ commitThreadRollback: expect.any(Function), onCompensationError: expect.any(Function) }),
    );
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 1 });
  });

  it('Codex commit: shadow file-restore 计划分发给 restore 执行器', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listShadowSavepointsMock.mockResolvedValueOnce([
      {
        commit: 'sc1',
        sessionId: 'sess-1',
        kind: 'after-edit',
        source: 'cindy',
        parentCount: 1,
        anchor: 'client-id',
        baselineCommit: 'base1',
        label: '本轮修改',
        time: '2026-08-04T00:00:00+08:00',
      },
    ]);
    commitRewindFilesMock.mockResolvedValueOnce({ sdkSessionId: 'restore-thread-id' });
    selectQueue.push(
      [makeUserMessageRow({ agentMeta: null })],
      [], // agent_switch 边界守卫:无边界
      [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })],
      [makeSessionRow({ agentKind: 'codex' })],
    );

    const result = await commitRewindAtMessage('sess-1', 'client-id');

    expect(executeCodexFileRestorePlanWithThreadRollbackMock).toHaveBeenCalledTimes(1);
    expect(executeCodexFileRestorePlanWithThreadRollbackMock).toHaveBeenCalledWith(
      expect.objectContaining({
        mode: 'file-restore',
        repoRoot: '/repo',
        baselineCommit: 'base1',
        restoreCommitsNewestFirst: [
          { commit: 'sc1', baselineCommit: 'base1', anchor: 'client-id', label: '本轮修改' },
        ],
      }),
      'sess-1',
      expect.objectContaining({ commitThreadRollback: expect.any(Function), onCompensationError: expect.any(Function) }),
    );
    expect(executeCodexFileRewindPlanWithThreadRollbackMock).not.toHaveBeenCalled();
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 1 });
    const txCall = txCalls.find((c) => c.name === 'rewind.commit');
    if (!txCall) throw new Error('缺少 rewind.commit tx 调用');
    expect(txCall.args).toMatchObject({ sdkSessionId: 'restore-thread-id' });
    expect(result.id).toBe('sess-1');
  });

  it('Codex commit: legacy file-rewind 计划仍分发给 revert 执行器', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listSnapshotsMock.mockResolvedValueOnce([
      { commit: 'sp1', sessionId: 'sess-1', kind: 'after-edit', source: 'legacy-xdt', branch: 'main', parentCount: 1, anchor: 'client-id' },
    ]);
    selectQueue.push(
      [makeUserMessageRow({ agentMeta: null })],
      [], // agent_switch 边界守卫:无边界
      [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })],
      [makeSessionRow({ agentKind: 'codex' })],
    );

    await commitRewindAtMessage('sess-1', 'client-id');

    expect(executeCodexFileRewindPlanWithThreadRollbackMock).toHaveBeenCalledWith(
      expect.objectContaining({ mode: 'file-rewind', revertCommitsNewestFirst: ['sp1'] }),
      'sess-1',
      expect.objectContaining({ commitThreadRollback: expect.any(Function), onCompensationError: expect.any(Function) }),
    );
    expect(executeCodexFileRestorePlanWithThreadRollbackMock).not.toHaveBeenCalled();
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 1 });
  });

  it('Codex commit: restore 执行器内 thread rollback 失败 → 错误传播, DB 事务不执行', async () => {
    useFakeSession('codex');
    detectCwdMock.mockResolvedValueOnce({ gitInstalled: true, isGitRepo: true, repoRoot: '/repo', isInsideWorktree: false });
    listShadowSavepointsMock.mockResolvedValueOnce([
      {
        commit: 'sc1',
        sessionId: 'sess-1',
        kind: 'after-edit',
        source: 'cindy',
        parentCount: 1,
        anchor: 'client-id',
        baselineCommit: 'base1',
        label: '本轮修改',
        time: '2026-08-04T00:00:00+08:00',
      },
    ]);
    commitRewindFilesMock.mockRejectedValueOnce(new Error('thread rollback failed'));
    selectQueue.push(
      [makeUserMessageRow({ agentMeta: null })],
      [], // agent_switch 边界守卫:无边界
      [makeUserMessageRow({ clientId: 'client-id', createdAt: 3000 })],
    );

    await expect(commitRewindAtMessage('sess-1', 'client-id')).rejects.toThrow('thread rollback failed');

    expect(executeCodexFileRestorePlanWithThreadRollbackMock).toHaveBeenCalledTimes(1);
    expect(commitRewindFilesMock).toHaveBeenCalledWith('', '', { tailTurnsToDrop: 1 });
    expect(txCalls).toHaveLength(0);
  });

  it('目标在 agent_switch 边界之前 → REWIND_UNSUPPORTED_HISTORY,SDK 与 DB 均未执行', async () => {
    selectQueue.push([makeUserMessageRow()]);   // target user msg
    selectQueue.push([{ rowid: 11 }]);   // agent_switch 边界守卫:同毫秒也按插入顺序识别

    await expect(
      commitRewindAtMessage('sess-1', 'client-id'),
    ).rejects.toMatchObject({ code: 'REWIND_UNSUPPORTED_HISTORY' });

    expect(commitRewindFilesMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });
});
