/**
 * fork.test.ts
 * ---------------------------------------------------------------------------
 * 单元测试 forkSessionAtMessage (主代码: maker-orchestration/fork.ts):
 *   - 正常 fork 路径: mock maker.forkSdkSession + mock db, 断言入参 + 新 session 字段
 *   - source 没 sdkSessionId → SOURCE_NEVER_RAN (maker 不被调用)
 *   - 找不到前置 assistant → NO_PRIOR_ASSISTANT (maker 不被调用)
 *
 * 业务函数不再直接调 @anthropic-ai/claude-agent-sdk —— SDK 那一刀全部封装在
 * ClaudeCodeAgent.forkSdkSession 里 (内部跑 sdk.forkSession + 两次
 * sdk.getSessionMessages + 建 uuidMap)。本测试 mock maker-host 即可, 不必 mock SDK 本身。
 */

import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { CodexResumePreparationBlockedError } from '@cindy/maker-core';
import { CODEX_RESUME_NOT_READY_WIRE_MESSAGE } from '@cindy/maker-shared/agent-input-projection';

const UUID_V4_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

// ── mocks (must be hoisted before late import) ────────────────────────────

// maker.forkSdkSession 内部已包含 SDK 调用 + uuidMap 构建; 业务测试只关心其入参
// (确认 fork 把对的 sourceSdkSessionId / upToMessageId / title / workingDir 传下去)
// 和返回值 (uuidMap 决定 messages.agentMeta remap 结果)。
const forkSdkSessionMock = vi.fn();
vi.mock('../maker-host/index.js', () => ({
  getMaker: () => ({
    forkSdkSession: forkSdkSessionMock,
  }),
}));

// fake drizzle: select 链返回 thenable。写入侧 MR2.2 后走 DbClient.tx。
// 每个 select() 调用按入栈顺序消费 selectQueue 的下一个返回值。
type SelectStep = unknown[];
const selectQueue: SelectStep[] = [];
const txCalls: Array<{ name: string; args: unknown }> = [];

type SelectChain = Record<string, unknown> & {
  then: (resolve: (v: unknown) => unknown) => Promise<unknown>;
};

function makeChain(rows: unknown[]) {
  const chain = {} as SelectChain;
  const passthrough = ['from', 'where', 'orderBy', 'limit', 'leftJoin', 'groupBy'];
  for (const k of passthrough) chain[k] = vi.fn(() => chain);
  chain.then = (resolve: (v: unknown) => unknown) => Promise.resolve(rows).then(resolve);
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
const queryOneMock = vi.fn(async () => null as Record<string, unknown> | null);
const queryMock = vi.fn(async () => [] as Array<{ role: string; content: string }>);

vi.mock('../localDb/client/current', () => ({
  getDbClient: () => ({
    drizzle: fakeDb,
    tx: txMock,
    queryOne: queryOneMock,
    query: queryMock,
  }),
}));

let forkSessionAtMessage: typeof import('../maker-orchestration/fork').forkSessionAtMessage;
let forkSessionStripEncrypted: typeof import('../maker-orchestration/fork').forkSessionStripEncrypted;
const originalClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
const originalXdtUserDataDir = process.env.XDT_USER_DATA_DIR;
const tempDirs: string[] = [];

beforeEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalXdtUserDataDir === undefined) delete process.env.XDT_USER_DATA_DIR;
  else process.env.XDT_USER_DATA_DIR = originalXdtUserDataDir;
  selectQueue.length = 0;
  txCalls.length = 0;
  txMock.mockClear();
  queryOneMock.mockReset();
  queryOneMock.mockResolvedValue(null);
  queryMock.mockReset();
  queryMock.mockResolvedValue([]);
  forkSdkSessionMock.mockReset();
  // 默认空 uuidMap 让 agentMeta 字段被去掉 (无映射)。具体测试按需 override。
  forkSdkSessionMock.mockResolvedValue({
    newSdkSessionId: 'sdk-new-session-uuid',
    uuidMap: new Map<string, string>(),
  });
  if (!forkSessionAtMessage) {
    const mod = await import('../maker-orchestration/fork');
    forkSessionAtMessage = mod.forkSessionAtMessage;
    forkSessionStripEncrypted = mod.forkSessionStripEncrypted;
  }
});

