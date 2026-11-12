/**
 * 回归：共享工作组时长必须与桌面 MessageStream 使用同一条“上一边界”口径。
 *
 * 一次性到达的 thinking 可能只带到达窗口内的极短 duration；若从 thinking 自身时间起表，
 * 会把用户消息到首个活动之间的真实模型等待／思考整段丢掉。Mobile 直接消费这份共享模型，
 * 因此完成态 durationMs 与流式 startedAtMs 都必须优先锚用户消息或上一句 assistant 正文。
 */
import { describe, expect, it } from 'vitest';

import {
  buildMessageRenderItems,
  type MessageRenderItem,
  type MessageRenderNormalizedMessage,
  type MessageRenderSourceMessageLike,
} from '../messageRender.js';

type FixtureSource = MessageRenderSourceMessageLike & {
  id: string;
  clientId: string;
  content: unknown;
  createdAt: string;
};

type FixtureMessage = MessageRenderNormalizedMessage<FixtureSource>;
type WorkGroup = Extract<MessageRenderItem<FixtureMessage>, { type: 'work_group' }>;

const BASE_MS = Date.parse('2026-07-01T00:00:00.000Z');
const at = (offsetMs: number): string => new Date(BASE_MS + offsetMs).toISOString();

function message(
  kind: FixtureMessage['kind'],
  id: string,
  offsetMs: number,
  options: {
    body?: string;
    content?: unknown;
    settledAtMs?: number;
    turnCompleted?: boolean;
  } = {},
): FixtureMessage {
  const source: FixtureSource = {
    id,
    clientId: id,
    content: options.content ?? options.body ?? '',
    createdAt: at(offsetMs),
  };
  return {
    key: id,
    source,
    kind,
    label: kind,
    body: options.body ?? '',
    createdAt: source.createdAt,
    ...(options.settledAtMs !== undefined ? { settledAt: at(options.settledAtMs) } : {}),
    ...(options.turnCompleted !== undefined ? { turnCompleted: options.turnCompleted } : {}),
  };
}

function answeredTurn(): FixtureMessage[] {
  return [
    message('user', 'user', 0, { body: '评价一下这个项目' }),
    message('thinking', 'thinking', 5_951, {
      body: 'Reviewing the repository structure…',
      content: { text: 'Reviewing the repository structure…', durationMs: 109 },
    }),
    message('assistant', 'progress', 6_062, { body: '我先快速看一下代码。' }),
    message('tool', 'read', 6_500, {
      body: 'Read(/repo)',
      content: { toolName: 'Read', input: { file_path: '/repo' } },
      settledAtMs: 7_000,
    }),
    message('assistant', 'final', 29_000, {
      body: '总体判断：这是个工程素养很高的项目。',
      turnCompleted: true,
    }),
  ];
}

function topLevelGroups(items: readonly MessageRenderItem<FixtureMessage>[]): WorkGroup[] {
  return items.filter((item): item is WorkGroup => item.type === 'work_group');
}

function innerGroups(group: WorkGroup): WorkGroup[] {
  return group.children.filter((item): item is WorkGroup => item.type === 'work_group');
}

describe('共享工作组时长 — 上一边界锚点', () => {
  it('完成态把首段模型等待计入，并让内层分段之和等于外层总时长', () => {
    const [outer] = topLevelGroups(buildMessageRenderItems(answeredTurn()));
    const inner = innerGroups(outer);

    expect(inner).toHaveLength(2);
    expect(inner[0].durationMs).toBe(6_062);
    expect(inner[1].durationMs).toBe(29_000 - 6_062);
    expect(outer.durationMs).toBe(29_000);
    expect(inner.reduce((sum, group) => sum + (group.durationMs ?? 0), 0)).toBe(outer.durationMs);
  });

  it('流式尾段从用户消息起表，而不是首个 thinking 到达时刻', () => {
    const [group] = topLevelGroups(
      buildMessageRenderItems(answeredTurn().slice(0, 2), {
        isSessionStreaming: true,
      }),
    );

    expect(group.isStreaming).toBe(true);
    expect(group.startedAtMs).toBe(BASE_MS);
  });

  it('窗口截断没有上一边界时退回首个活动时间', () => {
    const [outer] = topLevelGroups(buildMessageRenderItems(answeredTurn().slice(1)));
    const [firstInner] = innerGroups(outer);

    expect(firstInner.durationMs).toBe(111);
  });

  it('历史空洞后清除旧 turn 边界，不把缺失区间计入尾段', () => {
    const items = buildMessageRenderItems([
      message('user', 'user', 0, { body: '开始' }),
      message('tool', 'head-tool', 60_000, {
        body: 'Read(head)',
        content: { toolName: 'Read', input: {} },
        settledAtMs: 60_000,
      }),
      message('tool', 'tail-tool', 140 * 60_000, {
        body: 'Read(tail)',
        content: { toolName: 'Read', input: {} },
        settledAtMs: 140 * 60_000,
      }),
      message('assistant', 'final', 141 * 60_000, {
        body: '完成',
        turnCompleted: true,
      }),
    ]);
    const groups = topLevelGroups(items);

    expect(groups).toHaveLength(2);
    expect(groups[0].durationMs).toBe(60_000);
    expect(groups[1].durationMs).toBe(60_000);
  });
});
