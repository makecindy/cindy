/**
 * subscriptionGateway.test.ts — 订阅槽网关单测(纯 DI,假时钟,无 Electron)。
 * 覆盖:did- 扇出(topic 白名单/停用忽略)、熄灯缓冲+唤醒补投+溢出丢最旧
 * 带 dropped、seq 单调;will- 串行短路、超时 fail-open、熔断降级、verdict
 * 归属校验、reason 截断;turn 翻译器状态机与 usage 归一化;activity 边界配对与轮次来源过滤。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GhostSubscriptionGateway,
  GhostActivityTracker,
  GhostTapPendingQueue,
  GhostTurnOriginTracker,
  GhostTurnTranslator,
  createGhostSessionFocusTracker,
  ghostActivityId,
  isGhostEligibleSessionRow,
  normalizeTurnUsage,
  readStatusIsRunning,
  type GhostSubscriptionGatewayDeps,
} from '../subscriptionGateway';
import {
  GHOST_ASSISTANT_HOOK_TIMEOUT_MS,
  GHOST_HOOK_TIMEOUT_MS,
  GHOST_SUB_QUEUE_MAX,
  type GhostPipeEventPush,
  type InstalledGhost,
} from '../../../shared/ghost';

function ghost(
  id: string,
  subscribe: { topics?: string[]; hooks?: string[] } | undefined,
  enabled = true,
): InstalledGhost {
  return {
    manifest: {
      schemaVersion: 2,
      id,
      name: `意识${id}`,
      version: '1.0.0',
      kind: 'chip',
      entry: 'main.js',
      slots: ['subscribe'],
      ...(subscribe ? { subscribe } : {}),
    },
    dir: `/fake/${id}`,
    enabled,
  } as InstalledGhost;
}

function makeGateway(overrides: Partial<GhostSubscriptionGatewayDeps> = {}) {
  const sent: Array<{ ghostId: string; payload: GhostPipeEventPush }> = [];
  const running = new Set<string>();
  let hookSeq = 0;
  const deps: GhostSubscriptionGatewayDeps = {
    listGhosts: () => [ghost('a', { topics: ['turn'] })],
    isRunning: (id) => running.has(id),
    wake: vi.fn(async (g: InstalledGhost) => {
      running.add(g.manifest.id);
    }),
    sendToGhost: (ghostId, payload) => {
      sent.push({ ghostId, payload });
    },
    now: () => 1_000,
    newHookId: () => `hook-${++hookSeq}`,
    ...overrides,
  };
  return { gw: new GhostSubscriptionGateway(deps), sent, running, deps };
}

const TURN_DATA = { sessionId: 's1', agent: 'claude-code' };

describe('did- 旁听扇出', () => {
  it('只投声明了该 topic 的启用意识;seq 单调', async () => {
    const { gw, sent, running } = makeGateway({
      listGhosts: () => [
        ghost('a', { topics: ['turn'] }),
        ghost('b', { topics: ['session'] }),
        ghost('c', { topics: ['turn'] }, false), // 停用
        ghost('d', undefined), // 有槽无详单 = 零事件
      ],
    });
    running.add('a');
    running.add('b');
    gw.publish('turn', 'did-turn-start', TURN_DATA);
    gw.publish('turn', 'did-turn-end', { ...TURN_DATA, durationMs: 5, endReason: 'completed' });
    gw.publish('activity', 'did-thinking-start', { sessionId: 's1', blockId: 'ignored' });
    expect(sent.map((s) => s.ghostId)).toEqual(['a', 'a']);
    expect(sent.map((s) => (s.payload as { seq: number }).seq)).toEqual([1, 2]);
  });

  it('activity topic 复用同一扇出/seq/buffer/wake 管道', async () => {
    const { gw, sent, running, deps } = makeGateway({
      listGhosts: () => [ghost('a', { topics: ['activity'] })],
    });
    gw.publish('activity', 'did-thinking-start', { sessionId: 's1', blockId: 'b1' });
    expect(sent).toHaveLength(0);
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(deps.wake).toHaveBeenCalledOnce();
    expect(sent[0]?.payload).toMatchObject({
      topic: 'activity',
      name: 'did-thinking-start',
      seq: 1,
      data: { sessionId: 's1', blockId: 'b1' },
    });
    running.add('a');
    gw.publish('activity', 'did-thinking-end', { sessionId: 's1', blockId: 'b1' });
    expect(sent[1]?.payload).toMatchObject({ topic: 'activity', seq: 2 });
  });

  it('熄灯缓冲:事件触发唤醒,醒后按序补投', async () => {
    const { gw, sent, deps } = makeGateway();
    gw.publish('turn', 'did-turn-start', TURN_DATA);
    gw.publish('turn', 'did-turn-end', { ...TURN_DATA, durationMs: 5, endReason: 'completed' });
    expect(sent).toHaveLength(0);
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(deps.wake).toHaveBeenCalledTimes(1); // 唤醒去重
    expect(sent.map((s) => (s.payload as { name: string }).name)).toEqual([
      'did-turn-start',
      'did-turn-end',
    ]);
  });

  it('缓冲溢出丢最旧,dropped 计数随补投首条带出', async () => {
    const running = new Set<string>();
    const wake = vi.fn(async () => {}); // 先唤不醒(不置 running):纯堆缓冲
    const { gw, sent } = makeGateway({ wake, isRunning: (id) => running.has(id) });
    for (let i = 0; i < GHOST_SUB_QUEUE_MAX + 3; i++) {
      gw.publish('turn', 'did-turn-start', TURN_DATA);
    }
    // 让首次唤醒(失败:isRunning 仍 false)彻底收尾,waking 标记复位。
    await new Promise((r) => setTimeout(r, 0));
    expect(sent).toHaveLength(0);
    running.add('a');
    gw.publish('turn', 'did-turn-start', TURN_DATA); // 第 104 条:再溢出(dropped=4)并触发补投
    await vi.waitFor(() => expect(sent).toHaveLength(GHOST_SUB_QUEUE_MAX));
    expect((sent[0].payload as { dropped?: number }).dropped).toBe(4);
    expect((sent[1].payload as { dropped?: number }).dropped).toBeUndefined();
    // 补投保序:seq 严格递增
    const seqs = sent.map((s) => (s.payload as { seq: number }).seq);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
  });
});

describe('GhostActivityTracker', () => {
  /** 出网关的标识都是投影值(见 ghostActivityId);断言用同一个投影算,不写死哈希。 */
  const aid = (upstreamId: string) => ghostActivityId('s1', upstreamId);

  it('按 thinking blockId 边界只发元数据,不发正文', () => {
    const events: Array<{ name: string; data: unknown }> = [];
    const tracker = new GhostActivityTracker({
      sessionId: 's1',
      sink: { activity: (name, data) => events.push({ name, data }) },
    });
    tracker.beginTurn();
    tracker.handleEvent({ type: 'thinking', data: { stage: 'start', blockId: 'b1' } });
    tracker.handleEvent({ type: 'thinking', data: { stage: 'delta', blockId: 'b1', text: 'secret reasoning' } });
    tracker.handleEvent({ type: 'thinking', data: { stage: 'final', blockId: 'b1', text: 'secret reasoning' } });
    tracker.handleEvent({ type: 'thinking', data: { stage: 'final', blockId: 'b1', text: 'duplicate' } });
    expect(events).toEqual([
      { name: 'did-thinking-start', data: { sessionId: 's1', blockId: aid('b1') } },
      { name: 'did-thinking-end', data: { sessionId: 's1', blockId: aid('b1') } },
    ]);
    expect(events.some((event) => JSON.stringify(event).includes('secret reasoning'))).toBe(false);
    // 上游原值不外泄:投影后与 'b1' 不同(sessionId 保持明文,它是跨 topic 关联键)。
    expect(events.some((event) => JSON.stringify(event).includes('"b1"'))).toBe(false);
  });

  it('approval 与 user-input 生命周期分别映射, finishAll 给所有在场请求兜底结束', () => {
    const names: string[] = [];
    const tracker = new GhostActivityTracker({
      sessionId: 's1',
      sink: { activity: (name) => names.push(name) },
    });
    tracker.beginTurn();
    tracker.startInteraction('permission', 'p1');
    tracker.startInteraction('plan_review', 'p2');
    tracker.startInteraction('ask_user_question', 'q1');
    // 三个请求同时在场:开始阶段只有 start,谁都不被提前收口。
    expect(names).toEqual([
      'did-approval-start',
      'did-approval-start',
      'did-user-input-start',
    ]);
    // 回合收口不碰审批(用户可能还在批),只有会话级 finishAll 才兜底。
    tracker.finishTurn();
    expect(names).toHaveLength(3);
    tracker.finishAll();
    expect(names.slice(3)).toEqual([
      'did-approval-end',
      'did-approval-end',
      'did-user-input-end',
    ]);
  });

  it('codex 计划审批在回合终态之后开始也能完整配对', () => {
    const events: Array<{ name: string; requestId: unknown }> = [];
    const tracker = new GhostActivityTracker({
      sessionId: 's1',
      sink: {
        activity: (name, data) =>
          events.push({ name, requestId: (data as { requestId?: unknown }).requestId }),
      },
    });
    // codex 计划模式真实时序:计划 turn 的 done 先入队被消费(turn 收口),
    // runPlanReviewFlow 之后才发起 plan_review。
    tracker.beginTurn();
    tracker.finishTurn();
    tracker.startInteraction('plan_review', 'plan-1');
    // 回合已收口也必须发 start:否则插件根本不知道用户正在批计划。
    expect(events).toEqual([{ name: 'did-approval-start', requestId: aid('plan-1') }]);
    // 期间新回合开始也不能把仍在等的审批抹掉(修订 turn 由审批结果触发)。
    tracker.beginTurn();
    expect(events).toHaveLength(1);
    tracker.endInteraction('plan_review', 'plan-1');
    expect(events).toEqual([
      { name: 'did-approval-start', requestId: aid('plan-1') },
      { name: 'did-approval-end', requestId: aid('plan-1') },
    ]);
  });

  it('并发审批按 requestId 各自配对:先结束的不抹掉仍在等的', () => {
    const events: Array<{ name: string; requestId: unknown }> = [];
    const tracker = new GhostActivityTracker({
      sessionId: 's1',
      sink: {
        activity: (name, data) =>
          events.push({ name, requestId: (data as { requestId?: unknown }).requestId }),
      },
    });
    tracker.beginTurn();
    tracker.startInteraction('permission', 'a');
    tracker.startInteraction('permission', 'b');
    tracker.startInteraction('permission', 'b'); // 同 id 重复进入不重发 start
    tracker.endInteraction('permission', 'b');
    // b 已收口而 a 仍在等:此刻绝不能出现 a 的 end。
    expect(events).toEqual([
      { name: 'did-approval-start', requestId: aid('a') },
      { name: 'did-approval-start', requestId: aid('b') },
      { name: 'did-approval-end', requestId: aid('b') },
    ]);
    tracker.endInteraction('permission', 'b'); // 已收口不重发 end
    tracker.endInteraction('permission', 'a');
    expect(events).toEqual([
      { name: 'did-approval-start', requestId: aid('a') },
      { name: 'did-approval-start', requestId: aid('b') },
      { name: 'did-approval-end', requestId: aid('b') },
      { name: 'did-approval-end', requestId: aid('a') },
    ]);
    // 全部收口后 finishTurn 不再补发。
    tracker.finishTurn();
    expect(events).toHaveLength(4);
  });
});