afterEach(async () => {
  if (originalClaudeConfigDir === undefined) delete process.env.CLAUDE_CONFIG_DIR;
  else process.env.CLAUDE_CONFIG_DIR = originalClaudeConfigDir;
  if (originalXdtUserDataDir === undefined) delete process.env.XDT_USER_DATA_DIR;
  else process.env.XDT_USER_DATA_DIR = originalXdtUserDataDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

// ── helpers ────────────────────────────────────────────────────────────────

function makeSourceRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'src-session',
    title: 'Project A',
    workingDir: '/work',
    model: 'claude-sonnet-4-6',
    providerId: 'xd',
    effort: 'high',
    permissionMode: 'ask',
    status: 'active',
    sdkSessionId: 'sdk-uuid-source',
    totalTokenUsage: 100,
    totalCostUsd: 0.5,
    contextTokens: 200,
    contextWindow: 200000,
    fastMode: false,
    codexHistoryHasProductPrompt: true,
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

function makeMessageRow(over: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'msg-id',
    clientId: 'client-id',
    sessionId: 'src-session',
    role: 'user',
    content: '"hello"',
    toolUseId: null,
    agentMeta: null,
    agentKind: null,
    createdAt: 1500,
    rowid: 1,
    ...over,
  };
}

async function writeClaudeJsonl(
  sdkSessionId: string,
  workingDir: string,
  lines: unknown[],
): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-claude-anchor-'));
  tempDirs.push(root);
  process.env.CLAUDE_CONFIG_DIR = root;
  return writeClaudeJsonlInConfigDir(root, sdkSessionId, workingDir, lines);
}

