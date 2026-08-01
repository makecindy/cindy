/**
 * workGroupHistoryGap.test.ts
 * ---------------------------------------------------------------------------
 * 回归:跨越"历史窗口空洞"的动作不能被折进同一个「已工作 Xs」工作组。
 *
 * 背景(真实会话复现):跳转到历史消息走 makerChatStore 的 loadAroundMessage /
 * loadAroundMessageClientId,它把目标附近的窗口 mergeMessages 进当前 messages。
 * 该窗口与已加载的尾部窗口之间隔着大段没加载的历史,中间那些 user 行——唯一的
 * turn 边界——全部不在数组里。groupWorkRuns 于是从空洞前的动作一路累积到空洞后
 * 的最终正文,折成一条组:
 *
 *   实测会话 749cc942:DB 里 1936 条消息一条没少(rewind_at 全空),UI 上却只剩
 *   一行「已工作 2820m 29s」——组跨 2026-07-23 16:29:04 → 07-25 15:29:33,吞掉
 *   47 小时、40 条 user 消息,时长也跟着谎报。用户看到的现象是"中间掉了很多条"。
 *
 * 修复:相邻动作间隔超过 HISTORY_GAP_SPLIT_MS(30 分钟)即视为窗口空洞,切断工作组。
 *
 * Node 环境(buildRenderItems / groupWorkRuns 都是纯函数)。
 */

import { describe, it, expect } from 'vitest';
import {
  buildRenderItems,
  groupWorkRuns,
  insertForkOriginItem,
} from '../components/chat/MessageStream';
import { HISTORY_GAP_SPLIT_MS } from '../lib/historyGap';
import type { ChatMessage } from '@/lib/makerChatStore';
import type { GhostCardSnapshot, GhostCardEntry } from '@/cindy-brain/ghostCardStore';

// ── 工厂(带 createdAt:本组回归全靠时间戳) ──────────────────────────────────

const mkUser = (id: string, createdAt: string, content = '重置中3秒就可以了。'): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
  createdAt,
});

const mkAssistant = (id: string, createdAt: string, content: string): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
  createdAt,
});

const mkThinking = (id: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content: 'Thought',
  createdAt,
});

const mkTool = (id: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: 'Bash',
  toolInput: { command: 'ls' },
  createdAt,
});

const mkResult = (id: string, toolUseId: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content: 'ok',
  toolUseId,
  createdAt,
});

type RenderItems = ReturnType<typeof groupWorkRuns>;

function workGroups(items: RenderItems) {
  return items.filter((it) => it.type === 'work_group');
}

/** 组(含内层)是否装着该 clientId 的动作。 */
function groupContains(group: RenderItems[number], clientId: string): boolean {
  if (group.type !== 'work_group') return false;
  const hit = (item: RenderItems[number]): boolean => {
    if (item.type === 'tool_segment') return item.toolCalls.some((c) => c.clientId === clientId);
    if (item.type === 'message') return item.message.clientId === clientId;
    if (item.type === 'work_group') return item.children.some(hit);
    return false;
  };
  return group.children.some(hit);
}

// 阈值直接引用生产常量:测试里再硬编码一份 30 分钟,等于把单一来源分叉成两处,
// 将来调 HISTORY_GAP_SPLIT_MS 时测试会以旧值继续"通过"(#676 review)。

// ── Scenario A:窗口空洞两侧不并组 ───────────────────────────────────────────

