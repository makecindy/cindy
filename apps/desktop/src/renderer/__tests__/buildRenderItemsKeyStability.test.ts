/**
 * buildRenderItemsKeyStability.test.ts
 * ---------------------------------------------------------------------------
 * 锁住 buildRenderItems 在以下场景下的 stable key 行为 —— render-window 把锚点从
 * `firstVisibleClientId` 下移到 `firstVisibleItemKey` 后,key 的稳定性直接决定
 * 滚动锚点是否会漂走 / 卡片是否会 unmount 丢折叠态。任何派生 key 的规则变更
 * 都必须先 break 这些用例。
 *
 * 同时锁住"渲染窗口下移到 render-item 轴"的关键不变量:`allRenderItems` 末尾
 * 永远是有效 item(不会是被丢弃的 ask_user / AskUserQuestion / ExitPlanMode /
 * orphan tool_result),所以默认窗口 `slice(-INITIAL_ITEMS)` 必然产出非空
 * `visibleRenderItems`,U2 同源死锁 bug 在 item 轴下不可能复现。
 *
 * 测试环境用默认 'node' —— buildRenderItems 是纯函数,MessageStream.tsx 模块
 * 加载即便有 React/component 依赖也不应触发 DOM 调用(同款 pattern 见
 * prevMessageJumpChip.test.ts —— 直接 import 组件里的 pure helper)。
 */

import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
import {
  assistantHasFollowingUserBoundary,
  buildRenderItems,
  collectStableLocalFileRefs,
  collectTurnFinalAssistantClientIds,
  findRestorableViewportItemIdx,
  groupWorkRuns,
  insertForkOriginItem,
  shouldBlockAssistantFork,
  type RenderItem,
} from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { TurnChangeSetSummary } from '../../shared/turnChangeSet';

// ── 工厂 / 用例构造工具 ────────────────────────────────────────────────────

const mkUser = (id: string, content = '...', files?: ChatMessage['files']): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
  ...(files ? { files } : {}),
});

const mkAssistant = (id: string, content = 'ok'): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
});

const mkCompactBoundary = (id: string): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content: '',
  systemCardType: 'compact',
  systemCardData: {
    trigger: 'auto',
    preTokens: 100,
    postTokens: 20,
    durationMs: 1000,
  },
});

const mkTool = (id: string, toolName: string, toolInput: unknown = {}): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

const mkResult = (id: string, toolUseId: string, content = 'result'): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content,
  toolUseId,
});

const mkFileRef = (name: string): NonNullable<ChatMessage['files']>[number] => ({
  name,
  path: join('repo', name),
});

const mkAskUser = (id: string): ChatMessage => ({
  clientId: id,
  role: 'ask_user',
  content: '',
});

const mkDatedMessageItem = (id: string, createdAt: string): RenderItem => ({
  type: 'message',
  key: `msg-${id}`,
  message: {
    clientId: id,
    role: 'user',
    content: id,
    createdAt,
  },
});

const mkAnsweredAskUser = (id: string): ChatMessage => ({
  clientId: id,
  role: 'ask_user',
  content: '',
  askUserStatus: 'answered',
  askUserRequestId: `req-${id}`,
  askUserQuestions: [{ question: 'Pick one', options: [] }],
  askUserAnswers: { 'Pick one': 'Option A' },
});

const todoInput = (items: Array<{ content: string; status: 'pending' | 'in_progress' | 'completed' }>) => ({
  todos: items.map((t, idx) => ({
    content: t.content,
    status: t.status,
    activeForm: t.content,
    id: `t${idx}`,
  })),
});

describe('assistant fork boundary detection', () => {
  it('allows assistant fork only after the turn has a following user boundary', () => {
    const messages = [
      mkUser('u1'),
      mkAssistant('a1'),
      mkTool('t1', 'Bash'),
      mkUser('u2'),
      mkAssistant('a2'),
      mkTool('t2', 'Read'),
    ];

    expect(assistantHasFollowingUserBoundary(messages, 'a1')).toBe(true);
    expect(assistantHasFollowingUserBoundary(messages, 'a2')).toBe(false);
  });

  it('does not treat same-turn steer messages as assistant fork boundaries', () => {
    const steer: ChatMessage = { ...mkUser('steer'), delivery: 'steer' };
    const messages = [
      mkUser('u1'),
      mkAssistant('a1'),
      mkTool('t1', 'Bash'),
      steer,
      mkTool('t2', 'Read'),
    ];

    expect(assistantHasFollowingUserBoundary(messages, 'a1')).toBe(false);
  });

  it('blocks assistant forks in active work-group children without a following user boundary', () => {
    const messages = [
      mkUser('u1'),
      mkAssistant('a-draft'),
      mkTool('t1', 'Bash'),
      mkAssistant('a-final'),
    ];
    const boundarySet = new Set(
      messages
        .filter((m) => m.role === 'assistant' && assistantHasFollowingUserBoundary(messages, m.clientId))
        .map((m) => m.clientId),
    );

    expect(shouldBlockAssistantFork(true, messages[1], boundarySet)).toBe(true);
    expect(shouldBlockAssistantFork(true, messages[3], boundarySet)).toBe(true);
    expect(shouldBlockAssistantFork(false, messages[1], boundarySet)).toBe(false);
  });
});

// ── turn 收尾正文检测(action bar 只挂每个 turn 的最后一条 assistant 正文)──

