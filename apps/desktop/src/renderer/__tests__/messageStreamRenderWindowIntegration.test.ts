/**
 * messageStreamRenderWindowIntegration.test.ts
 * ---------------------------------------------------------------------------
 * Render-window 改到 render-item 轴后,在"消息层 + render-item 层 + viewport-fill
 * 决策层"这三层叠加下的集成不变量。补 buildRenderItemsKeyStability.test.ts 单测
 * 之外的横向 case:
 *
 *  - Scenario 1: buildRenderItems(messages) 在 N=100/500/1000/2000/5000 量级的耗时
 *                上界,锁住"全量 build 在 flake-free 限度内"(防 perf 回归)
 *  - Scenario 2: U1 短 session(50 条全 tool_use+tool_result 折叠成单 segment)
 *                走完整二段式 trace:visible 覆盖全部 → load-from-db → DB prepend
 *                让 allRenderItems 增长 → windowAtTop 反转 → expand-window 触发,
 *                跟 viewportFillDetect.test.ts 的"two-stage trace replay"互补
 *                (那里用纯数字 fixture,这里用真消息序列,锁住 build → 决策 端到端)
 *  - Scenario 3: U2 末尾混合丢弃类型 + valid message 的现实序列,验证 allRenderItems
 *                末尾 = valid item,visible slice(-INITIAL_ITEMS) 非空,decideAutoFillAction
 *                在 scrollH===clientH 时正常返 'load-from-db' 而非卡死
 *
 * 默认 perf case 使用宽松固定上界,避免把本机 baseline 绑定到所有环境。
 * 50k stress 是 focused-only,用于手动追踪大规模样本的本机趋势。
 * 复核命令:
 *   pnpm --filter desktop test messageStreamRenderWindowIntegration.test.ts -t "50k"
 * 更新 50k 本地基线时先在同一机器、同一命令下连续跑 3 次,取稳定 median 写回
 * LOCAL_BASELINE_50K_MS；预算固定为 baseline × 1.2,避免把一次抖动当回归。
 *
 * Node 环境(buildRenderItems 是纯函数,跟 prevMessageJumpChip 同款 pattern)。
 */

import { describe, it, expect } from 'vitest';
import {
  buildRenderItems,
  groupWorkRuns,
  snapRenderWindowStartIdx,
  isViewportAnchorWithinDefaultTail,
  RENDER_WINDOW_INITIAL_ITEMS,
  RENDER_WINDOW_FIRST_PAINT_ITEMS,
} from '../components/chat/MessageStream';
import {
  decideAutoFillAction,
  shouldAutoExpandRenderWindow,
  shouldAutoLoadMoreHistory,
} from '../components/chat/viewportFillDetect';
import type { ChatMessage } from '@/lib/makerChatStore';

// ── 工厂 ───────────────────────────────────────────────────────────────────

const DEFAULT_PERF_BUDGET_MS = 100;
const LOCAL_BASELINE_50K_MS = 13;
const BASELINE_REGRESSION_FACTOR = 1.2;

type VitestWorkerState = {
  config?: {
    testNamePattern?: RegExp | string;
  };
};

function is50kStressFocused(): boolean {
  const worker = (globalThis as typeof globalThis & { __vitest_worker__?: VitestWorkerState })
    .__vitest_worker__;
  // Vitest worker 进程拿不到 CLI argv；这里读它自己的测试名筛选配置。
  return String(worker?.config?.testNamePattern ?? '').includes('50k');
}

const RUN_50K_STRESS = is50kStressFocused();

const mkUser = (id: string, content = '...'): ChatMessage => ({
  clientId: id,
  role: 'user',
  content,
});

const mkAssistant = (id: string, content = 'ok'): ChatMessage => ({
  clientId: id,
  role: 'assistant',
  content,
});

const mkTool = (id: string, toolName = 'Bash', toolInput: unknown = { command: 'ls' }): ChatMessage => ({
  clientId: id,
  role: 'tool_use',
  content: '',
  toolUseId: `tu-${id}`,
  toolName,
  toolInput,
});

const mkResult = (id: string, toolUseId: string, content = 'ok'): ChatMessage => ({
  clientId: id,
  role: 'tool_result',
  content,
  toolUseId,
});

const mkAskUser = (id: string): ChatMessage => ({
  clientId: id,
  role: 'ask_user',
  content: '',
});

/**
 * 构造一个"现实风格"的消息序列:user → (thinking → assistant text → tool_use × k → tool_result × k) × turn
 * 用于 perf 微基准,模拟真实 session 形态。
 */