describe('历史窗口空洞 — 跨空洞不合并工作组', () => {
  // 复刻 749cc942:跳转窗口(07-23 16:28~16:31)+ 尾部窗口(07-25 15:26~15:29),
  // 中间 47 小时的 user 行全部缺席。
  const gapMessages = (): ChatMessage[] => [
    mkUser('u1', '2026-07-23T16:28:30.000Z'),
    // ── 跳转窗口:空洞前 ──
    mkThinking('th1', '2026-07-23T16:29:04.000Z'),
    mkTool('t1', '2026-07-23T16:29:10.000Z'),
    mkResult('r1', 'tu-t1', '2026-07-23T16:29:20.000Z'),
    mkAssistant('a1', '2026-07-23T16:31:00.000Z', '可继续微调的旋钮:爆开半径、下坠幅度。'),
    // ── 空洞:47 小时,中间的 user 行都没加载 ──
    mkThinking('th2', '2026-07-25T15:26:00.000Z'),
    mkTool('t2', '2026-07-25T15:27:00.000Z'),
    mkResult('r2', 'tu-t2', '2026-07-25T15:28:00.000Z'),
    mkAssistant('a2', '2026-07-25T15:29:33.000Z', 'PR #379 已合并。'),
  ];

  it('A1. 空洞两侧的动作落在不同工作组', () => {
    const { items } = buildRenderItems(gapMessages());
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    const beforeGap = groups.filter((g) => groupContains(g, 't1'));
    const afterGap = groups.filter((g) => groupContains(g, 't2'));

    expect(beforeGap).toHaveLength(1);
    expect(afterGap).toHaveLength(1);
    // 关键:同一个组不能同时装着空洞两侧的动作。
    expect(beforeGap[0]).not.toBe(afterGap[0]);
    expect(groupContains(beforeGap[0], 't2')).toBe(false);
  });

  it('A2. 没有任何组谎报跨空洞时长(修复前是 2820m29s)', () => {
    const { items } = buildRenderItems(gapMessages());
    const grouped = groupWorkRuns(items, false);

    const durations = workGroups(grouped)
      .map((g) => (g.type === 'work_group' ? g.durationMs : undefined))
      .filter((d): d is number => d !== undefined);

    expect(durations.length).toBeGreaterThan(0);
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(HISTORY_GAP_SPLIT_MS);
    }
  });
});

// ── Scenario A3:纯 tool → tool 的空洞边界(review #676 codex P1) ─────────────

describe('历史窗口空洞 — 段内部的空洞', () => {
  // 空洞正好落在两次工具调用之间(缺的是 user 行),中间没有 thinking / assistant
  // 把它们隔开。旧行为:buildRenderItems 把两个窗口的 tool call 合成同一个
  // tool_segment,段首尾时间差 = 跨空洞的假时长,而只看段首时间的切组守卫发现不了。
  const toolToToolGap = (): ChatMessage[] => [
    mkUser('u1', '2026-07-23T16:28:30.000Z'),
    mkTool('t1', '2026-07-23T16:29:04.000Z'),
    mkResult('r1', 'tu-t1', '2026-07-23T16:29:20.000Z'),
    // ── 空洞:47 小时,且两侧都是工具调用 ──
    mkTool('t2', '2026-07-25T15:27:00.000Z'),
    mkResult('r2', 'tu-t2', '2026-07-25T15:28:00.000Z'),
    mkAssistant('a1', '2026-07-25T15:29:33.000Z', 'PR #379 已合并。'),
  ];

  it('A3. 段按空洞切开,两侧工具调用不在同一段,时长不谎报', () => {
    const { items } = buildRenderItems(toolToToolGap());

    const segments = items.filter((it) => it.type === 'tool_segment');
    const segWithT1 = segments.filter(
      (s) => s.type === 'tool_segment' && s.toolCalls.some((c) => c.clientId === 't1'),
    );
    const segWithT2 = segments.filter(
      (s) => s.type === 'tool_segment' && s.toolCalls.some((c) => c.clientId === 't2'),
    );
    expect(segWithT1).toHaveLength(1);
    expect(segWithT2).toHaveLength(1);
    // 关键:两次调用没有被合进同一段。
    expect(segWithT1[0]).not.toBe(segWithT2[0]);

    // 分组后也不该出现跨空洞的假时长。
    const grouped = groupWorkRuns(items, false);
    const durations = workGroups(grouped)
      .map((g) => (g.type === 'work_group' ? g.durationMs : undefined))
      .filter((d): d is number => d !== undefined);
    for (const d of durations) {
      expect(d).toBeLessThanOrEqual(HISTORY_GAP_SPLIT_MS);
    }
  });
});

// ── Scenario A4:长时段 tool_segment 不被误判成空洞(review #676 codex) ────────