describe('collectTurnFinalAssistantClientIds', () => {
  it('marks only the last assistant text of each user turn', () => {
    const messages = [
      mkUser('u1'),
      mkAssistant('a1-draft'),
      mkTool('t1', 'Bash'),
      mkAssistant('a1-final'),
      mkUser('u2'),
      mkAssistant('a2-draft'),
      mkAssistant('a2-final'),
    ];

    const finals = collectTurnFinalAssistantClientIds(messages);
    expect(finals.has('a1-final')).toBe(true);
    expect(finals.has('a2-final')).toBe(true);
    expect(finals.has('a1-draft')).toBe(false);
    expect(finals.has('a2-draft')).toBe(false);
  });

  it('marks every sealed SDK turn when background work auto-continues without a user boundary', () => {
    const messages = [
      mkUser('u1'),
      { ...mkAssistant('main-summary'), turnCompleted: true },
      mkTool('gate', 'Bash'),
      { ...mkAssistant('gate-followup'), turnCompleted: true },
    ];

    const finals = collectTurnFinalAssistantClientIds(messages);
    expect([...finals]).toEqual(expect.arrayContaining(['main-summary', 'gate-followup']));
    expect(finals.size).toBe(2);
  });

  it('does not add an unsealed progress message once the user turn contains sealed answers', () => {
    const messages = [
      mkUser('u1'),
      { ...mkAssistant('main-summary'), turnCompleted: true },
      mkAssistant('unsealed-progress'),
      { ...mkAssistant('gate-followup'), turnCompleted: true },
    ];

    const finals = collectTurnFinalAssistantClientIds(messages);
    expect([...finals]).toEqual(expect.arrayContaining(['main-summary', 'gate-followup']));
    expect(finals.has('unsealed-progress')).toBe(false);
  });

  it('does not treat steer messages as turn boundaries', () => {
    const steer: ChatMessage = { ...mkUser('steer'), delivery: 'steer' };
    const messages = [
      mkUser('u1'),
      mkAssistant('a1'),
      steer,
      mkAssistant('a2'),
    ];

    const finals = collectTurnFinalAssistantClientIds(messages);
    // steer 不切 turn:a1/a2 同属一个 turn,只有 a2 是收尾正文。
    expect(finals.has('a2')).toBe(true);
    expect(finals.has('a1')).toBe(false);
  });

  it('skips system cards and empty texts when picking the turn final', () => {
    const systemCard: ChatMessage = {
      ...mkAssistant('a-card'),
      systemCardType: 'status',
    };
    const messages = [
      mkUser('u1'),
      mkAssistant('a-text'),
      systemCard,
      mkAssistant('a-empty', '   '),
    ];

    const finals = collectTurnFinalAssistantClientIds(messages);
    expect(finals.has('a-text')).toBe(true);
    expect(finals.has('a-card')).toBe(false);
    expect(finals.has('a-empty')).toBe(false);
  });

  it('returns nothing for turns without assistant text', () => {
    const messages = [mkUser('u1'), mkTool('t1', 'Bash')];
    expect(collectTurnFinalAssistantClientIds(messages).size).toBe(0);
  });

  it('combined with fork gate: tail-turn final shows bar only after streaming ends', () => {
    const messages = [
      mkUser('u1'),
      mkAssistant('a-mid'),
      mkTool('t1', 'Bash'),
      mkAssistant('a-final'),
    ];
    const finals = collectTurnFinalAssistantClientIds(messages);
    const boundarySet = new Set<string>(); // 尾部 turn,无后续 user 边界

    // MessageItem 的挂载条件:isTurnFinal && !shouldBlockAssistantFork(...)。
    const showBar = (m: ChatMessage, streaming: boolean) =>
      finals.has(m.clientId) && !shouldBlockAssistantFork(streaming, m, boundarySet);

    // 任务执行中(流式):所有句子都不出现操作行。
    expect(showBar(messages[1], true)).toBe(false);
    expect(showBar(messages[3], true)).toBe(false);
    // 任务结束:只有收尾正文出现。
    expect(showBar(messages[1], false)).toBe(false);
    expect(showBar(messages[3], false)).toBe(true);
  });
});

// ── case 1: 流式追加 token 不改变 message item key ────────────────────────