describe('will- 拦截', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const HOOK_GHOSTS = [
    ghost('h1', { hooks: ['will-user-message'] }),
    ghost('h2', { hooks: ['will-user-message'] }),
  ];

  it('串行短路:h1 block 即返回,h2 不被询问;reason 截断 200', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => HOOK_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenUserMessage({ sessionId: 's1', text: '敏感话' });
    expect(sent).toHaveLength(1);
    const hookId = (sent[0].payload as { hookId: string }).hookId;
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId,
      action: 'block',
      reason: 'x'.repeat(500),
    });
    const r = await p;
    expect(r).toMatchObject({ action: 'block', ghostId: 'h1', ghostName: '意识h1' });
    if (r.action === 'block') expect(r.reason).toHaveLength(200);
    expect(sent).toHaveLength(1);
  });

  it('allow 继续问下一个;全 allow 放行', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => HOOK_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'hi' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    expect(await p).toEqual({ action: 'allow' });
  });

  it('rewrite:改写正文放行,返回改写版 + 署名', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => [HOOK_GHOSTS[0]] });
    running.add('h1');
    const p = gw.screenUserMessage({ sessionId: 's1', text: '原始问题' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: '优化后的问题',
    });
    expect(await p).toEqual({
      action: 'rewrite',
      ghostId: 'h1',
      ghostName: '意识h1',
      text: '优化后的问题',
    });
  });

  it('链式变换:前一个 rewrite 的输出是后一个的输入;末个署名生效', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => HOOK_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'a' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: 'ab',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // h2 收到的是 h1 改写后的文本
    expect((sent[1].payload as { data: { text: string } }).data.text).toBe('ab');
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: 'abc',
    });
    expect(await p).toEqual({ action: 'rewrite', ghostId: 'h2', ghostName: '意识h2', text: 'abc' });
  });

  it('rewrite 后遇 block:block 短路,不再当改写', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => HOOK_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'x' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: 'x-opt',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'block',
      reason: '不行',
    });
    expect(await p).toMatchObject({ action: 'block', ghostId: 'h2' });
  });

  it('空改写 / 改写等于原文:忽略,按 allow', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => [HOOK_GHOSTS[0]] });
    running.add('h1');
    const p = gw.screenUserMessage({ sessionId: 's1', text: '原文' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: '   ', // 空白 → trim 后为空,忽略
    });
    expect(await p).toEqual({ action: 'allow' });
  });

  it('超时 fail-open;连续 3 次熔断降级且不再询问', async () => {
    const fused: string[] = [];
    const { gw, sent, running } = makeGateway({
      listGhosts: () => [HOOK_GHOSTS[0]],
      onHookFused: (g) => fused.push(g.manifest.id),
    });
    running.add('h1');
    for (let i = 0; i < 3; i++) {
      const p = gw.screenUserMessage({ sessionId: 's1', text: 'hi' });
      await vi.advanceTimersByTimeAsync(GHOST_HOOK_TIMEOUT_MS + 10);
      expect(await p).toEqual({ action: 'allow' });
    }
    expect(fused).toEqual(['h1']); // 只触发一次
    expect(sent).toHaveLength(3);
    // 熔断后不再询问,直接放行
    expect(await gw.screenUserMessage({ sessionId: 's1', text: 'hi' })).toEqual({
      action: 'allow',
    });
    expect(sent).toHaveLength(3);
  });

  it('verdict 归属校验:冒名/未知 hookId 静默丢;迟到 verdict 无副作用', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => [HOOK_GHOSTS[0]] });
    running.add('h1');
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'hi' });
    const hookId = (sent[0].payload as { hookId: string }).hookId;
    gw.handleVerdict('h2', { type: 'event-verdict', hookId, action: 'block' }); // 冒名
    gw.handleVerdict('h1', { type: 'event-verdict', hookId: 'nope', action: 'block' }); // 未知
    gw.handleVerdict('h1', { type: 'event-verdict', hookId, action: 'allow' }); // 真裁决
    expect(await p).toEqual({ action: 'allow' });
    gw.handleVerdict('h1', { type: 'event-verdict', hookId, action: 'block' }); // 迟到
  });

  it('wake 挂死(load 永不完成):3s 整体上界照样放行,不卡发送', async () => {
    const { gw } = makeGateway({
      listGhosts: () => [HOOK_GHOSTS[0]],
      isRunning: () => false,
      wake: vi.fn(() => new Promise<never>(() => {})), // 永不 settle
    });
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'hi' });
    await vi.advanceTimersByTimeAsync(GHOST_HOOK_TIMEOUT_MS + 10);
    expect(await p).toEqual({ action: 'allow' });
  });

  it('投递失败计入熔断并放行;成功裁决清零失败计数', async () => {
    let failNext = true;
    const { gw, sent, running } = makeGateway({
      listGhosts: () => [HOOK_GHOSTS[0]],
      sendToGhost: (ghostId, payload) => {
        if (failNext) throw new Error('pipe down');
        sent.push({ ghostId, payload });
      },
    });
    running.add('h1');
    expect(await gw.screenUserMessage({ sessionId: 's1', text: 'hi' })).toEqual({
      action: 'allow',
    });
    failNext = false;
    const p = gw.screenUserMessage({ sessionId: 's1', text: 'hi' });
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    expect(await p).toEqual({ action: 'allow' });
  });
});