describe('历史窗口空洞 — 长任务不被误判', () => {
  it('A4. 段内每次调用都在阈值内、整段却跨 1 小时时,后续 item 不被切开', () => {
    // 间隔判定必须用上一个 item 的「结束」时间。用 start 的话,这个跨 1 小时的段
    // 会让紧随其后的 assistant 正文与「段首」比较 → 差值 = 整段耗时 → 误判空洞,
    // 把最终答复前的进度文字留在工作组外、时长也退化成段兜底。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '跑一下 CI'),
      // 进度文字：应当被收进「已工作」组（它不是最终答复）。
      mkAssistant('a0', '2026-07-25T10:00:00.000Z', '我先把 CI 跑起来。'),
    ];
    // 每 20 分钟一次调用（阈值内），共 4 次 → 整段跨 60 分钟。
    for (let i = 0; i < 4; i++) {
      const at = new Date(Date.UTC(2026, 6, 25, 10, 0, 30) + i * 20 * 60_000).toISOString();
      const resultAt = new Date(Date.UTC(2026, 6, 25, 10, 1, 0) + i * 20 * 60_000).toISOString();
      messages.push(mkTool(`t${i}`, at), mkResult(`r${i}`, `tu-t${i}`, resultAt));
    }
    // 段末调用之后 1 分钟就给出最终答复 —— 与「段末」相隔很近,不该被判成空洞。
    messages.push(mkAssistant('a1', '2026-07-25T11:01:30.000Z', 'CI 全绿。'));

    const { items } = buildRenderItems(messages);
    // 段内相邻间隔 20 分钟 < 阈值 → 仍是一整段。
    expect(items.filter((it) => it.type === 'tool_segment')).toHaveLength(1);

    const grouped = groupWorkRuns(items, false);
    // 整个 turn 是一组：进度文字 + 整段动作都在组内，只有最终答复留在组外。
    // 用 start 做锚点时这里会被误切成两段，进度文字会变成前一段的「最终答复」而
    // 跑到组外 —— 这正是要拦住的退化。
    const groups = workGroups(grouped);
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
    expect(groupContains(groups[0], 't0')).toBe(true);
    expect(groupContains(groups[0], 't3')).toBe(true);
  });
});

// ── Scenario A5:单次长工具的段末要算 tool_result(review #676 codex) ──────────

describe('历史窗口空洞 — 单次长工具', () => {
  it('A5. 一次跑 40 分钟的工具,其后的最终答复不被判成空洞', () => {
    // 段里只有一个 tool_use,它的 createdAt 是「开始执行」的时刻。若拿它当段末,
    // 40 分钟后到达的 result 与紧随其后的最终答复都会落在阈值外 → 误判空洞。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '跑一下全量构建'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我起一次全量构建。'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      // result 40 分钟后才回来。
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:10.000Z'),
      // 紧接着给最终答复 —— 与「段末(result)」只差 20 秒。
      mkAssistant('a1', '2026-07-25T10:40:30.000Z', '构建通过。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    // 一个工作组：进度文字 + 那次长工具都在组内，最终答复留在组外。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
    expect(groupContains(groups[0], 't1')).toBe(true);
  });
});

// ── Scenario A6:thinking 时长要算进锚点(review #676 codex) ──────────────────

describe('历史窗口空洞 — 长 thinking', () => {
  it('A6. 想了 40 分钟的 thinking 块之后紧跟的动作不被判成空洞', () => {
    // thinking 的 createdAt 是块「开始」的时刻，真正结束要加 thinkingDurationMs
    // （workRunEndTs 早就是这个口径）。只看 createdAt 会把长 thinking 后紧跟的
    // 工具调用误判成历史空洞，切开一个本来连续的 turn。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '好好想一下这个设计'),
      {
        clientId: 'th1',
        role: 'thinking',
        content: 'Long deliberation',
        createdAt: '2026-07-25T10:00:05.000Z',
        thinkingDurationMs: 40 * 60_000,
      },
      // thinking 结束（10:40:05）之后 10 秒就动手 —— 不该被判成空洞。
      mkTool('t1', '2026-07-25T10:40:15.000Z'),
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:41:00.000Z', '按这个方案做。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    // thinking 与其后的工具调用应在同一个工作组里。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'th1')).toBe(true);
    expect(groupContains(groups[0], 't1')).toBe(true);
  });
});

// ── Scenario A7:长 Agent/Task 的段末要算 result(review #676 codex) ───────────

describe('历史窗口空洞 — 长 Agent/Task', () => {
  it('A7. 历史里跑了 40 分钟的 Task(无 live update)之后的最终答复不被判成空洞', () => {
    // agent_task 是独立的渲染分支。没有 live taskUpdates 时（重开会话读历史），
    // item 的结束时间只能靠 tool_result 的时间戳；只看 toolCall.createdAt 会把它
    // 当成「开始即结束」，让紧随其后的最终答复落在阈值外。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '派个子 Agent 去调研'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我派一个子 Agent 去跑。'),
      {
        clientId: 'task1',
        role: 'tool_use',
        content: '',
        toolUseId: 'tu-task1',
        toolName: 'Task',
        toolInput: { description: '调研' },
        createdAt: '2026-07-25T10:00:10.000Z',
      },
      mkResult('r1', 'tu-task1', '2026-07-25T10:40:10.000Z'),
      mkAssistant('a1', '2026-07-25T10:40:40.000Z', '调研结果如下。'),
    ];

    const { items } = buildRenderItems(messages);
    // 该调用渲染成独立的 agent_task 卡。
    expect(items.some((it) => it.type === 'agent_task')).toBe(true);

    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);
    // 进度文字与那张卡应在同一个工作组里，最终答复留在组外。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
  });
});