function buildRealisticSession(approxMessageCount: number): ChatMessage[] {
  const msgs: ChatMessage[] = [];
  let id = 0;
  const next = () => `m${id++}`;

  while (msgs.length < approxMessageCount) {
    msgs.push(mkUser(next(), 'user turn'));
    msgs.push(mkAssistant(next(), 'thinking text'));
    // 每个 turn 5–8 个 tool calls,模拟现实 agent 行为
    const k = 5 + (msgs.length % 4);
    for (let i = 0; i < k && msgs.length < approxMessageCount; i++) {
      const tuId = next();
      msgs.push(mkTool(tuId, i % 2 === 0 ? 'Bash' : 'Read'));
      msgs.push(mkResult(next(), `tu-${tuId}`, 'tool output'));
    }
    if (msgs.length < approxMessageCount) {
      msgs.push(mkAssistant(next(), 'turn closing text'));
    }
  }
  return msgs;
}

// ── Scenario 1: buildRenderItems perf 上界 ────────────────────────────────

describe('Scenario 1 — buildRenderItems perf bounds', () => {
  // 注:Node 环境 wall clock 抖动较大,默认用宽松固定上界(< 100ms),目的是抓住
  // 10× 量级的性能回归(例如错误改成 O(n²) 或加了 IPC 调用)。流式中每 token
  // 都会触发一次 build,实际预算应该远低于这个上界。

  function median(times: number[]): number {
    const sorted = [...times].sort((a, b) => a - b);
    return sorted[Math.floor(sorted.length / 2)];
  }

  function benchmark(messageCount: number, runs = 5, warmupRuns = 3): number {
    const messages = buildRealisticSession(messageCount);
    const times: number[] = [];
    // focused 运行不会先跑小 N 用例，这里显式预热，避免把 JIT/模块冷启动算进基线。
    for (let i = 0; i < warmupRuns; i++) {
      buildRenderItems(messages);
    }
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      buildRenderItems(messages);
      times.push(performance.now() - t0);
    }
    return median(times);
  }

  it('N=100: typical short session, median < 5ms (loose: 100ms)', () => {
    const median = benchmark(100);
    console.log(`[perf] buildRenderItems N=100: median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DEFAULT_PERF_BUDGET_MS);
  });

  it('N=500: medium session, median < 20ms (loose: 100ms)', () => {
    const median = benchmark(500);
    console.log(`[perf] buildRenderItems N=500: median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DEFAULT_PERF_BUDGET_MS);
  });

  it('N=1000: large session (commit ffff3603 baseline), median < 50ms (loose: 100ms)', () => {
    const median = benchmark(1000);
    console.log(`[perf] buildRenderItems N=1000: median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DEFAULT_PERF_BUDGET_MS);
  });

  it('N=2000: stress session, median < 100ms', () => {
    const median = benchmark(2000);
    console.log(`[perf] buildRenderItems N=2000: median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DEFAULT_PERF_BUDGET_MS);
  });

  it('N=5000: default stress session, median < 100ms', () => {
    const median = benchmark(5000, 9, 5);
    console.log(`[perf] buildRenderItems N=5000: median=${median.toFixed(2)}ms`);
    expect(median).toBeLessThan(DEFAULT_PERF_BUDGET_MS);
  });

  (RUN_50K_STRESS ? it : it.skip)('50k stress: local baseline median <= baseline * 1.2', () => {
    const median = benchmark(50_000, 5);
    console.log(`[perf] buildRenderItems N=50000: median=${median.toFixed(2)}ms baseline=${LOCAL_BASELINE_50K_MS}ms`);
    expect(median).toBeLessThanOrEqual(LOCAL_BASELINE_50K_MS * BASELINE_REGRESSION_FACTOR);
  });
});

// ── Scenario 2: U1 短 session 端到端二段式 ────────────────────────────────

