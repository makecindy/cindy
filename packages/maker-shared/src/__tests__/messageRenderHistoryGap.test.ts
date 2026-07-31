/**
 * 回归:历史窗口空洞不得被折进同一个「已工作 Xs」。
 *
 * 手机端 2026-07-31 实测:会话窗口由"冷开缓存的首段"+"最新页的尾段"拼成(中间 400 余行从未
 * 加载),渲染出来只剩 3 个 item —— 首条 user、一条「已工作 142m 32s」、最后一条回复。那条组
 * 吞掉了中间 6 轮对话,时长也从"某一段真实工作"谎报成整场会话的跨度。桌面早有
 * HISTORY_GAP_SPLIT_MS 守卫(groupWorkRuns + tool_segment 双层切分),手机走的这份共享分组
 * 一直没有,本组测试锁住补上的行为。
 */
import { describe, expect, it } from 'vitest';

import { HISTORY_GAP_SPLIT_MS } from '../historyGap.js';
import {
  buildMessageRenderItems,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
  type MessageRenderSourceMessageLike,
} from '../messageRender.js';

type GapFixtureSource = MessageRenderSourceMessageLike & {
  id: string;
  clientId: string;
  content: unknown;
  createdAt: string;
};

type GapFixtureMessage = MessageRenderNormalizedMessage<GapFixtureSource>;

const BASE_MS = Date.parse('2026-07-31T06:00:00.000Z');

function at(minutes: number): string {
  return new Date(BASE_MS + minutes * 60_000).toISOString();
}

function message(
  kind: GapFixtureMessage['kind'],
  id: string,
  minutes: number,
  extra: { body?: string; content?: unknown; settledAt?: string } = {},
): GapFixtureMessage {
  const source: GapFixtureSource = {
    id,
    clientId: id,
    content: extra.content ?? 'text',
    createdAt: at(minutes),
  };
  return {
    key: id,
    source,
    kind,
    label: kind,
    body: extra.body ?? '',
    createdAt: source.createdAt,
    ...(extra.settledAt !== undefined ? { settledAt: extra.settledAt } : {}),
  };
}

function toolItem(id: string, minutes: number, settledAtMinutes?: number): GapFixtureMessage {
  return message('tool', id, minutes, {
    body: `Read(${id})`,
    content: { toolName: 'Read', input: {} },
    ...(settledAtMinutes !== undefined ? { settledAt: at(settledAtMinutes) } : {}),
  });
}

/** thinking 的时长由 source.content.durationMs 解析(见 parseThinking),不是 normalized 字段。 */
function thinkingItem(id: string, minutes: number, durationMs: number): GapFixtureMessage {
  return message('thinking', id, minutes, {
    body: 'thinking',
    content: { thinking: 'thinking', durationMs },
  });
}

function assistantItem(id: string, minutes: number, body: string): GapFixtureMessage {
  return message('assistant', id, minutes, { body });
}

function userItem(id: string, minutes: number, body: string): GapFixtureMessage {
  return message('user', id, minutes, { body });
}

function typesOf(items: readonly MessageRenderItem<GapFixtureMessage>[]): string[] {
  return items.map((item) => item.type);
}

/** 每个工作组内 tool_group 的 tool id 列表(按组、按组内顺序)。 */
function toolIdsOf(items: readonly MessageRenderItem<GapFixtureMessage>[]): string[][] {
  const out: string[][] = [];
  for (const item of items) {
    if (item.type !== 'work_group') continue;
    for (const child of item.children) {
      if (child.type !== 'tool_group') continue;
      out.push(child.tools.map((toolMessage) => toolMessage.source.id));
    }
  }
  return out;
}

function groupDurations(items: readonly MessageRenderItem<GapFixtureMessage>[]): (number | undefined)[] {
  return items
    .filter((item): item is Extract<MessageRenderItem<GapFixtureMessage>, { type: 'work_group' }> =>
      item.type === 'work_group')
    .map((group) => group.durationMs);
}