// ── Scenario A8:段内切段也要用上一条调用的结束时间(review #676 copilot) ───────

describe('历史窗口空洞 — 段内连续长任务', () => {
  it('A8. 上一条工具跑了 40 分钟、结果刚回就接下一次调用时,段不被切碎', () => {
    // 段内切段的锚点必须是上一条调用的 end = max(tool_use, tool_result)。用 start 的话
    // 「跑了 40 分钟的调用 + 紧接着的下一次调用」会被误判成空洞而切段。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '连着跑两个长任务'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      // 40 分钟后结果才回来。
      mkResult('r1', 'tu-t1', '2026-07-25T10:40:10.000Z'),
      // 结果回来后 20 秒就发起下一次调用 —— 与「上一条的 end」很近,不该切段。
      mkTool('t2', '2026-07-25T10:40:30.000Z'),
      mkResult('r2', 'tu-t2', '2026-07-25T10:40:50.000Z'),
      mkAssistant('a1', '2026-07-25T10:41:10.000Z', '两个都跑完了。'),
    ];

    const { items } = buildRenderItems(messages);
    // 两次调用仍在同一段里。
    const segments = items.filter((it) => it.type === 'tool_segment');
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.type === 'tool_segment' && seg.toolCalls.map((c) => c.clientId)).toEqual([
      't1',
      't2',
    ]);
  });
});

// ── Scenario A9:并行 Agent/Task 乱序完成时锚点不回退(review #676 codex) ──────