describe('buildRenderItems — key stability', () => {
  it('anchors exact change sets to the owning visible user turn', () => {
    const firstUser = mkUser('u1');
    const secondUser = mkUser('u2');
    const firstSet: TurnChangeSetSummary = {
      id: 'cs1',
      sessionId: 's1',
      anchorClientId: 'u1',
      provider: 'codex',
      providerTurnId: 'turn-1',
      cwd: 'C:/work',
      state: 'complete',
      workspaceState: 'applied',
      isReversible: true,
      incompleteReasons: [],
      createdAt: 1,
      completedAt: 2,
      files: [{
        id: 'turn-1:a.ts',
        path: 'a.ts',
        oldPath: null,
        status: 'modified',
        additions: 2,
        deletions: 1,
      }],
      fileCount: 1,
      additions: 2,
      deletions: 1,
    };
    const secondSet = {
      ...firstSet,
      id: 'cs2',
      anchorClientId: 'u2',
      providerTurnId: 'turn-2',
      createdAt: 3,
      completedAt: 4,
    };

    const { items } = buildRenderItems(
      [firstUser, mkAssistant('a1'), secondUser, mkAssistant('a2')],
      undefined,
      undefined,
      { turnChangeSets: [firstSet, secondSet] },
    );
    const cards = items.filter(
      (item): item is Extract<RenderItem, { type: 'turn_changes' }> => item.type === 'turn_changes',
    );

    expect(cards.map((card) => card.key)).toEqual(['turnchanges-cs1', 'turnchanges-cs2']);
    expect(cards.map((card) => card.changeSet.id)).toEqual(['cs1', 'cs2']);
    expect(items.indexOf(cards[0])).toBeGreaterThan(items.findIndex((item) => item.key === 'msg-a1'));
  });

  it('hides all zero-file change cards because they have no reviewable content', () => {
    const base: TurnChangeSetSummary = {
      id: 'cs-base',
      sessionId: 's1',
      anchorClientId: 'u1',
      provider: 'claude-code',
      providerTurnId: null,
      cwd: 'C:/work',
      state: 'partial',
      workspaceState: 'applied',
      isReversible: false,
      incompleteReasons: [],
      createdAt: 1,
      completedAt: 2,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    };
    const opaque: TurnChangeSetSummary = {
      ...base,
      id: 'cs-noise',
      incompleteReasons: ['opaque-tool', 'turn-failed', 'concurrent-workspace'],
    };
    const truncated: TurnChangeSetSummary = {
      ...base,
      id: 'cs-too-large',
      incompleteReasons: ['opaque-tool', 'diff-too-large'],
      createdAt: 3,
      completedAt: 4,
    };
    const escaped: TurnChangeSetSummary = {
      ...base,
      id: 'cs-escape',
      incompleteReasons: ['outside-workspace'],
      createdAt: 5,
      completedAt: 6,
    };

    const { items } = buildRenderItems(
      [mkUser('u1'), mkAssistant('a1'), mkUser('u2')],
      undefined,
      undefined,
      { turnChangeSets: [opaque, truncated, escaped] },
    );
    const cards = items.filter(
      (item): item is Extract<RenderItem, { type: 'turn_changes' }> => item.type === 'turn_changes',
    );
    expect(cards).toEqual([]);
  });

  it('keeps opaque command artifacts as fallback chips without duplicating exact files', () => {
    const messages = [
      mkUser('u1'),
      mkTool('bash-1', 'Bash', { command: 'python gen.py > C:/work/out/report.xlsx' }),
      mkResult('bash-result', 'tu-bash-1'),
      mkUser('u2'),
    ];
    const exact: TurnChangeSetSummary = {
      id: 'cs-opaque',
      sessionId: 's1',
      anchorClientId: 'u1',
      provider: 'codex',
      providerTurnId: 'turn-1',
      cwd: 'C:/work',
      state: 'partial',
      workspaceState: 'applied',
      isReversible: false,
      incompleteReasons: ['opaque-tool'],
      createdAt: 1,
      completedAt: 2,
      files: [],
      fileCount: 0,
      additions: 0,
      deletions: 0,
    };
    const fallback = buildRenderItems(messages, undefined, undefined, {
      workingDir: 'C:/work',
      turnChangeSets: [exact],
    }).items.filter((item): item is Extract<RenderItem, { type: 'generated_files' }> => item.type === 'generated_files');
    expect(fallback).toHaveLength(1);
    expect(fallback[0]?.files[0]?.name).toBe('report.xlsx');

    const exactFile = {
      ...exact,
      files: [{
        id: 'turn-1:out/report.xlsx',
        path: 'out/report.xlsx',
        oldPath: null,
        status: 'added' as const,
        additions: 1,
        deletions: 0,
      }],
      fileCount: 1,
      additions: 1,
    };
    const deduped = buildRenderItems(messages, undefined, undefined, {
      workingDir: 'C:/work',
      turnChangeSets: [exactFile],
    }).items.filter((item): item is Extract<RenderItem, { type: 'generated_files' }> => item.type === 'generated_files');
    expect(deduped).toHaveLength(0);
  });

  it('streaming token append to an assistant message keeps the same item key', () => {
    const m1: ChatMessage = { ...mkAssistant('a1', 'partial'), isStreaming: true };
    const before = buildRenderItems([mkUser('u1'), m1]);

    const m1Updated: ChatMessage = { ...m1, content: 'partial token2' };
    const after = buildRenderItems([mkUser('u1'), m1Updated]);

    expect(before.items.at(-1)?.key).toBe('msg-a1');
    expect(after.items.at(-1)?.key).toBe('msg-a1');
  });

  // ── case 2: 同 segment 内新 tool_use 加入不改变 segment key ─────────────

  it('new tool_use appended to existing segment keeps segment key stable (toolCalls[0] unchanged)', () => {
    const before = buildRenderItems([mkUser('u1'), mkTool('t1', 'Bash')]);
    const after = buildRenderItems([mkUser('u1'), mkTool('t1', 'Bash'), mkTool('t2', 'Read')]);

    const beforeSeg = before.items.find((it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment');
    const afterSeg = after.items.find((it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment');

    expect(beforeSeg?.key).toBe('seg-t1');
    expect(afterSeg?.key).toBe('seg-t1');
    expect(afterSeg?.toolCalls.length).toBe(2);
  });

  it('agent task tools render as dedicated task items instead of joining tool segments', () => {
    const task = mkTool('task1', 'Agent', { description: 'Review auth flow', prompt: 'Check auth' });
    const bash = mkTool('bash1', 'Bash');
    const updates = new Map([
      [
        'tu-task1',
        {
          provider: 'claude-code' as const,
          taskId: 'task-1',
          parentToolUseId: 'tu-task1',
          status: 'running' as const,
          title: 'Review auth flow',
        },
      ],
    ]);

    const { items } = buildRenderItems([mkUser('u1'), task, mkResult('r1', 'tu-task1', 'done'), bash], updates);

    expect(items.map((it) => it.type)).toEqual(['message', 'agent_task', 'tool_segment']);
    const taskItem = items[1] as Extract<RenderItem, { type: 'agent_task' }>;
    expect(taskItem.key).toBe('task-task1');
    expect(taskItem.update?.status).toBe('running');
    expect(taskItem.result).toBe('done');
    const segment = items[2] as Extract<RenderItem, { type: 'tool_segment' }>;
    expect(segment.toolCalls.map((m) => m.clientId)).toEqual(['bash1']);
  });

  it('agent task tools preserve adjacent legacy results without toolUseId', () => {
    const task: ChatMessage = {
      ...mkTool('task1', 'Agent', { description: 'Review auth flow', prompt: 'Check auth' }),
      toolUseId: undefined,
    };
    const legacyResult: ChatMessage = {
      clientId: 'r1',
      role: 'tool_result',
      content: 'legacy task summary',
    };

    const { items } = buildRenderItems([mkUser('u1'), task, legacyResult]);

    expect(items.map((it) => it.type)).toEqual(['message', 'agent_task']);
    const taskItem = items[1] as Extract<RenderItem, { type: 'agent_task' }>;
    expect(taskItem.result).toBe('legacy task summary');
  });

  it('agent task updates without a matching tool_use still render as task items', () => {
    const updates = new Map([
      [
        'task-1',
        {
          provider: 'claude-code' as const,
          taskId: 'task-1',
          status: 'completed' as const,
          title: 'Inspect files',
          summary: 'Found the relevant renderer path',
          createdAt: '2026-06-24T00:00:02.000Z',
        },
      ],
    ]);

    const { items } = buildRenderItems([
      { ...mkUser('u1'), createdAt: '2026-06-24T00:00:01.000Z' },
      { ...mkAssistant('a1', 'done'), createdAt: '2026-06-24T00:00:03.000Z' },
    ], updates);

    expect(items.map((it) => it.type)).toEqual(['message', 'agent_task', 'message']);
    const taskItem = items[1] as Extract<RenderItem, { type: 'agent_task' }>;
    expect(taskItem.key).toBe('task-update-task-1');
    expect(taskItem.toolCall).toBeUndefined();
    expect(taskItem.update?.summary).toBe('Found the relevant renderer path');
  });

  // ── case 3: plan 工具调用被整体吞掉 —— 流内不再渲染计划卡 ────────────────
  // 计划的唯一呈现是 composer 上方的 PinnedPlanPanel(Codex IDE 扩展式钉住面板)。
  // session 分组 / 输入解析语义的覆盖在 @cindy/maker-shared 的 messageRender.test.ts;
  // 这里只锁桌面流内行为:不产 item、不切段、结尾不留无效 tail。

  it('plan tool calls are swallowed without splitting the surrounding tool segment', () => {
    const seq: ChatMessage[] = [
      mkUser('u1'),
      mkTool('t1', 'Bash'),
      mkTool('tw1', 'TodoWrite', todoInput([{ content: 'a', status: 'pending' }])),
      mkResult('r-tw1', 'tu-tw1', 'ok'),
      mkTool('t2', 'Read'),
      mkAssistant('a1', 'done'),
    ];
    const { items } = buildRenderItems(seq);

    // TodoWrite 及其 tool_result 如同不存在:t1 / t2 仍聚在同一段里。
    expect(items.map((it) => it.type)).toEqual(['message', 'tool_segment', 'message']);
    const seg = items[1] as Extract<RenderItem, { type: 'tool_segment' }>;
    expect(seg.key).toBe('seg-t1');
    expect(seg.toolCalls.map((tc) => tc.clientId)).toEqual(['t1', 't2']);
  });

  it('update_plan and Task* plan calls likewise produce no render items', () => {
    const plan = mkTool('plan1', 'update_plan', {
      plan: [{ step: 'Read code', status: 'in_progress' }],
    });
    const taskCreate = mkTool('tc1', 'TaskCreate', { subject: 'Collect logs' });

    const { items } = buildRenderItems([mkUser('u1'), plan, taskCreate, mkAssistant('a1', 'On it')]);

    expect(items.map((it) => it.type)).toEqual(['message', 'message']);
  });

  it('a trailing plan call keeps the tail invariant on the previous valid item', () => {
    const { items } = buildRenderItems([
      mkUser('u1'),
      mkTool('tw1', 'TodoWrite', todoInput([{ content: 'a', status: 'pending' }])),
      mkResult('r-tw1', 'tu-tw1', 'ok'),
    ]);

    expect(items.map((it) => it.type)).toEqual(['message']);
  });

  // ── case 4: orphan tool_result 补到末尾不产生新 item / 不重 key ─────────

  it('orphan tool_result appended to tail does not introduce a new item or duplicate key', () => {
    const tu = mkTool('t1', 'Bash');
    const before = buildRenderItems([mkUser('u1'), tu]);
    const orphan = mkResult('r-late', 'tu-t1', 'late result');
    const after = buildRenderItems([mkUser('u1'), tu, orphan]);

    // item count 不变 —— orphan tool_result 在 Pass 2 被 skip,只是把 result 灌入
    // 已有 segment 的 resultMap (主路径走 resultByToolUseId)。
    expect(after.items.length).toBe(before.items.length);
    const afterSeg = after.items.find((it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment');
    expect(afterSeg?.key).toBe('seg-t1');
    expect(afterSeg?.resultMap.get('t1')).toBe('late result');
  });

  // ── case 5: tool_segment 关闭后再开新 segment,两个 key 不同 ────────────

  it('two tool_segments separated by text get two distinct keys', () => {
    const seq: ChatMessage[] = [
      mkUser('u1'),
      mkTool('t1', 'Bash'),
      mkAssistant('a1'), // 关闭 segment 1
      mkTool('t2', 'Read'), // 开 segment 2
    ];
    const { items } = buildRenderItems(seq);
    const segs = items.filter((it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment');
    expect(segs.length).toBe(2);
    expect(segs[0].key).toBe('seg-t1');
    expect(segs[1].key).toBe('seg-t2');
    expect(segs[0].key).not.toBe(segs[1].key);
  });

  // ── case 6: tool_media key 显式锁规则 (`media-${segment 首 toolCall id}`) ────
  // 防御:tool_media 跟其派生来源 segment 共享首 toolCall id,只是 prefix 不同 —
  // 任何 key 派生规则的退化(例如改成 `media-${url}`)都会让 result 流式后到时
  // 强制 unmount 卡片。

  // ── case 5c: DB prepend 让 tool_segment 向前合并,老 key 失效但 toolCall 仍在新段内 ──
  // 模拟用户卡死场景的核心数据形态(完整恢复逻辑在 MessageStream 的 visibleRenderItems
  // useMemo / expandWindow 里通过 recoverLostAnchorIdx 走;这里锁住 buildRenderItems
  // 产出的真实数据满足 recover 前提:老 toolCall 仍在新段的 toolCalls 数组里)。

  it('after DB prepend ends with tool_use, old segment toolCalls[0] changes BUT the old toolCall still exists in new segment', () => {
    // 现有数据:已加载的最早消息恰好是 tool_use 开头(没有前置 assistant/user)
    const beforePrepend: ChatMessage[] = [mkTool('t1', 'Bash'), mkTool('t2', 'Read')];
    const beforeItems = buildRenderItems(beforePrepend).items;
    const oldSegment = beforeItems.find(
      (it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment',
    );
    expect(oldSegment?.key).toBe('seg-t1');

    // DB prepend:返回的更老消息末尾又是 tool_use(无 boundary message 分隔)
    const prepended: ChatMessage[] = [mkAssistant('a-pre', 'pre'), mkTool('t0-older', 'Edit')];
    const afterPrepend = [...prepended, ...beforePrepend];
    const afterItems = buildRenderItems(afterPrepend).items;

    // 新段把 t0-older 一起吸进来,key 变成 seg-t0-older
    const newSegment = afterItems.find(
      (it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment',
    );
    expect(newSegment?.key).toBe('seg-t0-older');
    expect(newSegment?.key).not.toBe(oldSegment?.key); // 老 key 失效 — 这是 bug 触发条件

    // 关键不变量:老 toolCall t1 仍在新段的 toolCalls 数组里 — recover 函数靠这点
    // 反解 lost key 后能找回 anchor。
    expect(newSegment?.toolCalls.some((tc) => tc.clientId === 't1')).toBe(true);
    expect(newSegment?.toolCalls.some((tc) => tc.clientId === 't2')).toBe(true);
  });

  it('tool_media key derives from segment first toolCall id (stable, separate prefix from segment)', () => {
    // image_generate 工具产出带 xdt_image_url 的 tool_result — extractToolResultMedia
    // 期待合法 JSON + `xdt-image://` 协议前缀。
    const tu = mkTool('img1', 'image_generate');
    const tr = mkResult(
      'imgr1',
      'tu-img1',
      JSON.stringify({ xdt_image_url: 'xdt-image://art/abc.png' }),
    );
    const { items } = buildRenderItems([mkUser('u1'), tu, tr, mkAssistant('a1')]);
    const seg = items.find((it): it is Extract<RenderItem, { type: 'tool_segment' }> => it.type === 'tool_segment');
    const media = items.find((it): it is Extract<RenderItem, { type: 'tool_media' }> => it.type === 'tool_media');
    expect(seg?.key).toBe('seg-img1');
    expect(media?.key).toBe('media-img1');
    // 同源不同 prefix —— 不会撞 key
    expect(seg?.key).not.toBe(media?.key);
  });

  // ── case 7: 末尾混合丢弃类型 + 有效 message,末尾仍是有效 item ──────────
  // 锁住"删自愈 effect 安全"的论证:渲染窗口下移到 item 轴后,allRenderItems
  // 末尾永远是有效 item,U2 "末尾窗口全 orphan / 全被丢弃" 死锁不可能复现。

  it('tail of allRenderItems is never a dropped type (ask_user / AskUserQuestion / orphan tool_result)', () => {
    const askUserTool = mkTool('aq1', 'AskUserQuestion');
    const askUserResult = mkResult('aqr1', 'tu-aq1');
    const orphanResult = mkResult('orphan1', 'tu-does-not-exist');

    const seq: ChatMessage[] = [
      mkUser('u1'),
      mkAssistant('a1'),
      askUserTool, // 丢弃
      askUserResult, // 跟着被吃
      mkAskUser('ask-msg-1'), // 丢弃
      mkAssistant('a2', 'final valid message'),
      mkAskUser('ask-msg-2'), // 丢弃
      orphanResult, // 丢弃(orphan)
    ];

    const { items } = buildRenderItems(seq);
    // 末尾必须是有效 message item — 不是 ask_user / orphan
    const tail = items.at(-1);
    if (tail?.type !== 'message') {
      throw new Error('tail render item must be a message');
    }
    expect(tail.message.role).toBe('assistant');
    expect(tail.message.clientId).toBe('a2');
  });

  // ── case 8: answered ask_user 进消息流(用户选择回显),pending/未答仍被丢弃 ──
  // 锁住"只过滤未回答的 ask_user"这条规则:回答完的 ask_user 必须以 message item
  // 进流(由 AskUserQuestionBubble 渲染成用户回复气泡),而 undefined/pending 态
  // 仍然被丢弃(留在底部 overlay)。

  it('answered ask_user becomes a message item; undefined-status ask_user stays dropped', () => {
    const seq: ChatMessage[] = [
      mkUser('u1'),
      mkAskUser('pending-1'), // 未答 → 丢弃
      mkAnsweredAskUser('answered-1'), // 已答 → 进流
      mkAssistant('a1', 'next step'),
    ];
    const { items } = buildRenderItems(seq);

    const answered = items.find(
      (it): it is Extract<RenderItem, { type: 'message' }> =>
        it.type === 'message' && it.message.clientId === 'answered-1',
    );
    if (!answered) {
      throw new Error('answered ask_user render item not found');
    }
    expect(answered.message.role).toBe('ask_user');
    expect(answered.key).toBe('msg-answered-1');

    // 未答的那条不产生任何 item
    expect(
      items.some((it) => it.type === 'message' && it.message.clientId === 'pending-1'),
    ).toBe(false);
  });
});

// ── groupWorkRuns — 工作过程折叠组 ─────────────────────────────────────────

describe('groupWorkRuns — work-group collapsing', () => {
  const mkThinking = (id: string, createdAt?: string): ChatMessage => ({
    clientId: id,
    role: 'thinking',
    content: 'reasoning...',
    isStreaming: false,
    thinkingDurationMs: 1000,
    ...(createdAt ? { createdAt } : {}),
  });

  const withTs = (m: ChatMessage, iso: string): ChatMessage => ({ ...m, createdAt: iso });

  const build = (
    messages: ChatMessage[],
    streaming: boolean,
    taskUpdates?: Parameters<typeof buildRenderItems>[1],
  ) => groupWorkRuns(buildRenderItems(messages, taskUpdates).items, streaming);

  it('marks a run complete as soon as assistant text follows, even while the turn streams', () => {
    const items = build(
      [mkUser('u1'), mkThinking('th1'), mkTool('t1', 'Bash'), mkAssistant('a1', 'done')],
      true,
    );
    // u1 message, work_group, a1 message
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-th1'); // 首子项(thinking)的 clientId
    expect(group.children.map((c) => c.type)).toEqual(['message', 'tool_segment']);
    expect(group.isStreaming).toBe(false);
  });

  it('groups the trailing run immediately while streaming and keeps live metadata', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a1', 'working on it'),
        withTs(mkTool('t1', 'Bash'), '2026-06-24T00:00:02.000Z'),
        mkThinking('th1'),
      ],
      true,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'message', 'work_group']);
    const group = items[2] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-t1');
    expect(group.isStreaming).toBe(true);
    expect(group.startedAtMs).toBe(Date.parse('2026-06-24T00:00:02.000Z'));
    expect(group.children.map((c) => c.type)).toEqual(['tool_segment', 'message']);
  });

  it('finishes the previous live work group at an auto-compaction boundary', () => {
    const items = build(
      [
        mkUser('u1'),
        mkTool('t-before', 'Read'),
        mkCompactBoundary('compact-1'),
        mkThinking('th-after'),
        mkTool('t-after', 'Bash'),
      ],
      true,
    );

    expect(items.map((it) => it.type)).toEqual([
      'message',
      'work_group',
      'message',
      'work_group',
    ]);
    const groups = items.filter(
      (it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group',
    );
    expect(groups.map((group) => [group.key, group.isStreaming])).toEqual([
      ['work-t-before', false],
      ['work-th-after', true],
    ]);
  });

  it('collapses the trailing run once the session stops streaming (turn end)', () => {
    const items = build(
      [mkUser('u1'), mkAssistant('a1', 'working on it'), mkTool('t1', 'Bash'), mkThinking('th1')],
      false,
    );
    // 最后一段 thinking 之后没有正文 → thinking 仍折进 work_group(只折,不外显)
    expect(items.map((it) => it.type)).toEqual(['message', 'message', 'work_group']);
    const group = items[2] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-t1');
    expect(group.isStreaming).toBe(false);
  });

  it('collapses a single-card run too (threshold = 1)', () => {
    const items = build([mkUser('u1'), mkTool('t1', 'Bash'), mkAssistant('a1', 'ok')], true);
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
  });

  it('folds agent task tool cards into the worked group before the final answer', () => {
    const task = mkTool('task1', 'Agent', { description: 'Review auth flow', prompt: 'Check auth' });
    const items = build([mkUser('u1'), task, mkResult('r1', 'tu-task1', 'done'), mkAssistant('a1', 'ok')], false);

    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-task1');
    expect(group.children.map((c) => c.type)).toEqual(['agent_task']);
  });

  it('folds orphan agent task updates into the worked group before the final answer', () => {
    const updates = new Map([
      [
        'task-1',
        {
          provider: 'claude-code' as const,
          taskId: 'task-1',
          status: 'completed' as const,
          title: 'Inspect files',
          summary: 'Found the relevant renderer path',
          createdAt: '2026-06-24T00:00:02.000Z',
          updatedAt: '2026-06-24T00:00:04.000Z',
        },
      ],
    ]);
    const items = build([
      withTs(mkUser('u1'), '2026-06-24T00:00:01.000Z'),
      withTs(mkAssistant('a1', 'done'), '2026-06-24T00:00:05.000Z'),
    ], false, updates);

    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-task-1');
    expect(group.children.map((c) => c.type)).toEqual(['agent_task']);
  });

  it('keeps assistant progress visible and uses it to close the preceding live group', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'I will inspect this first.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-final', 'The fix is done.'),
      ],
      true,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'message', 'work_group', 'message']);
    const group = items[2] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-t1');
    expect(group.children.map((c) => c.type)).toEqual(['tool_segment']);
    expect(group.isStreaming).toBe(false);
  });

  it('segments live actions at assistant text, then folds progress and actions in original order', () => {
    const activeMessages = [
      mkUser('u1'),
      mkAssistant('a-progress-1', 'I found the renderer path.'),
      mkTool('t1', 'Bash'),
      mkAssistant('a-progress-2', 'The first check passed.'),
      mkThinking('th2'),
      mkTool('t2', 'Read'),
    ];
    const active = build(activeMessages, true);
    expect(active.map((it) => it.type)).toEqual([
      'message',
      'message',
      'work_group',
      'message',
      'work_group',
    ]);
    const activeGroups = active.filter(
      (it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group',
    );
    expect(activeGroups.map((group) => [group.key, group.isStreaming])).toEqual([
      ['work-t1', false],
      ['work-th2', true],
    ]);

    const completed = build(
      [...activeMessages, mkAssistant('a-final', 'Everything is ready.')],
      false,
    );
    expect(completed.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const completedGroup = completed[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(completedGroup.key).toBe('work-summary-t1');
    expect(completedGroup.children.map((child) => child.key)).toEqual([
      'msg-a-progress-1',
      'work-t1',
      'msg-a-progress-2',
      'work-th2',
    ]);
    const nestedGroups = completedGroup.children.filter(
      (child): child is Extract<RenderItem, { type: 'work_group' }> => child.type === 'work_group',
    );
    expect(nestedGroups.map((group) => group.children.map((child) => child.key))).toEqual([
      ['seg-t1'],
      ['msg-th2', 'seg-t2'],
    ]);
    expect(completedGroup.isStreaming).toBe(false);
  });

  it('folds intermediate assistant text after streaming stops', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'I will inspect this first.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-final', 'The fix is done.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-summary-t1');
    expect(group.children.map((c) => `${c.type}:${c.key}`)).toEqual([
      'message:msg-a-draft',
      'work_group:work-t1',
    ]);
    const final = items[2] as Extract<RenderItem, { type: 'message' }>;
    expect(final.message.clientId).toBe('a-final');
  });

  it('keeps the live action-group key on the nested completed segment', () => {
    const liveMessages = [
      mkUser('u1'),
      mkAssistant('a-draft', 'I will inspect this first.'),
      mkTool('t1', 'Bash'),
    ];
    const completedMessages = [
      ...liveMessages,
      mkAssistant('a-final', 'The fix is done.'),
    ];
    const live = build(liveMessages, true).find(
      (item): item is Extract<RenderItem, { type: 'work_group' }> => item.type === 'work_group',
    );
    const completed = build(completedMessages, false).find(
      (item): item is Extract<RenderItem, { type: 'work_group' }> => item.type === 'work_group',
    );

    expect(live?.key).toBe('work-t1');
    expect(live?.isStreaming).toBe(true);
    expect(completed?.key).toBe('work-summary-t1');
    expect(completed?.isStreaming).toBe(false);
    const nested = completed?.children.find(
      (child): child is Extract<RenderItem, { type: 'work_group' }> => child.type === 'work_group',
    );
    expect(nested?.key).toBe(live?.key);
    expect(nested?.isStreaming).toBe(false);
  });

  it('restores assistant and tool anchors to the completed work group', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'I will inspect this first.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-final', 'The fix is done.'),
      ],
      false,
    );
    const visibleItems = items.slice(1);

    expect(visibleItems.map((it) => it.type)).toEqual(['work_group', 'message']);
    expect(findRestorableViewportItemIdx(visibleItems, 'msg-a-draft')).toBe(0);
    expect(findRestorableViewportItemIdx(visibleItems, 'seg-t1')).toBe(0);
  });

  it('keeps completed prior turns folded while a later turn streams', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a1-draft', 'I will inspect this first.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a1-final', 'The first fix is done.'),
        mkUser('u2'),
        mkTool('t2', 'Read'),
      ],
      true,
    );
    expect(items.map((it) => it.type)).toEqual([
      'message',
      'work_group',
      'message',
      'message',
      'work_group',
    ]);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.key).toBe('work-summary-t1');
    expect(group.children.map((c) => `${c.type}:${c.key}`)).toEqual([
      'message:msg-a1-draft',
      'work_group:work-t1',
    ]);
  });

  it('folds assistant-only progress while keeping the last answer visible', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'Progress update.'),
        mkAssistant('a-final', 'Final answer.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => c.key)).toEqual(['msg-a-draft']);
  });

  it('keeps trailing work separate when no final answer follows it', () => {
    const items = build(
      [
        mkUser('u1'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-progress', 'Still working.'),
        mkTool('t2', 'Read'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual([
      'message',
      'work_group',
      'message',
      'work_group',
    ]);
    const groups = items.filter(
      (it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group',
    );
    expect(groups.map((group) => group.key)).toEqual(['work-t1', 'work-t2']);
  });

  it('tool_media stays outside the group and does not trigger collapse by itself while streaming', () => {
    const tu = mkTool('img1', 'image_generate');
    const tr = mkResult('imgr1', 'tu-img1', JSON.stringify({ xdt_image_url: 'xdt-image://art/a.png' }));
    // 还没有正文 → live run 已进入 work_group;media 卡仍保持组外可见
    const streaming = build([mkUser('u1'), tu, tr, mkTool('t2', 'Read')], true);
    expect(streaming.map((it) => it.type)).toEqual(['message', 'work_group', 'tool_media']);
    expect((streaming[1] as Extract<RenderItem, { type: 'work_group' }>).isStreaming).toBe(true);

    // turn 结束 → segment 折叠进 work_group,media 卡留在组外可见
    const ended = build([mkUser('u1'), tu, tr, mkTool('t2', 'Read')], false);
    expect(ended.map((it) => it.type)).toEqual(['message', 'work_group', 'tool_media']);
  });

  it('keeps tool_media visible when a later final answer folds surrounding work', () => {
    const tu = mkTool('img1', 'image_generate');
    const tr = mkResult('imgr1', 'tu-img1', JSON.stringify({ xdt_image_url: 'xdt-image://art/a.png' }));
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'Generating a reference.'),
        tu,
        tr,
        mkAssistant('a-final', 'Here is the reference.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual([
      'message',
      'work_group',
      'tool_media',
      'message',
    ]);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => `${c.type}:${c.key}`)).toEqual([
      'message:msg-a-draft',
      'work_group:work-img1',
    ]);
    const media = items[2] as Extract<RenderItem, { type: 'tool_media' }>;
    expect(media.key).toBe('media-img1');
  });

  it('does not fold work across user turn boundaries', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a1-draft', 'Checking first turn.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a1-final', 'First answer.'),
        mkUser('u2'),
        mkAssistant('a2-draft', 'Checking second turn.'),
        mkTool('t2', 'Read'),
        mkAssistant('a2-final', 'Second answer.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual([
      'message',
      'work_group',
      'message',
      'message',
      'work_group',
      'message',
    ]);
    const groups = items.filter((it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group');
    expect(groups.map((g) => g.key)).toEqual(['work-summary-t1', 'work-summary-t2']);
    expect(groups[0].children.some((c) => c.type === 'work_group' && c.key === 'work-t2')).toBe(false);
  });

  it('applies final-answer folding even when the visible window starts mid-turn', () => {
    const items = build(
      [
        mkAssistant('a-visible-old', 'Visible historical answer.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-visible-final', 'Visible later answer.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual(['work_group', 'message']);
    const group = items[0] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => `${c.type}:${c.key}`)).toEqual([
      'message:msg-a-visible-old',
      'work_group:work-t1',
    ]);
  });

  it('plan calls stay absent through work-group folding (sole presentation is the pinned panel)', () => {
    const todo = mkTool('tw1', 'TodoWrite', todoInput([{ content: 'inspect', status: 'completed' }]));
    // 正文前后各放一次:两个位置都不应折出 work_group,也不应出现任何计划 item。
    const before = build([mkUser('u1'), todo, mkAssistant('a-final', 'Done.')], false);
    const after = build([mkUser('u1'), mkAssistant('a-final', 'Done.'), todo], false);
    expect(before.map((it) => it.type)).toEqual(['message', 'message']);
    expect(after.map((it) => it.type)).toEqual(['message', 'message']);
  });

  it('computes durationMs from the previous boundary (user message) to the terminating text createdAt', () => {
    const seq = [
      withTs(mkUser('u1'), '2026-06-10T10:00:00.000Z'),
      withTs(mkTool('t1', 'Bash'), '2026-06-10T10:00:05.000Z'),
      mkThinking('th1', '2026-06-10T10:00:30.000Z'),
      withTs(mkAssistant('a1', 'done'), '2026-06-10T10:02:25.000Z'),
    ];
    const items = build(seq, false);
    const group = items.find((it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group');
    // 10:00:00 → 10:02:25 = 2m25s:段起点锚上一边界(用户消息),把首个动作到达前
    // 的模型思考/延迟计入,与「正在工作…」活表口径一致(见 workGroupDurationAnchor.test)。
    expect(group?.durationMs).toBe(145_000);
  });

  it('computes each nested action duration between assistant work updates', () => {
    const items = build(
      [
        withTs(mkUser('u1'), '2026-06-10T10:00:00.000Z'),
        withTs(mkAssistant('a-progress-1', 'First update.'), '2026-06-10T10:00:01.000Z'),
        withTs(mkTool('t1', 'Bash'), '2026-06-10T10:00:02.000Z'),
        withTs(mkAssistant('a-progress-2', 'Second update.'), '2026-06-10T10:00:10.000Z'),
        withTs(mkTool('t2', 'Read'), '2026-06-10T10:00:12.000Z'),
        withTs(mkAssistant('a-final', 'Done.'), '2026-06-10T10:00:20.000Z'),
      ],
      false,
    );
    const outer = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    const nested = outer.children.filter(
      (child): child is Extract<RenderItem, { type: 'work_group' }> => child.type === 'work_group',
    );
    // 外层从上一边界(用户消息 10:00:00)到最终正文 10:00:20 = 20s;
    // 内层各段从上一句正文起表:t1 = 10:00:01→10:00:10 = 9s,t2 = 10:00:10→10:00:20 = 10s。
    expect(outer.durationMs).toBe(20_000);
    expect(nested.map((group) => [group.key, group.durationMs])).toEqual([
      ['work-t1', 9_000],
      ['work-t2', 10_000],
    ]);
  });

  it('omits durationMs when timestamps are missing (legacy history)', () => {
    const items = build([mkUser('u1'), mkTool('t1', 'Bash'), mkAssistant('a1', 'ok')], false);
    const group = items.find((it): it is Extract<RenderItem, { type: 'work_group' }> => it.type === 'work_group');
    expect(group?.durationMs).toBeUndefined();
  });

  it('group key stays stable when an earlier run collapses while a later run is still live', () => {
    const base = [mkUser('u1'), mkTool('t1', 'Bash'), mkAssistant('a1', 'text')];
    const before = build(base, true);
    const after = build([...base, mkTool('t2', 'Read')], true);
    const beforeGroup = before.find((it) => it.type === 'work_group');
    const afterGroup = after.find((it) => it.type === 'work_group');
    expect(beforeGroup?.key).toBe('work-t1');
    expect(afterGroup?.key).toBe('work-t1'); // 尾部新 run 不影响已折叠组的 key
  });

  // ── 关键结论保护:最后一段 thinking 之后的 assistant 正文留可见,thinking 仍折 ──
  it('keeps assistant prose written after the last thinking visible (thinking stays folded)', () => {
    // 复刻「等你确认第 1 点」场景:列点的正文 + 结尾句都在最后一段 thinking 之后
    const items = build(
      [
        mkUser('u1'),
        mkThinking('th-last'),
        mkAssistant('a-plan', '要确认的点:1) … 2) …'),
        mkAssistant('a-final', '等你确认第 1 点后我就创建 issue。'),
      ],
      false,
    );
    // thinking 折进「已工作」;两段 assistant 正文都留可见
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => c.type)).toEqual(['message']); // 仅 th-last
    expect((group.children[0] as Extract<RenderItem, { type: 'message' }>).message.role).toBe('thinking');
    expect((items[2] as Extract<RenderItem, { type: 'message' }>).message.clientId).toBe('a-plan');
    expect((items[3] as Extract<RenderItem, { type: 'message' }>).message.clientId).toBe('a-final');
  });

  it('folds assistant prose written before the last thinking', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-early', 'I will inspect this first.'),
        mkThinking('th-last'),
        mkAssistant('a-final', 'The fix is done.'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => (c.type === 'message' ? `message:${c.message.clientId}` : c.type)))
      .toEqual(['message:a-early', 'work_group']);
    const thinkingGroup = group.children[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(thinkingGroup.key).toBe('work-th-last');
    expect(thinkingGroup.children.map((child) => child.key)).toEqual(['msg-th-last']);
    expect((items[2] as Extract<RenderItem, { type: 'message' }>).message.clientId).toBe('a-final');
  });

  it('folds intermediate prose when the work contains no thinking', () => {
    const items = build(
      [
        mkUser('u1'),
        mkAssistant('a-draft', 'Progress update.'),
        mkTool('t1', 'Bash'),
        mkAssistant('a-final', 'done'),
      ],
      false,
    );
    expect(items.map((it) => it.type)).toEqual(['message', 'work_group', 'message']);
    const group = items[1] as Extract<RenderItem, { type: 'work_group' }>;
    expect(group.children.map((c) => `${c.type}:${c.key}`)).toEqual([
      'message:msg-a-draft',
      'work_group:work-t1',
    ]);
    expect((items[2] as Extract<RenderItem, { type: 'message' }>).message.clientId).toBe('a-final');
  });
});