describe('Scenario 2 — U1 short session full two-stage trace (build → decide)', () => {
  // 触发场景:50 条全是 tool_use + tool_result(同一 segment,折叠成一张 chip)。
  // 真实渲染高度极小,contentH << viewport,scrollH===clientH 死锁条件。

  function buildShortFoldedSession(toolCallCount: number): ChatMessage[] {
    const msgs: ChatMessage[] = [mkAssistant('a0', 'starting tools')];
    for (let i = 0; i < toolCallCount; i++) {
      const tuId = `t${i}`;
      msgs.push(mkTool(tuId, 'Bash'));
      msgs.push(mkResult(`r${i}`, `tu-${tuId}`));
    }
    return msgs;
  }

  it('50 tool calls in one consecutive run fold into a SINGLE tool_segment item', () => {
    const messages = buildShortFoldedSession(50);
    const { items } = buildRenderItems(messages);
    // 1 个 assistant message item + 1 个 tool_segment item(50 个 tool_use 折叠)
    expect(items.length).toBe(2);
    expect(items[0].type).toBe('message');
    expect(items[1].type).toBe('tool_segment');
    if (items[1].type === 'tool_segment') {
      expect(items[1].toolCalls.length).toBe(50);
    }
  });

  it('full trace: build → windowAtTop math → decideAutoFillAction returns load-from-db when stuck', () => {
    const messages = buildShortFoldedSession(50);
    const { items: allRenderItems } = buildRenderItems(messages);
    const visibleRenderItems = allRenderItems.slice(
      Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
    );
    const windowAtTop = visibleRenderItems.length === allRenderItems.length;
    expect(windowAtTop).toBe(true);

    // 短 session contentH 远小于 viewport, scrollH===clientH 死锁状态
    const action = decideAutoFillAction({
      scrollHeight: 1354,
      clientHeight: 1354,
      windowAtTop,
      hasMoreMessages: true,
      isLoadingMore: false,
      attemptCount: 0,
    });
    expect(action).toBe('load-from-db');
  });

  it('after DB load adds N more messages, allRenderItems grows → windowAtTop=false → expand-window fires', () => {
    // 模拟 DB load 返回 50 条更老消息 prepend
    const oldMessages = buildShortFoldedSession(50);
    const olderMessages = buildShortFoldedSession(50).map((m, i) => ({
      ...m,
      clientId: `older-${i}`,
      toolUseId: m.toolUseId ? `tu-older-${i}` : undefined,
    }));
    const merged = [...olderMessages, ...oldMessages];

    const { items: allRenderItems } = buildRenderItems(merged);
    // 两批共 100 个 tool_call + 2 个 assistant text = 2 个 segment + 2 个 message item
    expect(allRenderItems.length).toBe(4);

    // 锚点假设还在旧批次的首个 segment (没动 expand)
    const oldFirstSeg = allRenderItems[2]; // [a-older, seg-older, a-old, seg-old]
    expect(oldFirstSeg.type).toBe('message');
    const visibleRenderItems = allRenderItems.slice(
      allRenderItems.findIndex((it) => it.key === oldFirstSeg.key),
    );
    const windowAtTop = visibleRenderItems.length === allRenderItems.length;
    expect(windowAtTop).toBe(false); // ✓ 新 prepend 的没进 visible

    const action = decideAutoFillAction({
      scrollHeight: 1354,
      clientHeight: 1354,
      windowAtTop,
      hasMoreMessages: true,
      isLoadingMore: false,
      attemptCount: 1, // 已经 load 过一次
    });
    expect(action).toBe('expand-window'); // ✓ Stage 1 优先于 Stage 2
  });
});

// ── Scenario 2b: render-window 不从 Task/Todo 卡中间开窗 ───────────────────

describe('Scenario 2b — render-window start snaps to user turn boundary', () => {
  it('includes the preceding user message when the default 80-item window would start at a task card', () => {
    const messages: ChatMessage[] = [
      mkUser('u-before', 'before'),
      mkAssistant('a-before', 'before answer'),
      mkUser('u-task', 'fix the task card'),
      // 运行中的子 Agent 卡(无 result)—— 非 boundary item,窗口不该从它开窗。
      mkTool('task-1', 'Task', { description: 'fix the task card' }),
      mkAssistant('a-task', 'done'),
    ];
    for (let i = 0; i < 39; i++) {
      messages.push(mkUser(`u-tail-${i}`, `tail ${i}`));
      messages.push(mkAssistant(`a-tail-${i}`, `tail answer ${i}`));
    }

    const allRenderItems = groupWorkRuns(buildRenderItems(messages).items, false);
    const rawStartIdx = Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS);

    expect(allRenderItems[rawStartIdx]?.type).toBe('agent_task');

    const snappedStartIdx = snapRenderWindowStartIdx(allRenderItems, rawStartIdx);
    const firstVisible = allRenderItems[snappedStartIdx];

    expect(firstVisible?.type).toBe('message');
    if (firstVisible?.type === 'message') {
      expect(firstVisible.message.role).toBe('user');
      expect(firstVisible.message.clientId).toBe('u-task');
    }
    expect(allRenderItems[snappedStartIdx + 1]?.type).toBe('agent_task');
  });
});

// ── Scenario 3: U2 末尾混合丢弃类型 + valid message ────────────────────────