describe('历史窗口空洞 — 并行任务乱序完成', () => {
  it('A9. 相邻的后一张卡先结束时,空洞锚点不被拉回更早的时刻', () => {
    // 锚点必须取本 turn 内见过的最大结束时间。无条件覆盖的话，「先发起、后结束」的任务
    // 会被紧邻的「后发起、先结束」任务把锚点拉回去，于是其后的最终答复看起来隔了超过
    // 阈值 → 连续 turn 被误切、时长被低报。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '并行派两个子 Agent'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我同时派两个。'),
      // 卡 1：先发起，40 分钟后才结束。
      {
        clientId: 'task1',
        role: 'tool_use',
        content: '',
        toolUseId: 'tu-task1',
        toolName: 'Task',
        toolInput: { description: '慢的' },
        createdAt: '2026-07-25T10:00:10.000Z',
      },
      mkResult('r1', 'tu-task1', '2026-07-25T10:40:10.000Z'),
      // 卡 2：后发起，很快就结束（结束时间早于卡 1）。
      {
        clientId: 'task2',
        role: 'tool_use',
        content: '',
        toolUseId: 'tu-task2',
        toolName: 'Task',
        toolInput: { description: '快的' },
        createdAt: '2026-07-25T10:00:20.000Z',
      },
      mkResult('r2', 'tu-task2', '2026-07-25T10:01:00.000Z'),
      // 最终答复紧跟慢任务结束（10:40:10）之后 30 秒。
      mkAssistant('a1', '2026-07-25T10:40:40.000Z', '两个都回来了。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    // 一个工作组：进度文字与两张卡都在组内，最终答复留在组外。
    expect(groups).toHaveLength(1);
    expect(groupContains(groups[0], 'a0')).toBe(true);
  });
});

// ── Scenario B:正常连续 turn 不被误切 ───────────────────────────────────────

describe('历史窗口空洞 — 正常 turn 不受影响', () => {
  it('B. 间隔在阈值内的连续动作仍聚成一个工作组', () => {
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '提交 PR'),
      mkThinking('th1', '2026-07-25T10:00:05.000Z'),
      mkTool('t1', '2026-07-25T10:00:10.000Z'),
      mkResult('r1', 'tu-t1', '2026-07-25T10:00:20.000Z'),
      // 等长任务:10 分钟,仍在阈值内,不该切开。
      mkTool('t2', '2026-07-25T10:10:20.000Z'),
      mkResult('r2', 'tu-t2', '2026-07-25T10:10:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:11:00.000Z', 'PR 已提交。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const groups = workGroups(grouped);

    const holdingT1 = groups.filter((g) => groupContains(g, 't1'));
    expect(holdingT1).toHaveLength(1);
    // 同一个 turn 内的两次工具调用仍在同一个组里。
    expect(groupContains(holdingT1[0], 't2')).toBe(true);
    // 段也不该被误切:阈值内的连续调用仍合成一段。
    const segments = items.filter((it) => it.type === 'tool_segment');
    expect(segments).toHaveLength(1);
  });
});


// ── Scenario C:被卡片取代的调用也必须报出时间(review #676 copilot) ──────────
//
// ghost_card(意识供卡)是那次调用在流里的**唯一**呈现——工具行被卡片取代、不再
// 单独渲染。它原先在 renderItemStartMs / renderItemEndMs 里没有分支,一律报 null。
// (agent_plan 卡曾同属此类;计划卡现已整体移出流内,唯一呈现改为 composer 上方的
// PinnedPlanPanel,不再参与流内时间判定。)
//
// 实测过后果的具体形状(两侧都跑过,只留能真正区分的断言):
//  - 工作组切分本身**不受影响**:卡会被 groupAnsweredTurnItems 提到组外,而空洞后
//    只要还有任何带时间戳的 item,切分照旧发生 —— 分组结果与时长两侧完全一致。
//  - 真正会错的是另外两处:
//    C1 长供卡调用(出图 / 出视频跑很久)的结束时间没算进 tool_result → 紧随其后的正文被
//       误判成空洞,进度文字被当成最终答复留在工作组外(与 A4 同一退化)。
//    C2 insertForkOriginItem 按"第一个时间 >= 分叉时刻的 item"插标记 → 报 null 的卡
//       被跳过,于是**分叉之后**生成的卡片渲染在「从这里分叉」标记之上,视觉上被算进父会话。

const GHOST_TOOL = 'mcp__cindy__ghost_call';

const mkGhostCall = (id: string, createdAt: string): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName: GHOST_TOOL,
  toolInput: { ghost_id: 'cindy-art', tool: 'gen_image' },
  createdAt,
});

const mkGhostResult = (
  id: string,
  toolUseId: string,
  cardId: string,
  createdAt: string,
): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content: JSON.stringify({ ok: true, xdt_card_id: cardId }),
  toolUseId,
  createdAt,
});

const ghostSnapshot = (cardIds: string[]): GhostCardSnapshot => ({
  version: 1,
  byCallId: new Map(
    cardIds.map((id) => [
      id,
      { status: 'ready', ghostId: 'cindy-art', html: '<p>card</p>', height: 240 } as GhostCardEntry,
    ]),
  ),
  liveCards: [],
});

const forkOrigin = {
  parentSessionId: 'parent-sess',
  forkedAtMessageId: 'msg-fork',
  forkedSessionCreatedAt: '2026-07-25T10:05:00.000Z',
} as unknown as Parameters<typeof insertForkOriginItem>[1];