describe('insertForkOriginItem', () => {
  const forkOrigin = {
    parentSessionId: 'parent',
    forkedAtMessageId: 'source-user',
    forkedSessionCreatedAt: '2026-06-25T10:00:00.000Z',
  };

  const itemIds = (items: RenderItem[]): string[] => items.map((item) => (
    item.type === 'fork_origin'
      ? 'fork_origin'
      : item.type === 'message'
        ? item.message.clientId
        : item.key
  ));

  it('inserts the marker only when the loaded range crosses the fork boundary', () => {
    const items = [
      mkDatedMessageItem('inherited', '2026-06-25T09:59:59.000Z'),
      mkDatedMessageItem('branch', '2026-06-25T10:00:01.000Z'),
    ];

    expect(itemIds(insertForkOriginItem(items, forkOrigin))).toEqual([
      'inherited',
      'fork_origin',
      'branch',
    ]);
  });

  it('does not pin the marker to the top when only post-fork history is loaded', () => {
    const items = [
      mkDatedMessageItem('branch-1', '2026-06-25T10:00:01.000Z'),
      mkDatedMessageItem('branch-2', '2026-06-25T10:00:02.000Z'),
    ];

    expect(insertForkOriginItem(items, forkOrigin)).toBe(items);
  });

  it('does not append the marker to the latest edge when only inherited history is loaded', () => {
    const items = [
      mkDatedMessageItem('inherited-1', '2026-06-25T09:59:58.000Z'),
      mkDatedMessageItem('inherited-2', '2026-06-25T09:59:59.000Z'),
    ];

    expect(insertForkOriginItem(items, forkOrigin)).toBe(items);
  });
});

