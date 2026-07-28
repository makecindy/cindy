/**
 * workGroupDurationAnchor.test.ts
 * ---------------------------------------------------------------------------
 * 回归:「已工作 Xs」低报 —— 段时长起点锚在段内第一个动作自带的时间戳上。
 * 一次性到达(非流式)的 thinking 块 createdAt≈结束时刻(DB 恢复路径也只能回推出
 * durationMs 的到达窗口),模型真正思考的几秒被整段丢弃。
 *
 * 复现(镜像真实会话数据):用户消息 → 6s 后 thinking 落库(自记时长仅 109ms)
 * → 2ms 后正文。首段实际耗时 ~6s,界面显示「已工作 1s」;外层总表 29s,
 * 内层两段 1s + 26s = 27s,账对不上。
 *
 * 修复:段起点优先锚在上一个边界(用户消息 / 上一句正文)——与「正在工作…」
 * 活表使用的墙钟口径一致;边界缺失(窗口截断)或时序异常(rewind 改序)时
 * 退回原有段内锚点,行为不劣于修复前。
 *
 * Node 环境(buildRenderItems / groupWorkRuns 都是纯函数)。
 */

import { describe, it, expect } from 'vitest';
import { buildRenderItems, groupWorkRuns } from '../components/chat/MessageStream';
import type { ChatMessage } from '@/lib/makerChatStore';

// ── 时间线基准(镜像真实 DB 证据的间隔) ─────────────────────────────────────
const T0 = Date.parse('2026-07-01T00:00:00.000Z');
const iso = (offsetMs: number) => new Date(T0 + offsetMs).toISOString();

// ── 工厂 ───────────────────────────────────────────────────────────────────

const mkUser = (id: string, createdAt?: string): ChatMessage => ({
  clientId: id,
  role: 'user',
  content: '你觉得这个项目如何。',
  ...(createdAt ? { createdAt } : {}),
});

const mkAssistant = (id: string, content: string, createdAt?: string): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
  ...(createdAt ? { createdAt } : {}),
});

/** 一次性到达的 thinking:createdAt≈结束时刻,自记时长只有到达窗口的毫秒级。 */
const mkThinking = (id: string, createdAt: string, thinkingDurationMs: number): ChatMessage => ({
  clientId: id,
  role: 'thinking',
  content: 'Reviewing the repository structure…',
  createdAt,
  thinkingDurationMs,
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

// ── 断言小工具 ───────────────────────────────────────────────────────────────

type RenderItems = ReturnType<typeof groupWorkRuns>;
type WorkGroupItem = Extract<RenderItems[number], { type: 'work_group' }>;

function topLevelWorkGroups(items: RenderItems): WorkGroupItem[] {
  return items.filter((it): it is WorkGroupItem => it.type === 'work_group');
}

/** 外层完成态组(work-summary-*)里的内层工作组,按出现顺序。 */
function innerWorkGroups(outer: WorkGroupItem): WorkGroupItem[] {
  return outer.children.filter((it): it is WorkGroupItem => it.type === 'work_group');
}

/** 复现截图的已回答 turn:
 *  user(T0) → thinking(T0+5951,自记 109ms) → 正文(T0+6062)
 *  → tool(T0+6500)/result → 最终正文(T0+29000)。 */
function answeredTurnMessages(): ChatMessage[] {
  return [
    mkUser('u1', iso(0)),
    mkThinking('th1', iso(5951), 109),
    mkAssistant('a1', '我先快速摸一下代码规模和质量证据,再给评价。', iso(6062)),
    mkTool('b1', iso(6500)),
    mkResult('r1', 'tu-b1', iso(7000)),
    mkAssistant('a2', '说下我的看法,老板。总体判断:这是个工程素养相当高的认真项目。', iso(29000)),
  ];
}

// ── 完成态:内层段与外层总表都锚上一边界 ────────────────────────────────────

describe('「已工作」时长 — 已回答 turn 锚定上一边界', () => {
  it('纯 thinking 首段计入模型思考时间(6s,而非 111ms 的到达窗口)', () => {
    const items = groupWorkRuns(buildRenderItems(answeredTurnMessages()).items, false);

    const outers = topLevelWorkGroups(items);
    expect(outers).toHaveLength(1);
    const inners = innerWorkGroups(outers[0]);
    expect(inners.length).toBeGreaterThanOrEqual(2);

    // 首段 = [thinking th1],边界为 user(T0) → 正文 a1(T0+6062)
    expect(inners[0].durationMs).toBe(6062);
  });

  it('后续段从上一句正文起表,外层总表覆盖整轮,内层相加=外层', () => {
    const items = groupWorkRuns(buildRenderItems(answeredTurnMessages()).items, false);

    const outer = topLevelWorkGroups(items)[0];
    const inners = innerWorkGroups(outer);

    // 第二段 = [tool b1],边界为正文 a1(T0+6062) → 最终正文 a2(T0+29000)
    expect(inners[1].durationMs).toBe(29000 - 6062);
    // 外层总表:user(T0) → 最终正文(T0+29000)
    expect(outer.durationMs).toBe(29000);
    // 账目对齐:内层相加 = 外层
    const sum = inners.reduce((acc, g) => acc + (g.durationMs ?? 0), 0);
    expect(sum).toBe(outer.durationMs);
  });
});

// ── 流式尾 turn:活表 startedAtMs 同口径 ────────────────────────────────────

describe('「正在工作…」活表 — 流式尾 turn 锚定上一边界', () => {
  it('startedAtMs 从用户消息起跳,而非段内 thinking 到达时刻', () => {
    const messages: ChatMessage[] = [mkUser('u1', iso(0)), mkThinking('th1', iso(5951), 109)];
    const items = groupWorkRuns(buildRenderItems(messages).items, true);

    const groups = topLevelWorkGroups(items);
    expect(groups).toHaveLength(1);
    expect(groups[0].isStreaming).toBe(true);
    expect(groups[0].startedAtMs).toBe(T0);
  });
});

// ── 防御:边界缺失时退回原有段内锚点 ────────────────────────────────────────

describe('「已工作」时长 — 无上一边界时退回段内锚点', () => {
  it('窗口截断(无用户消息)时保持修复前行为', () => {
    const messages: ChatMessage[] = [
      mkThinking('th1', iso(5951), 109),
      mkAssistant('a1', '我先快速摸一下代码规模和质量证据,再给评价。', iso(6062)),
      mkTool('b1', iso(6500)),
      mkResult('r1', 'tu-b1', iso(7000)),
      mkAssistant('a2', '说下我的看法,老板。', iso(29000)),
    ];
    const items = groupWorkRuns(buildRenderItems(messages).items, false);

    const outer = topLevelWorkGroups(items)[0];
    const inners = innerWorkGroups(outer);
    // 首段无上一边界:起点仍是 thinking createdAt+durationMs 口径的段内锚
    // (workRunStartTs = createdAt),6062 - 5951 = 111ms
    expect(inners[0].durationMs).toBe(111);
  });
});
