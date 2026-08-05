/**
 * subscriptionGateway.test.ts — 订阅槽网关单测(纯 DI,假时钟,无 Electron)。
 * 覆盖:did- 扇出(topic 白名单/停用忽略)、熄灯缓冲+唤醒补投+溢出丢最旧
 * 带 dropped、seq 单调;will- 串行短路、超时 fail-open、熔断降级、verdict
 * 归属校验、reason 截断;turn 翻译器状态机与 usage 归一化。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  GhostSubscriptionGateway,
  GhostTurnTranslator,
  createGhostSessionFocusTracker,
  isGhostEligibleSessionRow,
  normalizeTurnUsage,
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
    expect(sent.map((s) => s.ghostId)).toEqual(['a', 'a']);
    expect(sent.map((s) => (s.payload as { seq: number }).seq)).toEqual([1, 2]);
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