describe('collectStableLocalFileRefs — reference stability', () => {
  it('reuses previous refs when only assistant streaming content changes', () => {
    const files = [mkFileRef('foo.ts')];
    const beforeMessages = [mkUser('u1', 'read this', files), mkAssistant('a1', 'partial')];
    const afterMessages = [
      mkUser('u1', 'read this', [mkFileRef('foo.ts')]),
      mkAssistant('a1', 'partial token'),
    ];

    const beforeRefs = collectStableLocalFileRefs(beforeMessages);
    const afterRefs = collectStableLocalFileRefs(afterMessages, beforeRefs);

    expect(afterRefs).toBe(beforeRefs);
    expect(afterRefs).toEqual(files);
  });

  it('returns a new ref array when user file refs change', () => {
    const beforeRefs = collectStableLocalFileRefs([
      mkUser('u1', 'read this', [mkFileRef('foo.ts')]),
    ]);

    const afterRefs = collectStableLocalFileRefs(
      [
        mkUser('u1', 'read this', [
          mkFileRef('foo.ts'),
          mkFileRef('bar.ts'),
        ]),
      ],
      beforeRefs,
    );

    expect(afterRefs).not.toBe(beforeRefs);
    expect(afterRefs).toEqual([
      mkFileRef('foo.ts'),
      mkFileRef('bar.ts'),
    ]);
  });
});