describe('工作组分组 — 历史窗口空洞', () => {
  it('跨空洞的动作切成两组，时长不再横跨空洞', () => {
    // 首段(06:00~06:02)+ 尾段(08:20~08:22):中间两小时的行从未加载,连 user 边界一起缺席。
    const items = buildMessageRenderItems<GapFixtureMessage>([
      toolItem('head-tool', 0, 0),
      thinkingItem('head-thinking', 1, 5_000),
      toolItem('tail-tool', 140, 140),
      assistantItem('tail-answer', 142, '最终回复'),
    ]);

    // 修复前:['work_group','message'],那条组的 durationMs = 142 分钟(整场跨度)。
    expect(typesOf(items)).toEqual(['work_group', 'work_group', 'message']);
    const durations = groupDurations(items);
    expect(durations).toHaveLength(2);
    for (const duration of durations) {
      expect(duration ?? 0).toBeLessThan(HISTORY_GAP_SPLIT_MS);
    }
  });

  it('空洞正好落在两次工具调用之间时，tool_group 也切开', () => {
    const items = buildMessageRenderItems<GapFixtureMessage>([
      toolItem('tool-a', 0, 0),
      toolItem('tool-b', 1, 1),
      toolItem('tool-c', 140, 140),
      assistantItem('answer', 141, '最终回复'),
    ]);

    // 空洞两侧的调用没有被并进同一个 tool_group:组首尾时间差会直接变成跨空洞的假时长,
    // 而工作组分组只看组首时间、发现不了组内部的跳变。
    expect(typesOf(items)).toEqual(['work_group', 'work_group', 'message']);
    expect(toolIdsOf(items)).toEqual([['tool-a', 'tool-b'], ['tool-c']]);
  });

  it('一次跑了 40 分钟的工具调用不算空洞（锚点取结果落库时刻）', () => {
    // 调用 06:00 发起、06:40 才回结果,紧随其后的下一个动作与**结果**只隔 1 分钟。
    // 只看调用发起时刻会把它误判成空洞,把一段连续工作切碎。
    const items = buildMessageRenderItems<GapFixtureMessage>([
      toolItem('slow-tool', 0, 40),
      toolItem('next-tool', 41, 41),
      assistantItem('answer', 42, '最终回复'),
    ]);

    expect(typesOf(items)).toEqual(['work_group', 'message']);
  });

  it('想了 40 分钟的 thinking 块不算空洞（锚点加上时长）', () => {
    const items = buildMessageRenderItems<GapFixtureMessage>([
      thinkingItem('long-thinking', 0, 40 * 60_000),
      toolItem('after-thinking', 41, 41),
      assistantItem('answer', 42, '最终回复'),
    ]);

    expect(typesOf(items)).toEqual(['work_group', 'message']);
  });

  it('空洞前那一段的时长按动作结束时刻结算，不低报', () => {
    // 空洞前的段永远没有 nextItem 可作结算边界,退回段内锚点时若取组内第一条调用的**开始**
    // 时间,一个 20 分钟后才回结果的单工具段会显示约 1 秒 —— 空洞不再产生超大时长,却换成了
    // 同样离谱的低报（#1210 review）。
    const items = buildMessageRenderItems<GapFixtureMessage>([
      toolItem('slow-tool', 0, 20),
      // ↓ 空洞:与上一段的结束(06:20)相隔 2 小时
      toolItem('tail-tool', 140, 140),
      assistantItem('answer', 141, '最终回复'),
    ]);

    expect(typesOf(items)).toEqual(['work_group', 'work_group', 'message']);
    const [headDuration] = groupDurations(items);
    expect(headDuration).toBe(20 * 60_000);
  });

  it('无 nextItem 时组时长取全体子项结束时刻的最大值，不是最后一个子项', () => {
    // 子项按**发起**时刻排序,但并行动作会乱序完成:想了 40 分钟的 thinking 排在前,紧随其后
    // 2 分钟就结束的工具排在后。取"最后一个子项的结束时刻"会把 40 分钟丢掉(#1210 review)。
    const items = buildMessageRenderItems<GapFixtureMessage>([
      thinkingItem('long-thinking', 0, 40 * 60_000),
      toolItem('quick-tool', 5, 7),
      // ↓ 空洞:让这一段没有 nextItem 可作结算边界
      toolItem('tail-tool', 140, 140),
      assistantItem('answer', 141, '最终回复'),
    ]);

    expect(typesOf(items)).toEqual(['work_group', 'work_group', 'message']);
    const [headDuration] = groupDurations(items);
    expect(headDuration).toBe(40 * 60_000);
  });

  it('缺 settledAt 的工具行按调用发起时刻算结束，空洞照常切开', () => {
    // 与 messageNormalize 那条「结束时刻只认 toolUseId 精确配对」配套:归属不确定时 settledAt
    // 缺失,这里退回调用发起时刻。代价只是可能多切一个折叠条;反过来（吃邻接兜底猜出来的时刻）
    // 会把结束锚点推到几小时后,真实空洞不再触发切组 —— 渲染兜底正好在最需要它的场景失效
    // （#1210 review）。
    const items = buildMessageRenderItems<GapFixtureMessage>([
      // 没有 settledAt 的工具行(归属不确定,上游刻意不给时刻)
      toolItem('no-settled-tool', 0),
      // ↓ 空洞另一侧:窗口里"相邻",实际属于两小时后的另一段工作
      toolItem('tail-tool', 140, 140),
      assistantItem('answer', 141, '最终回复'),
    ]);

    expect(typesOf(items)).toEqual(['work_group', 'work_group', 'message']);
  });

  it('窗口连续时分组不变（user 行照常是唯一边界）', () => {
    const items = buildMessageRenderItems<GapFixtureMessage>([
      userItem('user-1', 0, '第一问'),
      toolItem('tool-1', 1, 1),
      assistantItem('answer-1', 2, '第一答'),
      userItem('user-2', 3, '第二问'),
      toolItem('tool-2', 4, 4),
      assistantItem('answer-2', 5, '第二答'),
    ]);

    expect(typesOf(items)).toEqual([
      'message', 'work_group', 'message',
      'message', 'work_group', 'message',
    ]);
  });
});