describe('历史窗口空洞 — 被卡片取代的调用', () => {
  it('C1. 一次跑很久的供卡调用不被误判成空洞(结束时间算进 tool_result)', () => {
    // 出图 / 出视频这类调用可能跑很久。卡片的 toolCall.createdAt 只是"开始",拿它当结束
    // 会把紧随其后的动作误判成空洞:进度文字 a0 被切成前一段的"最终答复"、留在组外。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '出个视频'),
      mkAssistant('a0', '2026-07-25T10:00:05.000Z', '我来生成。'),
      mkTool('t0', '2026-07-25T10:00:08.000Z'),
      mkResult('r0', 'tu-t0', '2026-07-25T10:00:09.000Z'),
      mkGhostCall('g1', '2026-07-25T10:00:10.000Z'),
      // 45 分钟后才回结果(> 阈值)。
      mkGhostResult('gr1', 'tu-g1', 'call-1', '2026-07-25T10:45:10.000Z'),
      mkTool('t9', '2026-07-25T10:45:20.000Z'),
      mkResult('r9', 'tu-t9', '2026-07-25T10:45:25.000Z'),
      mkAssistant('a1', '2026-07-25T10:45:40.000Z', '视频好了。'),
    ];

    const { items } = buildRenderItems(messages, undefined, ghostSnapshot(['call-1']));
    expect(items.some((it) => it.type === 'ghost_card')).toBe(true);

    const grouped = groupWorkRuns(items, false);
    // 关键:进度文字仍在「已工作」组里。卡片结束时间取不到 result 时,这里会退化成
    // 组外的一条裸 assistant(与 A4 同一形状)。
    const groups = workGroups(grouped);
    expect(groups.some((g) => groupContains(g, 'a0'))).toBe(true);
  });

  it('C2. 分叉之后生成的 ghost_card 渲染在分叉标记之下', () => {
    const messages: ChatMessage[] = [
      // 分叉点之前:来自父会话的历史。
      mkUser('u1', '2026-07-25T10:00:00.000Z', '继续'),
      // 分叉点(10:05)之后:本会话自己的供卡调用。
      mkGhostCall('g1', '2026-07-25T10:06:00.000Z'),
      mkGhostResult('gr1', 'tu-g1', 'call-1', '2026-07-25T10:06:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:07:00.000Z', '好了。'),
    ];

    const { items } = buildRenderItems(messages, undefined, ghostSnapshot(['call-1']));
    const withMarker = insertForkOriginItem(items, forkOrigin);

    const markerIdx = withMarker.findIndex((it) => it.type === 'fork_origin');
    const cardIdx = withMarker.findIndex((it) => it.type === 'ghost_card');
    expect(markerIdx).toBeGreaterThanOrEqual(0);
    expect(cardIdx).toBeGreaterThanOrEqual(0);
    // 卡片报不出时间时会被 findIndex 跳过,标记插到它**后面** → 卡片被算进父会话。
    expect(markerIdx).toBeLessThan(cardIdx);
  });
});

// ── Scenario D:被空洞收尾的工作组时长(review #676 codex P1) ─────────────────