async function writeClaudeJsonlInConfigDir(
  configDir: string,
  sdkSessionId: string,
  workingDir: string,
  lines: unknown[],
): Promise<string> {
  const projectDir = path.join(configDir, 'projects', workingDir.replace(/[^a-zA-Z0-9]/g, '-'));
  await fs.mkdir(projectDir, { recursive: true });
  const filePath = path.join(projectDir, `${sdkSessionId}.jsonl`);
  await fs.writeFile(filePath, `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return filePath;
}

// ── tests ──────────────────────────────────────────────────────────────────

describe('forkSessionAtMessage', () => {
  it('happy path: fork copies prior messages, calls maker.forkSdkSession with assistant uuid, seeds context snapshot', async () => {
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    const priorAssistant = makeMessageRow({
      id: 'asst-1',
      role: 'assistant',
      content: '"hi back"',
      agentMeta: JSON.stringify({ uuid: 'sdk-msg-uuid-1' }),
      createdAt: 2500,
    });
    const priorUser = makeMessageRow({
      id: 'user-1',
      role: 'user',
      content: '"hi"',
      createdAt: 2000,
    });

    selectQueue.push([makeSourceRow()]);                     // source session
    selectQueue.push([target]);                              // target message
    selectQueue.push([priorUser, priorAssistant]);           // prior messages asc (for bulk copy)
    selectQueue.push([
      makeSourceRow({
        id: 'expected-new-id', // 仅占位; 实际 id 由 createBusinessSessionId() 生成 UUID
        title: '[Fork] Project A',
        sdkSessionId: 'sdk-new-session-uuid',
        parentSessionId: 'src-session',
        forkedAtMessageId: 'target-user',
        totalTokenUsage: 0,
        totalCostUsd: 0,
        contextTokens: 123456,
        contextWindow: 200000,
      }),
    ]);
    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'sdk-new-session-uuid',
      uuidMap: new Map<string, string>(),
      initialContextTokens: 123456,
    });

    const result = await forkSessionAtMessage('src-session', 'target-user');

    // maker 入参: 用最近一条带 uuid 的 assistant
    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'sdk-msg-uuid-1',
      title: '[Fork] Project A',
      workingDir: '/work',
    });

    // fork.session tx: cost 重置、context 快照写入、parent/forkedAt 落对、userSendAt 不为 null
    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    const txArgs = txCall!.args as {
      targetCreatedAt: number;
      newSession: Record<string, unknown>;
      newMessageIds: Array<{ id: string; clientId: string }>;
    };
    expect(txArgs.targetCreatedAt).toBe(3000);
    const sv = txArgs.newSession;
    expect(sv.parentSessionId).toBe('src-session');
    expect(sv.forkedAtMessageId).toBe('target-user');
    expect(sv.sdkSessionId).toBe('sdk-new-session-uuid');
    // providerId 必须继承:丢掉会让 fork 会话与原会话凭证形态漂移,首发触发共享
    // codex 进程重启,任何会话在忙即永远排队(2026-07-03 实报回归锚点)。
    expect(sv.providerId).toBe('xd');
    expect(sv.id).toMatch(UUID_V4_RE);
    expect(sv.title).toBe('[Fork] Project A');
    expect(sv.totalTokenUsage).toBe(0);
    expect(sv.totalCostUsd).toBe(0);
    expect(sv.contextTokens).toBe(123456);
    expect(sv.contextWindow).toBe(200000);
    expect(sv.clearedAt).toBeNull();
    expect(sv.pinnedAt).toBeNull();
    expect(typeof sv.userSendAt).toBe('number');

    // message id 由 main 侧预生成, 顺序对应 source messages asc。
    expect(txArgs.newMessageIds).toHaveLength(2);
    expect(txArgs.newMessageIds[0].id).not.toBe('user-1');
    expect(txArgs.newMessageIds[0].clientId).not.toBe('client-id');

    expect(result.title).toBe('[Fork] Project A');
    expect(result.parentSessionId).toBe('src-session');
  });

  it('codex path: rolls back target and later user turns, copies only prior messages', async () => {
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    const priorUser = makeMessageRow({
      id: 'user-1',
      role: 'user',
      content: '"hi"',
      createdAt: 2000,
    });
    const priorAssistant = makeMessageRow({
      id: 'asst-1',
      role: 'assistant',
      content: '"hi back"',
      createdAt: 2500,
    });

    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      model: 'gpt-5.4',
      sdkSessionId: 'codex-thread-source',
      codexHistoryHasProductPrompt: false,
    })]);
    selectQueue.push([target]);
    selectQueue.push([priorUser, priorAssistant]); // bulk copy: only target之前
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'codex-thread-new',
      parentSessionId: 'src-session',
      forkedAtMessageId: 'target-user',
    })]);

    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'codex-thread-new',
      uuidMap: new Map<string, string>(),
    });
    queryMock.mockResolvedValue([
      { role: 'user', content: '"later"' },
      { role: 'user', content: '"target"' },
    ]);

    const result = await forkSessionAtMessage('src-session', 'target-user');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('codex', {
      sourceSdkSessionId: 'codex-thread-source',
      model: 'gpt-5.4',
      providerId: 'xd',
      upToMessageId: undefined,
      tailTurnsToDrop: 2,
      title: '[Fork] Project A',
      workingDir: '/work',
    });

    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    const txArgs = txCall!.args as {
      newSession: Record<string, unknown>;
      newMessageIds: Array<{ id: string; clientId: string }>;
    };
    const sv = txArgs.newSession;
    expect(sv.agentKind).toBe('codex');
    expect(sv.forkedAtMessageId).toBe('target-user');
    expect(sv.sdkSessionId).toBe('codex-thread-new');
    expect(sv.codexHistoryHasProductPrompt).toBe(false);

    expect(txArgs.newMessageIds).toHaveLength(2);

    expect(result.parentSessionId).toBe('src-session');
  });

  it('codex path: maps preparation or thread/fork failures to a diagnosable error', async () => {
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'imported-codex-thread',
    })]);
    selectQueue.push([target]);
    queryMock.mockResolvedValue([{ role: 'user', content: '"target"' }]);
    forkSdkSessionMock.mockRejectedValueOnce(new Error('thread not found in current Codex home'));

    await expect(
      forkSessionAtMessage('src-session', 'target-user'),
    ).rejects.toMatchObject({
      code: 'CODEX_FORK_STATE_UNAVAILABLE',
      message: 'thread not found in current Codex home',
    });
    expect(txCalls).toHaveLength(0);
  });

  it('codex path: projects a blocked resume preparation without exposing diagnostics', async () => {
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'imported-codex-thread',
    })]);
    selectQueue.push([target]);
    queryMock.mockResolvedValue([{ role: 'user', content: '"target"' }]);
    forkSdkSessionMock.mockRejectedValueOnce(
      new CodexResumePreparationBlockedError('live writer at /private/codex/rollout.jsonl'),
    );

    await expect(
      forkSessionAtMessage('src-session', 'target-user'),
    ).rejects.toMatchObject({
      code: 'CODEX_FORK_STATE_UNAVAILABLE',
      message: CODEX_RESUME_NOT_READY_WIRE_MESSAGE,
    });
    expect(txCalls).toHaveLength(0);
  });

  it('strip encrypted fork: codex-only path forks with strip flag and copies all messages', async () => {
    const source = makeSourceRow({
      agentKind: 'codex',
      model: 'gpt-5.5',
      sdkSessionId: 'codex-thread-source',
    });
    const first = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 1000 });
    const second = makeMessageRow({ id: 'asst-1', role: 'assistant', createdAt: 2000 });

    selectQueue.push([source]); // source session
    selectQueue.push([first, second]); // source messages for max + ids
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      title: '[Fork·已剥离] Project A',
      sdkSessionId: 'codex-thread-new',
      parentSessionId: 'src-session',
      forkedAtMessageId: null,
    })]);

    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'codex-thread-new',
      uuidMap: new Map<string, string>(),
    });

    const result = await forkSessionStripEncrypted('src-session');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('codex', {
      sourceSdkSessionId: 'codex-thread-source',
      model: 'gpt-5.5',
      providerId: 'xd',
      upToMessageId: undefined,
      title: '[Fork·已剥离] Project A',
      workingDir: '/work',
      stripEncryptedReasoning: true,
    });

    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    const txArgs = txCall!.args as {
      targetCreatedAt: number;
      newSession: Record<string, unknown>;
      newMessageIds: Array<{ id: string; clientId: string }>;
    };
    expect(txArgs.targetCreatedAt).toBe(2001);
    expect(txArgs.newSession.id).toMatch(UUID_V4_RE);
    expect(txArgs.newSession.title).toBe('[Fork·已剥离] Project A');
    expect(txArgs.newSession.parentSessionId).toBe('src-session');
    expect(txArgs.newSession.forkedAtMessageId).toBeNull();
    expect(txArgs.newSession.providerId).toBe('xd');
    expect(txArgs.newMessageIds).toHaveLength(2);
    expect(result.parentSessionId).toBe('src-session');
  });

  it('remaps agentMeta uuid via maker uuidMap so chained fork (B → C) keeps valid uuids', async () => {
    // 场景: A → fork → B 时, SDK 把 jsonl 里 uuid 全部 remap。源 DB 里的 agentMeta
    // 携带的是 A 的旧 uuid; 写入 B 时必须替换成 B jsonl 里的新 uuid (从 uuidMap),
    // 否则 B → C 时反查到的 uuid 在 B jsonl 找不到, SDK forkSession 会报错。
    // ClaudeCodeAgent.forkSdkSession 内部已经把建好的 uuidMap 直接返回, 这里只测
    // fork 用 uuidMap 正确 remap 了 agentMeta 列。
    await writeClaudeJsonl('sdk-uuid-source', '/work', [{
      type: 'assistant',
      uuid: 'old-asst-uuid',
      parentUuid: 'old-user-uuid',
      sessionId: 'sdk-uuid-source',
      message: { id: 'old-asst-request', content: [{ type: 'text', text: 'hi back' }] },
    }]);
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    const priorUser = makeMessageRow({
      id: 'user-1',
      role: 'user',
      content: '"hi"',
      agentMeta: JSON.stringify({ uuid: 'old-user-uuid' }),
      createdAt: 2000,
    });
    const priorAssistant = makeMessageRow({
      id: 'asst-1',
      role: 'assistant',
      content: '"hi back"',
      agentMeta: JSON.stringify({ uuid: 'old-asst-uuid', parentUuid: 'old-user-uuid' }),
      createdAt: 2500,
    });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);
    selectQueue.push([priorUser, priorAssistant]); // bulk copy

    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'sdk-new-session-uuid',
      uuidMap: new Map<string, string>([
        ['old-user-uuid', 'new-user-uuid'],
        ['old-asst-uuid', 'new-asst-uuid'],
      ]),
    });

    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'target-user');

    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    const txArgs = txCall!.args as {
      uuidMap: Array<[string, string]>;
      newMessageIds: Array<{ id: string; clientId: string }>;
    };
    expect(txArgs.uuidMap).toEqual([
      ['old-user-uuid', 'new-user-uuid'],
      ['old-asst-uuid', 'new-asst-uuid'],
    ]);
    expect(txArgs.newMessageIds).toHaveLength(2);
  });

  it('throws SOURCE_NEVER_RAN when source.sdkSessionId is null; maker not invoked', async () => {
    selectQueue.push([makeSourceRow({ sdkSessionId: null })]);
    selectQueue.push([makeMessageRow({ clientId: 'any-msg' })]);

    await expect(
      forkSessionAtMessage('src-session', 'any-msg'),
    ).rejects.toMatchObject({ code: 'SOURCE_NEVER_RAN' });

    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('rejects a historical target invalidated by context rebuild', async () => {
    const target = makeMessageRow({
      id: 'stale-history',
      clientId: 'stale-history-client',
      role: 'assistant',
      createdAt: 2500,
      rowid: 20,
    });
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'current-codex-thread',
    })]);
    selectQueue.push([target]);
    queryOneMock.mockResolvedValueOnce({ id: 'later-context-rebuild' });

    await expect(
      forkSessionAtMessage('src-session', 'stale-history-client'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_HISTORY' });

    expect(queryOneMock).toHaveBeenCalledWith(
      expect.stringContaining("role = 'context_rebuild'"),
      ['src-session', 2500, 2500, 20],
    );
    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('rejects a historical engine boundary without a parked native session id', async () => {
    const target = makeMessageRow({
      id: 'historical-assistant',
      clientId: 'historical-assistant-client',
      role: 'assistant',
      createdAt: 2500,
      rowid: 20,
    });
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'current-codex-thread',
    })]);
    selectQueue.push([target]);
    queryOneMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        content: JSON.stringify({
          fromAgentKind: 'cc',
          toAgentKind: 'codex',
          fromModel: 'claude-sonnet-4-6',
          fromSdkSessionId: null,
        }),
        created_at: 2800,
        rowid: 30,
      });

    await expect(
      forkSessionAtMessage('src-session', 'historical-assistant-client'),
    ).rejects.toMatchObject({ code: 'UNSUPPORTED_HISTORY' });

    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('forks a historical Claude node from the parked native session instead of the current Codex thread', async () => {
    const target = makeMessageRow({
      id: 'historical-assistant',
      clientId: 'historical-assistant-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({ uuid: 'historical-claude-uuid' }),
      agentKind: 'cc',
      createdAt: 2500,
      rowid: 20,
    });
    const priorUser = makeMessageRow({
      id: 'historical-user',
      role: 'user',
      agentKind: 'cc',
      createdAt: 2000,
      rowid: 10,
    });
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      model: 'gpt-5.4',
      sdkSessionId: 'current-codex-thread',
    })]);
    selectQueue.push([target]);
    selectQueue.push([]); // no next user before the engine leaves
    selectQueue.push([priorUser, target]);
    selectQueue.push([makeSourceRow({
      agentKind: 'cc',
      model: 'claude-sonnet-4-6',
      sdkSessionId: 'forked-historical-claude',
      parentSessionId: 'src-session',
    })]);
    queryOneMock
      .mockResolvedValueOnce(null) // no context_rebuild after target
      .mockResolvedValueOnce({
        content: JSON.stringify({
          fromAgentKind: 'cc',
          toAgentKind: 'codex',
          fromModel: 'claude-sonnet-4-6',
          fromSdkSessionId: 'parked-claude-session',
          handoff: 'handoff',
        }),
        created_at: 2800,
        rowid: 30,
      });
    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'forked-historical-claude',
      uuidMap: new Map<string, string>(),
    });

    await forkSessionAtMessage('src-session', 'historical-assistant-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'parked-claude-session',
      upToMessageId: 'historical-claude-uuid',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txArgs = txCalls.find((call) => call.name === 'fork.session')!.args as {
      targetCreatedAt: number;
      targetRowid: number;
      detachAgentSwitchSessions: boolean;
      newSession: Record<string, unknown>;
    };
    expect(txArgs.targetCreatedAt).toBe(2800);
    expect(txArgs.targetRowid).toBe(30);
    expect(txArgs.detachAgentSwitchSessions).toBe(true);
    expect(txArgs.newSession.agentKind).toBe('cc');
    expect(txArgs.newSession.model).toBe('claude-sonnet-4-6');
    expect(txArgs.newSession.providerId).toBeNull();
  });

  it('re-arms the copied handoff when forking from the first user after an engine switch', async () => {
    const boundary = makeMessageRow({
      id: 'switch-boundary',
      clientId: 'switch-boundary-client',
      role: 'agent_switch',
      content: JSON.stringify({
        fromAgentKind: 'codex',
        toAgentKind: 'cc',
        fromModel: 'gpt-5.4',
        toModel: 'claude-sonnet-4-6',
        fromSdkSessionId: 'parked-codex',
        handoff: 'full handoff',
        consumed: true,
      }),
      createdAt: 2500,
      rowid: 10,
    });
    const target = makeMessageRow({
      id: 'first-claude-user',
      clientId: 'first-claude-user-client',
      role: 'user',
      agentKind: 'cc',
      createdAt: 3000,
      rowid: 20,
    });
    selectQueue.push([makeSourceRow({ sdkSessionId: 'fresh-claude-session' })]);
    selectQueue.push([target]);
    selectQueue.push([boundary]);
    selectQueue.push([makeSourceRow({
      sdkSessionId: null,
      parentSessionId: 'src-session',
      forkedAtMessageId: 'first-claude-user-client',
    })]);

    await forkSessionAtMessage('src-session', 'first-claude-user-client');

    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    const txArgs = txCalls.find((call) => call.name === 'fork.session')!.args as {
      resetHandoffBoundaryClientId: string | null;
      newSession: Record<string, unknown>;
    };
    expect(txArgs.resetHandoffBoundaryClientId).toBe('switch-boundary-client');
    expect(txArgs.newSession.sdkSessionId).toBeNull();
    expect(txArgs.newSession.agentKind).toBe('cc');
  });

  it('counts rollback turns only from the parked Codex thread across later resumes', async () => {
    const target = makeMessageRow({
      id: 'historical-codex-assistant',
      clientId: 'historical-codex-assistant-cid',
      role: 'assistant',
      agentKind: 'codex',
      createdAt: 2500,
      rowid: 20,
    });
    const nextCodexUser = makeMessageRow({
      id: 'next-codex-user',
      role: 'user',
      agentKind: 'codex',
      createdAt: 2600,
      rowid: 25,
    });
    const priorUser = makeMessageRow({
      id: 'prior-codex-user',
      role: 'user',
      agentKind: 'codex',
      createdAt: 2000,
      rowid: 10,
    });
    const parkedCodexBoundary = {
      fromAgentKind: 'codex',
      toAgentKind: 'cc',
      fromModel: 'gpt-5.4',
      fromSdkSessionId: 'parked-codex-thread',
      handoff: 'handoff',
    };
    selectQueue.push([makeSourceRow({
      agentKind: 'cc',
      sdkSessionId: 'current-claude-session',
    })]);
    selectQueue.push([target]);
    selectQueue.push([nextCodexUser]);
    selectQueue.push([priorUser, target]);
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      model: 'gpt-5.4',
      sdkSessionId: 'forked-codex-thread',
      parentSessionId: 'src-session',
    })]);
    queryOneMock
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        content: JSON.stringify(parkedCodexBoundary),
        created_at: 2800,
        rowid: 30,
      });
    queryMock.mockResolvedValue([
      { role: 'user', content: '"current Claude"' },
      { role: 'agent_switch', content: JSON.stringify(parkedCodexBoundary) },
      { role: 'user', content: '"resumed Codex"' },
      { role: 'agent_switch', content: JSON.stringify({
        fromAgentKind: 'cc',
        toAgentKind: 'codex',
        fromModel: 'claude-sonnet-4-6',
        fromSdkSessionId: 'current-claude-session',
      }) },
      { role: 'user', content: '"middle Claude"' },
      { role: 'agent_switch', content: JSON.stringify(parkedCodexBoundary) },
      { role: 'user', content: '"next Codex"' },
    ]);
    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'forked-codex-thread',
      uuidMap: new Map<string, string>(),
    });

    await forkSessionAtMessage('src-session', 'historical-codex-assistant-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('codex', {
      sourceSdkSessionId: 'parked-codex-thread',
      model: 'gpt-5.4',
      providerId: null,
      upToMessageId: undefined,
      tailTurnsToDrop: 2,
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txArgs = txCalls.find((call) => call.name === 'fork.session')!.args as {
      newSession: Record<string, unknown>;
    };
    expect(txArgs.newSession.agentKind).toBe('codex');
    expect(txArgs.newSession.model).toBe('gpt-5.4');
  });

  // ── assistant 目标（fork-from-reply）────────────────────────────────────
  // 语义: 复制到该回复所在 turn 的末尾（边界 = 下一条未回滚 user 消息）。

  it('assistant target (claude): copies through end of the turn, anchors at the turn-final assistant', async () => {
    const target = makeMessageRow({
      id: 'asst-mid',
      clientId: 'asst-mid-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({ uuid: 'uuid-a1' }),
      createdAt: 2500,
    });
    const turnFinalAssistant = makeMessageRow({
      id: 'asst-final',
      role: 'assistant',
      agentMeta: JSON.stringify({ uuid: 'uuid-a2' }),
      createdAt: 2600,
    });
    const nextUser = makeMessageRow({ id: 'user-next', role: 'user', createdAt: 3000 });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });

    selectQueue.push([makeSourceRow()]);                       // source session
    selectQueue.push([target]);                                // target message
    selectQueue.push([nextUser]);                              // next user after target
    selectQueue.push([priorUser, target, turnFinalAssistant]); // bulk copy (含 target 所在 turn)
    selectQueue.push([
      makeSourceRow({
        sdkSessionId: 'sdk-new-session-uuid',
        parentSessionId: 'src-session',
        forkedAtMessageId: 'asst-mid-cid',
      }),
    ]);

    await forkSessionAtMessage('src-session', 'asst-mid-cid');

    // 锚点是边界(下一条 user)之前最后一条带 uuid 的 assistant — turn 末尾那条,
    // 而不是 target 本身 (turn 中间截断会留 dangling tool_use)。
    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'uuid-a2',
      title: '[Fork] Project A',
      workingDir: '/work',
    });

    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    const txArgs = txCall!.args as {
      targetCreatedAt: number;
      newSession: Record<string, unknown>;
      newMessageIds: Array<{ id: string; clientId: string }>;
    };
    // 复制边界 = 下一条 user 消息的 createdAt
    expect(txArgs.targetCreatedAt).toBe(3000);
    expect(txArgs.newMessageIds).toHaveLength(3);
    expect(txArgs.newSession.forkedAtMessageId).toBe('asst-mid-cid');
  });

  it('assistant target (claude): resolves synthetic block uuid through JSONL request id', async () => {
    const jsonlPath = await writeClaudeJsonl('sdk-uuid-source', '/work', [
      {
        type: 'assistant',
        uuid: '4652fd61-a4df-411a-87e7-cdc0b311cc39',
        parentUuid: 'preceding-user-record',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_real', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    await fs.appendFile(jsonlPath, '{not-json\n');
    const target = makeMessageRow({
      id: 'asst-synthetic',
      clientId: 'asst-synthetic-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({
        uuid: '4652fd61-a4df-411a-87e7-000000000001',
        requestId: 'msg_real',
        parentUuid: 'preceding-user-record',
      }),
      createdAt: 2500,
    });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });
    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'sdk-new-session-uuid',
      uuidMap: new Map([
        ['4652fd61-a4df-411a-87e7-cdc0b311cc39', 'new-real-assistant-uuid'],
      ]),
    });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);
    selectQueue.push([]);
    selectQueue.push([priorUser, target]);
    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'asst-synthetic-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: '4652fd61-a4df-411a-87e7-cdc0b311cc39',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txCall = txCalls.find((c) => c.name === 'fork.session');
    expect(txCall).toBeDefined();
    expect((txCall!.args as { uuidMap: Array<[string, string]> }).uuidMap).toEqual(expect.arrayContaining([
      ['4652fd61-a4df-411a-87e7-cdc0b311cc39', 'new-real-assistant-uuid'],
      ['4652fd61-a4df-411a-87e7-000000000001', 'new-real-assistant-uuid'],
    ]));
    expect((txCall!.args as { legacyTranscriptParentUuids: string[] }).legacyTranscriptParentUuids)
      .toContain('4652fd61-a4df-411a-87e7-000000000001');
  });

  it('assistant target (claude): repairs legacy imported parentUuid using the transcript index', async () => {
    await writeClaudeJsonl('sdk-uuid-source', '/work', [
      {
        type: 'assistant',
        uuid: 'legacy-subagent-assistant-uuid',
        parent_uuid: 'legacy-subagent-transcript-parent',
        parent_tool_use_id: 'toolu_real_parent',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_legacy_subagent', content: [{ type: 'text', text: 'subagent' }] },
      },
      {
        type: 'assistant',
        uuid: 'real-imported-assistant-uuid',
        parentUuid: 'preceding-user-record',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_imported_real', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    const target = makeMessageRow({
      id: 'asst-imported',
      clientId: 'asst-imported-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({
        uuid: 'real-imported-assistant-uuid',
        parentUuid: 'preceding-user-record',
        requestId: 'msg_imported_real',
      }),
      createdAt: 2500,
    });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });
    const legacySubagent = makeMessageRow({
      id: 'legacy-subagent',
      role: 'assistant',
      agentMeta: JSON.stringify({
        uuid: 'legacy-subagent-assistant-uuid',
        parentUuid: 'legacy-subagent-transcript-parent',
      }),
      createdAt: 2250,
    });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);
    selectQueue.push([]);
    selectQueue.push([priorUser, legacySubagent, target]);
    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'asst-imported-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'real-imported-assistant-uuid',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txCall = txCalls.find((call) => call.name === 'fork.session');
    expect(txCall?.args).toMatchObject({
      legacyTranscriptParentUuids: [
        'legacy-subagent-assistant-uuid',
        'real-imported-assistant-uuid',
      ],
    });
  });

  it('claude path: locates JSONL under XDT_USER_DATA_DIR claude-home when main env has no CLAUDE_CONFIG_DIR', async () => {
    const userDataDir = await fs.mkdtemp(path.join(os.tmpdir(), 'xdt-user-data-'));
    tempDirs.push(userDataDir);
    delete process.env.CLAUDE_CONFIG_DIR;
    process.env.XDT_USER_DATA_DIR = userDataDir;
    await writeClaudeJsonlInConfigDir(path.join(userDataDir, 'claude-home'), 'sdk-uuid-source', '/work', [
      {
        type: 'assistant',
        uuid: 'isolated-real-assistant-uuid',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_isolated_real', content: [{ type: 'text', text: 'hi' }] },
      },
    ]);
    const target = makeMessageRow({
      id: 'asst-isolated',
      clientId: 'asst-isolated-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({
        uuid: '4652fd61-a4df-411a-87e7-000000000003',
        requestId: 'msg_isolated_real',
      }),
      createdAt: 2500,
    });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);
    selectQueue.push([]);
    selectQueue.push([priorUser, target]);
    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'asst-isolated-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'isolated-real-assistant-uuid',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
  });

  it('user target (claude): skips sourceToolAssistantUUID-only tool assistant anchors', async () => {
    await writeClaudeJsonl('sdk-uuid-source', '/work', [
      {
        type: 'assistant',
        uuid: 'top-level-assistant-uuid',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_top_level', content: [{ type: 'text', text: 'hi' }] },
      },
      {
        type: 'assistant',
        uuid: 'tool-assistant-uuid',
        sourceToolAssistantUUID: 'top-level-assistant-uuid',
        sessionId: 'sdk-uuid-source',
        message: { id: 'msg_tool_assistant', content: [{ type: 'text', text: 'tool' }] },
      },
    ]);
    const target = makeMessageRow({ id: 'target-user', role: 'user', createdAt: 3000 });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });
    const topAssistant = makeMessageRow({
      id: 'asst-top',
      clientId: 'asst-top-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({ uuid: 'top-level-assistant-uuid', requestId: 'msg_top_level' }),
      createdAt: 2300,
    });
    const toolAssistant = makeMessageRow({
      id: 'asst-tool',
      clientId: 'asst-tool-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({
        uuid: '4652fd61-a4df-411a-87e7-000000000002',
        requestId: 'msg_tool_assistant',
        parentUuid: 'top-level-assistant-uuid',
      }),
      createdAt: 2500,
    });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);
    selectQueue.push([priorUser, topAssistant, toolAssistant]);
    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'client-id');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'top-level-assistant-uuid',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txCall = txCalls.find((call) => call.name === 'fork.session');
    expect(((txCall?.args as { legacyTranscriptParentUuids?: string[] }).legacyTranscriptParentUuids ?? []))
      .not.toContain('4652fd61-a4df-411a-87e7-000000000002');
  });

  it('assistant target at session tail (claude): no next user → copies everything', async () => {
    const target = makeMessageRow({
      id: 'asst-last',
      clientId: 'asst-last-cid',
      role: 'assistant',
      agentMeta: JSON.stringify({ uuid: 'uuid-last' }),
      createdAt: 2500,
    });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });

    selectQueue.push([makeSourceRow()]);          // source
    selectQueue.push([target]);                   // target
    selectQueue.push([]);                         // no next user
    selectQueue.push([priorUser, target]);        // bulk copy = 全部
    selectQueue.push([makeSourceRow({ sdkSessionId: 'sdk-new-session-uuid' })]);

    await forkSessionAtMessage('src-session', 'asst-last-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('claude-code', {
      sourceSdkSessionId: 'sdk-uuid-source',
      upToMessageId: 'uuid-last',
      title: '[Fork] Project A',
      workingDir: '/work',
    });
    const txCall = txCalls.find((c) => c.name === 'fork.session');
    const txArgs = txCall!.args as { targetCreatedAt: number };
    // 无边界 → MAX_SAFE_INTEGER, lt 谓词放行所有行 (= 复制全部)
    expect(txArgs.targetCreatedAt).toBe(Number.MAX_SAFE_INTEGER);
  });

  it("assistant target (codex): drops only user turns after the reply's turn", async () => {
    const target = makeMessageRow({
      id: 'asst-codex',
      clientId: 'asst-codex-cid',
      role: 'assistant',
      createdAt: 2500,
    });
    const nextUser = makeMessageRow({ id: 'user-next', role: 'user', createdAt: 3000 });
    const priorUser = makeMessageRow({ id: 'user-1', role: 'user', createdAt: 2000 });

    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'codex-thread-source',
    })]);
    selectQueue.push([target]);
    selectQueue.push([nextUser]);                 // next user after target
    selectQueue.push([priorUser, target]);        // bulk copy (含 target 所在 turn)
    selectQueue.push([makeSourceRow({
      agentKind: 'codex',
      sdkSessionId: 'codex-thread-new',
    })]);

    forkSdkSessionMock.mockResolvedValue({
      newSdkSessionId: 'codex-thread-new',
      uuidMap: new Map<string, string>(),
    });
    queryMock.mockResolvedValue([{ role: 'user', content: '"next"' }]);

    await forkSessionAtMessage('src-session', 'asst-codex-cid');

    expect(forkSdkSessionMock).toHaveBeenCalledWith('codex', {
      sourceSdkSessionId: 'codex-thread-source',
      model: 'claude-sonnet-4-6',
      providerId: 'xd',
      upToMessageId: undefined,
      tailTurnsToDrop: 1,
      title: '[Fork] Project A',
      workingDir: '/work',
    });
  });

  it('rejects tool_use target with NOT_USER_MESSAGE; maker not invoked', async () => {
    const target = makeMessageRow({ id: 'tool-1', role: 'tool_use', createdAt: 2500 });

    selectQueue.push([makeSourceRow()]);
    selectQueue.push([target]);

    await expect(
      forkSessionAtMessage('src-session', 'tool-1'),
    ).rejects.toMatchObject({ code: 'NOT_USER_MESSAGE' });

    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });

  it('throws NO_PRIOR_ASSISTANT when target user msg has no preceding assistant with uuid', async () => {
    const target = makeMessageRow({ id: 'first-user', role: 'user', createdAt: 1500 });

    selectQueue.push([makeSourceRow()]); // source
    selectQueue.push([target]);          // target
    selectQueue.push([]);                // prior assistants — empty

    await expect(
      forkSessionAtMessage('src-session', 'first-user'),
    ).rejects.toMatchObject({ code: 'NO_PRIOR_ASSISTANT' });

    expect(forkSdkSessionMock).not.toHaveBeenCalled();
    expect(txCalls).toHaveLength(0);
  });
});