describe('will-assistant-message 出口钩子拦截(screenAssistantMessage)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const OUT_GHOSTS = [
    ghost('h1', { hooks: ['will-assistant-message'] }),
    ghost('h2', { hooks: ['will-assistant-message'] }),
  ];

  it('全 allow → 放行', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => OUT_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: 'AI 回复' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    expect(await p).toEqual({ action: 'allow' });
    // 下发的事件名是出口钩子名。
    expect((sent[0].payload as { name: string }).name).toBe('will-assistant-message');
  });

  it('rewrite 链式叠加:h2 看到 h1 改写后的文本,末个署名', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => OUT_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: 'a' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: 'ab',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // h2 收到的输入 = h1 改写后的 'ab'。
    expect((sent[1].payload as { data: { text: string } }).data.text).toBe('ab');
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: 'abc',
    });
    expect(await p).toEqual({ action: 'rewrite', ghostId: 'h2', ghostName: '意识h2', text: 'abc' });
  });

  it('render 最后一个胜出;text 带出链式 rewrite 后的权威正文', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => OUT_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: '原文' });
    // h1 rewrite 改文本。
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'rewrite',
      text: '润色版',
    });
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    // h2 render 自绘卡。
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'render',
      html: '<div>卡片</div>',
      height: 180,
    });
    const r = await p;
    expect(r).toEqual({
      action: 'render',
      ghostId: 'h2',
      ghostName: '意识h2',
      html: '<div>卡片</div>',
      height: 180,
      text: '润色版', // render 仍带出权威正文(供落库 + 查看原文)
    });
  });

  it('block 对出口钩子非法 → 略过按 allow(不短路)', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => OUT_GHOSTS });
    running.add('h1').add('h2');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: 'x' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'block',
      reason: '试图拦截',
    });
    // block 未短路:仍问 h2。
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    gw.handleVerdict('h2', {
      type: 'event-verdict',
      hookId: (sent[1].payload as { hookId: string }).hookId,
      action: 'allow',
    });
    expect(await p).toEqual({ action: 'allow' });
  });

  it('空 render / 空 rewrite 被忽略', async () => {
    const { gw, sent, running } = makeGateway({ listGhosts: () => [OUT_GHOSTS[0]] });
    running.add('h1');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: '原文' });
    gw.handleVerdict('h1', {
      type: 'event-verdict',
      hookId: (sent[0].payload as { hookId: string }).hookId,
      action: 'render',
      html: '   ', // 空白 html:忽略
    });
    expect(await p).toEqual({ action: 'allow' });
  });

  it('超时 fail-open 用 5 分钟窗口(入口 3s 不会误触发)', async () => {
    const { gw, running } = makeGateway({ listGhosts: () => [OUT_GHOSTS[0]] });
    running.add('h1');
    const p = gw.screenAssistantMessage({ sessionId: 's1', text: 'hi' });
    // 推进 3s(入口钩子超时):出口钩子还没超时,仍在等。
    await vi.advanceTimersByTimeAsync(GHOST_HOOK_TIMEOUT_MS + 10);
    let settled = false;
    void p.then(() => (settled = true));
    await Promise.resolve();
    expect(settled).toBe(false);
    // 推进到 5 分钟:超时 fail-open。
    await vi.advanceTimersByTimeAsync(GHOST_ASSISTANT_HOOK_TIMEOUT_MS);
    expect(await p).toEqual({ action: 'allow' });
  });
});