describe('Scenario 3 — U2 tail integration (mixed dropped types + valid msg)', () => {
  /**
   * 现实场景:SDK resume 一次性把大量 tool_result 补到 messages 末尾;同时这段
   * 历史可能还混杂 ask_user / AskUserQuestion / ExitPlanMode 等被丢弃类型,加上
   * 最后用户发的一条 message。验证 buildRenderItems 末尾恰好落在 valid message item。
   */
  function buildResumeTailScenario(): ChatMessage[] {
    return [
      mkUser('u0', 'first user turn'),
      mkAssistant('a0'),
      mkTool('t0', 'Bash'),
      mkResult('r0', 'tu-t0'),
      mkAssistant('a1', 'closing'),
      // ── SDK resume 把这堆补到末尾 ──
      // 多条 orphan tool_result (toolUseId 指向不存在的 tu — 主路径不命中)
      mkResult('orphan1', 'tu-does-not-exist-1'),
      mkResult('orphan2', 'tu-does-not-exist-2'),
      mkResult('orphan3', 'tu-does-not-exist-3'),
      // ask_user 类型
      mkAskUser('ask-1'),
      mkAskUser('ask-2'),
      // AskUserQuestion / ExitPlanMode 工具调用(被 buildRenderItems 跳过)
      mkTool('aq1', 'AskUserQuestion'),
      mkResult('aqr1', 'tu-aq1'),
      mkTool('ep1', 'ExitPlanMode'),
      mkResult('epr1', 'tu-ep1'),
      // 最后一条有效 assistant message (真实场景:用户重新激活后的应答)
      mkAssistant('a-final', 'resumed reply'),
    ];
  }

  it('allRenderItems tail is the LAST valid message (not any dropped type)', () => {
    const messages = buildResumeTailScenario();
    const { items: allRenderItems } = buildRenderItems(messages);
    const tail = allRenderItems.at(-1);
    expect(tail).toBeDefined();
    expect(tail?.type).toBe('message');
    if (tail?.type === 'message') {
      expect(tail.message.clientId).toBe('a-final');
      expect(tail.message.role).toBe('assistant');
    }
  });

  it('all dropped types are absorbed in Pass 2 — allRenderItems.length < messages.length', () => {
    const messages = buildResumeTailScenario();
    const { items: allRenderItems } = buildRenderItems(messages);
    expect(allRenderItems.length).toBeLessThan(messages.length);
  });

  it('default window slice(-INITIAL_ITEMS) is non-empty (U2 死锁不可能复现)', () => {
    const messages = buildResumeTailScenario();
    const { items: allRenderItems } = buildRenderItems(messages);
    const visibleRenderItems = allRenderItems.slice(
      Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
    );
    expect(visibleRenderItems.length).toBeGreaterThan(0);
    // 末尾仍是 valid item — 自愈 effect 删除安全
    expect(visibleRenderItems.at(-1)?.type).toBe('message');
  });

  it('with all-dropped tail, decideAutoFillAction never returns "none" due to empty items', () => {
    const messages = buildResumeTailScenario();
    const { items: allRenderItems } = buildRenderItems(messages);
    const visibleRenderItems = allRenderItems.slice(
      Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
    );
    const windowAtTop = visibleRenderItems.length === allRenderItems.length;

    // 短 session 模拟 contentH 不撑满 viewport
    const action = decideAutoFillAction({
      scrollHeight: 1354,
      clientHeight: 1354,
      windowAtTop,
      hasMoreMessages: true,
      isLoadingMore: false,
      attemptCount: 0,
    });
    // 不会被"空 items"卡死,会正常进入 expand 或 load 分支
    expect(action).not.toBe('none');
  });

  // ── 拓展极端 case:整段 messages 末尾几十条全是被丢弃类型 ─────────────
  // 这是 U2 原始死锁场景的 worst case,锁住"render-item 轴下绝对不再死锁"。

  it('extreme: tail of 50 orphan + ask_user — allRenderItems tail still valid', () => {
    const valid: ChatMessage[] = [mkUser('u0'), mkAssistant('a0', 'valid content')];
    const droppedTail: ChatMessage[] = [];
    for (let i = 0; i < 25; i++) {
      droppedTail.push(mkResult(`orphan${i}`, `tu-nonexistent-${i}`));
      droppedTail.push(mkAskUser(`ask${i}`));
    }
    const messages = [...valid, ...droppedTail];

    const { items: allRenderItems } = buildRenderItems(messages);
    expect(allRenderItems.length).toBe(2); // u0 + a0,其它 50 条全丢
    const tail = allRenderItems.at(-1);
    expect(tail?.type).toBe('message');
    if (tail?.type === 'message') {
      expect(tail.message.clientId).toBe('a0');
    }

    // 关键不变量:短 session 死锁条件下,helper 决策不会因 items 为空而退化
    const visibleRenderItems = allRenderItems.slice(
      Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
    );
    expect(visibleRenderItems.length).toBe(2);
    expect(
      shouldAutoLoadMoreHistory({
        scrollHeight: 1354,
        clientHeight: 1354,
        hasMoreMessages: true,
        isLoadingMore: false,
        attemptCount: 0,
      }),
    ).toBe(true);
    expect(
      shouldAutoExpandRenderWindow({
        scrollHeight: 1354,
        clientHeight: 1354,
        windowAtTop: visibleRenderItems.length === allRenderItems.length,
      }),
    ).toBe(false); // windowAtTop=true 时 expand 不需要触发
  });
});