describe('历史窗口空洞 — 被空洞收尾的组的时长', () => {
  it('D. 空洞前是一次长工具调用且后面没有正文时,时长取 tool_result 而不是发起时刻', () => {
    // createWorkGroup 只有拿到 nextItem(紧随的 assistant 正文)时才用它当结束时间;
    // 被空洞切开的组没有 nextItem,回落到 workRunFallbackEndTs。那份 fallback 原来另算
    // 一套(段取最后一次调用的**发起**时刻),于是一次跑 40 分钟的调用后面接空洞时,
    // 「已工作」显示成约 0s。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-23T16:00:00.000Z', '跑个长任务'),
      mkTool('t1', '2026-07-23T16:00:10.000Z'),
      // 40 分钟后才回结果,之后**没有**assistant 正文,直接接空洞。
      mkResult('r1', 'tu-t1', '2026-07-23T16:40:10.000Z'),
      // ── 空洞:47 小时 ──
      mkUser('u2', '2026-07-25T15:00:00.000Z', '继续'),
      mkAssistant('a2', '2026-07-25T15:00:30.000Z', '好。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const group = workGroups(grouped).find((g) => groupContains(g, 't1'));
    expect(group?.type).toBe('work_group');
    const durationMs = group?.type === 'work_group' ? group.durationMs : undefined;
    // 起点是 turn 开场那条 user 行(16:00:00,#598 的口径),终点是 tool_result(16:40:10)
    // → 40 分 10 秒。这条用例守的是**终点**:取发起时刻当结束会得到约 0。
    expect(durationMs).toBe(40 * 60 * 1000 + 10 * 1000);
  });
});

// ── Scenario E:并行工具仍在跑时不切段(review #676 codex P1) ─────────────────

describe('历史窗口空洞 — 并行工具乱序完成', () => {
  it('E. 段内锚点取所有调用结束时间的最大值,不只看紧邻的上一条', () => {
    // 真正的并行:A 从 10:00 一直跑到 10:41(下一次调用发起时它**还没结束**),B 紧随其后、
    // 一分钟就回。C 在 10:40:30 发起 —— 只比紧邻的 B 的早结束时间(10:01:30)会得出 39 分钟、
    // 误判成历史空洞,把一段连续工作切成两段,段产物(tool_media)也跟着挪到错误的边界上。
    // 锚点必须取段内所有调用结束时间的最大值(与 groupWorkRuns 的 prevEndMs 同口径)。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-25T10:00:00.000Z', '并行跑两件事'),
      mkTool('tA', '2026-07-25T10:00:00.000Z'),
      mkTool('tB', '2026-07-25T10:00:30.000Z'),
      mkResult('rB', 'tu-tB', '2026-07-25T10:01:30.000Z'),
      // A 还在跑,这时又发起了 C。
      mkTool('tC', '2026-07-25T10:40:30.000Z'),
      mkResult('rA', 'tu-tA', '2026-07-25T10:41:00.000Z'),
      mkResult('rC', 'tu-tC', '2026-07-25T10:41:30.000Z'),
      mkAssistant('a1', '2026-07-25T10:42:00.000Z', '都好了。'),
    ];

    const { items } = buildRenderItems(messages);
    const segments = items.filter((it) => it.type === 'tool_segment');
    // 关键:仍是一整段,三次调用都在里面。
    expect(segments).toHaveLength(1);
    const seg = segments[0];
    expect(seg.type === 'tool_segment' && seg.toolCalls.map((c) => c.clientId)).toEqual([
      'tA',
      'tB',
      'tC',
    ]);
  });
});

// ── Scenario F:被空洞收尾的组要取子项结束时间的最大值(review #676 codex P1) ──

describe('历史窗口空洞 — 被空洞收尾的组含长任务', () => {
  it('F. 组末尾是短子项、长任务在前时,时长取最大结束时间', () => {
    // 组被空洞收尾 → createWorkGroup 没有 nextItem → 回落到 workRunFallbackEndTs。
    // 那份 fallback 原来"从后往前取第一个有时间的子项",于是"Task 跑到 40 分钟、但组末尾是
    // 一个早就结束的 thinking 块"时,整段显示成 20 秒 —— 而空洞判定那边用的已经是正确的
    // 最大值。这里 result 不与任何 tool_use 相邻(中间隔着 thinking),所以只能经 toolUseId
    // 配对,adjacency 兜底不会把它的时间戳挪到末尾子项上。
    const messages: ChatMessage[] = [
      mkUser('u1', '2026-07-23T16:00:00.000Z', '跑个长 Task'),
      {
        clientId: 'taskA',
        role: 'tool_use',
        content: '',
        toolUseId: 'tu-taskA',
        toolName: 'Task',
        toolInput: { description: '慢的' },
        createdAt: '2026-07-23T16:00:10.000Z',
      },
      // Task 还在跑,agent 先想了一下(组的末尾子项,20 秒就结束)。
      mkThinking('th1', '2026-07-23T16:00:30.000Z'),
      // 40 分钟后 Task 才回结果。
      mkResult('rA', 'tu-taskA', '2026-07-23T16:40:10.000Z'),
      // ── 空洞:47 小时,且组后面没有 assistant 正文 ──
      mkUser('u2', '2026-07-25T15:00:00.000Z', '继续'),
      mkAssistant('a2', '2026-07-25T15:00:30.000Z', '好。'),
    ];

    const { items } = buildRenderItems(messages);
    const grouped = groupWorkRuns(items, false);
    const durations = workGroups(grouped)
      .map((g) => (g.type === 'work_group' ? g.durationMs : undefined))
      .filter((d): d is number => d !== undefined);

    // 起点是 turn 开场那条 user 行(16:00:00,#598 的口径),终点取子项结束时间的最大值
    // (16:40:10)→ 40 分 10 秒。取末尾子项当终点会得到约 30 秒。
    expect(durations).toContain(40 * 60 * 1000 + 10 * 1000);
  });
});