describe('isGhostEligibleSessionRow(订阅投递资格行级判定)', () => {
  it('desktop / shared 主会话放行;IM / 自动化 / orca 排除', () => {
    // 用户主会话:亲手建的 + 分享导入的(2026-07-13 实撞:shared 曾被误排除)。
    expect(isGhostEligibleSessionRow({ source: 'desktop', orcaRole: null })).toBe(true);
    expect(isGhostEligibleSessionRow({ source: 'shared', orcaRole: null })).toBe(true);
    // 代理序列化可能把 NULL 变 undefined:同样放行。
    expect(isGhostEligibleSessionRow({ source: 'desktop', orcaRole: undefined })).toBe(true);
    // IM 机器人渠道 / 本机自动化:噪音,排除。
    for (const source of ['feishu', 'slack', 'discord', 'scheduler', 'learn']) {
      expect(isGhostEligibleSessionRow({ source, orcaRole: null }), source).toBe(false);
    }
    // Orca 协同(lead/worker)排除。
    expect(isGhostEligibleSessionRow({ source: 'desktop', orcaRole: 'lead' })).toBe(false);
    expect(isGhostEligibleSessionRow({ source: 'shared', orcaRole: 'worker' })).toBe(false);
  });
});

describe('createGhostSessionFocusTracker(did-session-switched 去重)', () => {
  it('真变化才发;连续同 id 不重发', () => {
    const notify = vi.fn();
    const tracker = createGhostSessionFocusTracker(notify);
    tracker.note('s1');
    tracker.note('s1'); // 路由重渲同 id:不重发
    tracker.note('s2');
    expect(notify.mock.calls).toEqual([['s1'], ['s2']]);
  });

  it('切去非会话页(null)只清位不发;切走再切回算新切换照发', () => {
    const notify = vi.fn();
    const tracker = createGhostSessionFocusTracker(notify);
    tracker.note(null); // 启动落在非会话页:不发
    tracker.note('s1');
    tracker.note(null); // 切去设置页等:不发
    tracker.note(null); // 重复 null:不发
    tracker.note('s1'); // 切回:算一次新切换
    expect(notify.mock.calls).toEqual([['s1'], ['s1']]);
  });
});