// ── Scenario 4: 两段式首屏窗口(FIRST_PAINT → INITIAL boost)的包含不变量 ──────
// 切会话首帧只画末尾 FIRST_PAINT 个 item,空闲期扩回 INITIAL。这里钉住两条:
//   1. FIRST_PAINT < INITIAL(boost 方向恒为「向前扩」,不会反向收缩);
//   2. 首帧窗口是 boost 后窗口的后缀子集(boost 只在视口上方 prepend,尾部
//      item 序列不变 —— 钉底重钉无跳变的前提)。
describe('two-phase first-paint window', () => {
  it('first-paint slice is a tail subset of the boosted INITIAL slice', () => {
    const messages: ChatMessage[] = [];
    for (let i = 0; i < 120; i++) {
      messages.push(mkUser(`u-${i}`, `q${i}`));
      messages.push(mkAssistant(`a-${i}`, `ans${i}`));
    }
    const { items } = buildRenderItems(messages, new Map());
    const allRenderItems = groupWorkRuns(items, false);
    expect(allRenderItems.length).toBeGreaterThan(RENDER_WINDOW_INITIAL_ITEMS);

    expect(RENDER_WINDOW_FIRST_PAINT_ITEMS).toBeLessThan(RENDER_WINDOW_INITIAL_ITEMS);

    const firstPaintStart = snapRenderWindowStartIdx(
      allRenderItems,
      Math.max(0, allRenderItems.length - RENDER_WINDOW_FIRST_PAINT_ITEMS),
    );
    const boostedStart = snapRenderWindowStartIdx(
      allRenderItems,
      Math.max(0, allRenderItems.length - RENDER_WINDOW_INITIAL_ITEMS),
    );
    const firstPaint = allRenderItems.slice(firstPaintStart);
    const boosted = allRenderItems.slice(boostedStart);

    // 首帧至少覆盖 FIRST_PAINT 个 item(snap 只会向前多包,不会少给)
    expect(firstPaint.length).toBeGreaterThanOrEqual(RENDER_WINDOW_FIRST_PAINT_ITEMS);
    // boost 只向前扩:首帧窗口必须是 boost 窗口的后缀(尾部 key 序列完全一致)
    expect(boostedStart).toBeLessThanOrEqual(firstPaintStart);
    expect(boosted.slice(boosted.length - firstPaint.length).map((it) => it.key)).toEqual(
      firstPaint.map((it) => it.key),
    );
    // 两个窗口的最后一个 item 恒为全量末尾 item(窗口永远含最新内容)
    expect(firstPaint[firstPaint.length - 1]?.key).toBe(
      allRenderItems[allRenderItems.length - 1]?.key,
    );
  });
});

describe('restored default-tail window bound', () => {
  const items = Array.from({ length: RENDER_WINDOW_INITIAL_ITEMS + 40 }, (_, i) => ({
    key: `message-m-${i}`,
    type: 'message' as const,
    message: mkAssistant(`m-${i}`),
  }));

  it('accepts an anchor still inside the current default tail', () => {
    expect(
      isViewportAnchorWithinDefaultTail(items, items[items.length - RENDER_WINDOW_INITIAL_ITEMS].key),
    ).toBe(true);
    expect(isViewportAnchorWithinDefaultTail(items, items.at(-1)!.key)).toBe(true);
  });

  it('rejects an anchor pushed out of the tail by background appends', () => {
    expect(isViewportAnchorWithinDefaultTail(items, items[0].key)).toBe(false);
    expect(isViewportAnchorWithinDefaultTail(items, 'message-m-missing')).toBe(false);
  });
});