describe('GhostTurnTranslator(status/done/error → did-turn-*)', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function makeTranslator(nowRef: { t: number }) {
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    const tr = new GhostTurnTranslator({
      sessionId: 's1',
      agent: 'claude-code',
      model: 'opus',
      now: () => nowRef.t,
      graceMs: 500,
      sink: {
        turnStart: (d) => starts.push(d),
        turnEnd: (d) => ends.push(d),
      },
    });
    return { tr, starts, ends };
  }

  it('真实事件序(status false 先于 done):正常完成不误报 interrupted,usage 保住', () => {
    const nowRef = { t: 100 };
    const { tr, starts, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    expect(starts).toEqual([{ sessionId: 's1', agent: 'claude-code', model: 'opus' }]);
    nowRef.t = 2_600;
    // 两个 agent 的 translator 都是先推 status(false) 再推 done——宽限窗内
    // 的 done 定性为 completed,时长按 status(false) 时刻算。
    tr.handleEvent({ type: 'status', data: { isRunning: false } });
    expect(ends).toHaveLength(0); // 未定性,不出事件
    nowRef.t = 2_610;
    tr.handleEvent({
      type: 'done',
      data: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 7 } },
    });
    expect(ends).toEqual([
      {
        sessionId: 's1',
        agent: 'claude-code',
        model: 'opus',
        durationMs: 2_500,
        endReason: 'completed',
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 7 },
      },
    ]);
    // 宽限定时器已取消,到期不再补发 interrupted
    vi.advanceTimersByTime(1_000);
    expect(ends).toHaveLength(1);
  });

  it('claimed SDK boundaries keep one plugin turn open and accumulate usage', () => {
    const nowRef = { t: 0 };
    const { tr, starts, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });

    nowRef.t = 300;
    tr.handleEvent({
      type: 'status',
      data: { status: 'Done', isRunning: false },
      turnContinuationId: 7,
    });
    tr.handleEvent({
      type: 'done',
      data: { usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 4 } },
      turnContinuationId: 7,
    });
    expect(starts).toHaveLength(1);
    expect(ends).toHaveLength(0);

    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    expect(starts).toHaveLength(1);
    nowRef.t = 900;
    tr.handleEvent({ type: 'status', data: { status: 'Done', isRunning: false } });
    tr.handleEvent({
      type: 'done',
      data: { usage: { input_tokens: 3, output_tokens: 2, cache_creation_input_tokens: 6 } },
    });

    expect(ends).toEqual([
      {
        sessionId: 's1',
        agent: 'claude-code',
        model: 'opus',
        durationMs: 900,
        endReason: 'completed',
        usage: {
          inputTokens: 13,
          outputTokens: 7,
          cacheReadTokens: 4,
          cacheCreationTokens: 6,
        },
      },
    ]);
  });

  it('does not emit an empty usage object for zero-value continuation segments', () => {
    const nowRef = { t: 0 };
    const { tr, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    tr.handleEvent({
      type: 'done',
      data: { usage: { input_tokens: 0, output_tokens: 0 } },
      turnContinuationId: 8,
    });
    tr.handleEvent({
      type: 'done',
      data: { usage: { input_tokens: 0, output_tokens: 0 } },
    });

    expect(ends).toEqual([
      {
        sessionId: 's1',
        agent: 'claude-code',
        model: 'opus',
        durationMs: 0,
        endReason: 'completed',
      },
    ]);
  });

  it('status false 后宽限窗内无 done/error = interrupted;terminal error 定性 error', () => {
    const nowRef = { t: 0 };
    const { tr, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    nowRef.t = 800;
    tr.handleEvent({ type: 'status', data: { isRunning: false } });
    vi.advanceTimersByTime(500);
    expect(ends).toMatchObject([{ endReason: 'interrupted', durationMs: 800 }]);

    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    tr.handleEvent({ type: 'status', data: { isRunning: false } });
    tr.handleEvent({ type: 'error', data: { isTerminal: true } });
    expect(ends).toMatchObject([{ endReason: 'interrupted' }, { endReason: 'error' }]);
    vi.advanceTimersByTime(1_000); // error 已定性,宽限不再补发
    expect(ends).toHaveLength(2);
    // 非 turn 内的 done/error 忽略
    tr.handleEvent({ type: 'done', data: {} });
    expect(ends).toHaveLength(2);
  });

  it('closing 期间新 turn 开始:上一轮按 interrupted 收口,新一轮正常 start', () => {
    const nowRef = { t: 0 };
    const { tr, starts, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    tr.handleEvent({ type: 'status', data: { isRunning: false } });
    tr.handleEvent({ type: 'status', data: { isRunning: true } }); // 宽限未到期就开新轮
    expect(ends).toMatchObject([{ endReason: 'interrupted' }]);
    expect(starts).toHaveLength(2);
  });

  it('容错:done 先于 status false 的顺序也正确(running 态直接定性)', () => {
    const nowRef = { t: 0 };
    const { tr, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    tr.handleEvent({ type: 'done', data: {} });
    expect(ends).toMatchObject([{ endReason: 'completed' }]);
    tr.handleEvent({ type: 'status', data: { isRunning: false } }); // 迟到的 status 无副作用
    vi.advanceTimersByTime(1_000);
    expect(ends).toHaveLength(1);
  });

  // 拆线补发(#1286):会话关闭与 Session 实例替换都会跑 register.ts 的 disposer,
  // turn 在场时不补 end,插件的「AI 在忙」外层状态就永久卡在 working。
  it('拆线:running 态 dispose 补一条 interrupted,配对闭合', () => {
    const nowRef = { t: 1_000 };
    const { tr, starts, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    expect(starts).toHaveLength(1);
    nowRef.t = 3_400;
    tr.dispose();
    expect(ends).toEqual([
      {
        sessionId: 's1',
        agent: 'claude-code',
        model: 'opus',
        durationMs: 2_400,
        endReason: 'interrupted',
      },
    ]);
  });

  it('拆线:closing 态 dispose 只补一条,时长按 status(false) 时刻算,宽限定时器一并清掉', () => {
    const nowRef = { t: 0 };
    const { tr, ends } = makeTranslator(nowRef);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    nowRef.t = 700;
    tr.handleEvent({ type: 'status', data: { isRunning: false } });
    nowRef.t = 900; // 宽限窗内就被拆线
    tr.dispose();
    expect(ends).toMatchObject([{ endReason: 'interrupted', durationMs: 700 }]);
    vi.advanceTimersByTime(1_000);
    expect(ends).toHaveLength(1); // 定时器已清,不会补出第二条 end
  });

  it('拆线:idle 态 dispose 不发事件(实例替换只在会话空闲时落实,这是常态路径)', () => {
    const nowRef = { t: 0 };
    const { tr, starts, ends } = makeTranslator(nowRef);
    tr.dispose(); // 一个 turn 都没跑过
    expect(starts).toHaveLength(0);
    expect(ends).toHaveLength(0);
    tr.handleEvent({ type: 'status', data: { isRunning: true } });
    tr.handleEvent({ type: 'done', data: {} });
    expect(ends).toHaveLength(1);
    tr.dispose(); // 正常收口后再拆线,不重复补发
    expect(ends).toHaveLength(1);
    expect(starts).toHaveLength(1);
  });

  it('拆线:补发的 end 与 start 报同一个 agent(不退回 DB 的 agent_kind)', () => {
    const nowRef = { t: 0 };
    const starts: unknown[] = [];
    const ends: unknown[] = [];
    // opts.agent 取 sessions.agent_kind 的真实取值('cc',见 localDb/schema.ts),
    // 事件 source 则是 'claude-code'——两者取值域不同,补发退回 opts.agent 会让
    // 同一对 start/end 报不同 agent,按 agent 分组的插件照样配不上。
    const tr = new GhostTurnTranslator({
      sessionId: 's1',
      agent: 'cc',
      now: () => nowRef.t,
      graceMs: 500,
      sink: { turnStart: (d) => starts.push(d), turnEnd: (d) => ends.push(d) },
    });
    tr.handleEvent({ type: 'status', data: { isRunning: true }, source: 'claude-code' });
    expect(starts).toMatchObject([{ agent: 'claude-code' }]);
    nowRef.t = 1_200;
    tr.dispose();
    expect(ends).toMatchObject([
      { agent: 'claude-code', endReason: 'interrupted', durationMs: 1_200 },
    ]);
  });

  it('normalizeTurnUsage:cc snake_case / codex(promptTokens 系)/ 通用 camelCase 都认', () => {
    expect(normalizeTurnUsage({ inputTokens: 1, cachedInputTokens: 2 })).toEqual({
      inputTokens: 1,
      cacheReadTokens: 2,
    });
    expect(normalizeTurnUsage({ cache_creation_input_tokens: 3 })).toEqual({
      cacheCreationTokens: 3,
    });
    // codex translator 的真实形态(packages/maker-core codex index)
    expect(
      normalizeTurnUsage({ promptTokens: 100, completionTokens: 40, reasoningTokens: 9, cachedTokens: 60 }),
    ).toEqual({ inputTokens: 100, outputTokens: 40, cacheReadTokens: 60 });
    expect(normalizeTurnUsage({})).toBeUndefined();
    expect(normalizeTurnUsage('x')).toBeUndefined();
  });
});

describe('readStatusIsRunning', () => {
  it('只认 status 事件,data 形状不对按 false', () => {
    expect(readStatusIsRunning({ type: 'status', data: { isRunning: true } })).toBe(true);
    expect(readStatusIsRunning({ type: 'status', data: { isRunning: false } })).toBe(false);
    // 非布尔真值不认(避免 'true' / 1 之类被当成在跑)
    expect(readStatusIsRunning({ type: 'status', data: { isRunning: 'true' } })).toBe(false);
    expect(readStatusIsRunning({ type: 'status', data: undefined })).toBe(false);
    expect(readStatusIsRunning({ type: 'status', data: null })).toBe(false);
    // null 表示"不是轮次起点判断的对象",与 false 语义不同
    expect(readStatusIsRunning({ type: 'done', data: {} })).toBeNull();
    expect(readStatusIsRunning({ type: 'thinking', data: {} })).toBeNull();
  });
});

describe('ghostActivityId(标识对外投影)', () => {
  it('确定性:同会话同上游 id 恒定同值 —— start / end 才能配上', () => {
    expect(ghostActivityId('s1', 'req-1')).toBe(ghostActivityId('s1', 'req-1'));
  });

  it('不透传上游原值,也不含其中任何语义片段', () => {
    // codex MCP elicitation 的真实形态(codex/index.ts:4699)——serverName 拼在里头
    const upstream = 'mcp-elicitation:cindy-github:turn-7:3';
    const projected = ghostActivityId('s1', upstream);
    expect(projected).not.toBe(upstream);
    expect(projected).not.toContain('cindy-github');
    expect(projected).not.toContain('mcp-elicitation');
    // codex 计划审批前缀同样不外泄("这是计划审批"本身也是信息)
    expect(ghostActivityId('s1', 'codex-plan-review:turn-7:1')).not.toContain('plan-review');
    expect(projected).toMatch(/^[0-9a-f]{16}$/);
  });

  it('掺 sessionId:同一个上游 id 在不同会话得到不同值,不给跨会话关联留口', () => {
    expect(ghostActivityId('s1', 'req-1')).not.toBe(ghostActivityId('s2', 'req-1'));
  });

  it('不同上游 id 在同会话内不同值', () => {
    expect(ghostActivityId('s1', 'req-1')).not.toBe(ghostActivityId('s1', 'req-2'));
  });

  it('带长度前缀拼接:边界组合不撞车', () => {
    // 若直接用分隔符拼接,('s1:x','y') 与 ('s1','x:y') 之类可能拼出同一个串
    expect(ghostActivityId('s1:x', 'y')).not.toBe(ghostActivityId('s1', 'x:y'));
  });
});

describe('GhostTapPendingQueue', () => {
  const ev = (n: number) => ({ type: 'event' as const, event: { type: `e${n}` } });
  const act = (phase: 'start' | 'end', requestId: string) => ({
    type: 'activity' as const,
    phase,
    request: { kind: 'permission' as const, requestId },
  });

  it('封顶前照收,drain 取快照并清空', () => {
    const q = new GhostTapPendingQueue(3);
    q.push(ev(1));
    q.push(ev(2));
    expect(q.size).toBe(2);
    expect(q.drain().map((i) => (i.type === 'event' ? i.event.type : ''))).toEqual(['e1', 'e2']);
    expect(q.size).toBe(0);
    expect(q.dropped).toBe(0);
  });

  it('溢出丢最旧,首次溢出只回调一次', () => {
    const onFirstOverflow = vi.fn();
    const q = new GhostTapPendingQueue(2, onFirstOverflow);
    q.push(ev(1));
    q.push(ev(2));
    q.push(ev(3));
    q.push(ev(4));
    expect(q.size).toBe(2);
    expect(q.dropped).toBe(2);
    expect(onFirstOverflow).toHaveBeenCalledOnce();
    expect(q.drain().map((i) => (i.type === 'event' ? i.event.type : ''))).toEqual(['e3', 'e4']);
  });

  it('丢最旧不留孤儿 start:留下的一定是到达序的后缀', () => {
    const q = new GhostTapPendingQueue(3);
    q.push(act('start', 'p1'));
    q.push(ev(1));
    q.push(ev(2));
    // 满了:挤掉队首的 start,end 照常入队 —— 落单的 end 在下游是 no-op。
    q.push(act('end', 'p1'));
    expect(q.dropped).toBe(1);
    const items = q.drain();
    expect(items.map((i) => (i.type === 'event' ? i.event.type : i.phase))).toEqual([
      'e1',
      'e2',
      'end',
    ]);
  });

  it('普通 event 与 activity 同规则:收口事件永远留在队尾,不必按类型配对压缩', () => {
    const q = new GhostTapPendingQueue(2);
    q.push(ev(1)); // thinking start
    q.push(ev(2)); // delta…
    q.push(act('start', 'p1'));
    q.push(ev(3)); // status(false) / done 这类终态
    expect(q.dropped).toBe(2);
    expect(q.drain().map((i) => (i.type === 'event' ? i.event.type : i.phase))).toEqual([
      'start',
      'e3',
    ]);
  });
});

describe('GhostTurnOriginTracker', () => {
  it('缺省放行用户 Desktop:首个轮次起点到达前也认', () => {
    const origin = new GhostTurnOriginTracker();
    expect(origin.acceptsInteraction(undefined)).toBe(true);
    expect(origin.acceptsInteraction({ origin: { kind: 'desktop' } })).toBe(true);
  });

  it('非 desktop route 直接挡掉(IM / hook 的 channel-card / headless 面)', () => {
    const origin = new GhostTurnOriginTracker();
    expect(origin.acceptsInteraction({ origin: { kind: 'im' } })).toBe(false);
    expect(origin.acceptsInteraction({ origin: { kind: 'hook' } })).toBe(false);
    expect(origin.acceptsInteraction({ origin: { kind: 'scheduler' } })).toBe(false);
  });

  it('goal / scheduler 直发(无 route)靠事件流上的轮次来源挡掉', () => {
    const origin = new GhostTurnOriginTracker();
    // goal 续跑:GoalController 直发 session.send,router 侧没有 route
    origin.noteEvent({ type: 'status', data: { isRunning: true }, turnOrigin: { kind: 'goal' } });
    expect(origin.acceptsInteraction(undefined)).toBe(false);
    // 轮次终态之后 origin 会被 Session 清空,但不能因此放行(codex 计划审批就在终态后)
    origin.noteEvent({ type: 'status', data: { isRunning: false } });
    origin.noteEvent({ type: 'done', data: {} });
    expect(origin.acceptsInteraction(undefined)).toBe(false);

    origin.noteEvent({
      type: 'status',
      data: { isRunning: true },
      turnOrigin: { kind: 'scheduler' },
    });
    expect(origin.acceptsInteraction(undefined)).toBe(false);
  });

  it('自动化轮次之后的用户轮次要恢复放行(不带 turnOrigin = Desktop 直发)', () => {
    const origin = new GhostTurnOriginTracker();
    origin.noteEvent({ type: 'status', data: { isRunning: true }, turnOrigin: { kind: 'goal' } });
    expect(origin.acceptsInteraction(undefined)).toBe(false);
    // Desktop 的 send 不传 origin,Session 就不会给事件打 turnOrigin
    origin.noteEvent({ type: 'status', data: { isRunning: true } });
    expect(origin.acceptsInteraction(undefined)).toBe(true);
  });

  it('只有轮次起点更新来源:轮次中途的事件不会把 goal 抹回 user', () => {
    const origin = new GhostTurnOriginTracker();
    origin.noteEvent({ type: 'status', data: { isRunning: true }, turnOrigin: { kind: 'goal' } });
    // 中途事件在 Session 清空 origin 后不带 turnOrigin,逐事件更新就会误判
    origin.noteEvent({ type: 'thinking', data: { stage: 'start', blockId: 'b1' } });
    origin.noteEvent({ type: 'assistant', data: {} });
    expect(origin.acceptsInteraction(undefined)).toBe(false);
  });
});
