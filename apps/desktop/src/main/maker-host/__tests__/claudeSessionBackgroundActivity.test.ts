/**
 * claude-session-background-activity 单测 —— 锁四条核心语义:
 *  1. turn 结束后的 API 活动(超过宽限)才点亮;turn 期间 / 收尾余波不点亮;
 *  2. 静默超窗自动熄灭(定时器路径),期间持续活动则续档;
 *  3. sdkSessionId 粘滞缓存:rewind 换新 id 后,旧 id 的遗留子 agent 请求仍能归因;
 *  4. 重复 not-running 状态不得推后 turn 结束时刻(否则后台活动被永久掩盖)。
 *  5. 插件引擎回合外工作(回合外输出、回合结束仍未完成的工具调用)点亮同一份状态并通知
 *     Agent Island;没有回合外工作的插件不触发。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent } from '@cindy/maker-core';
import {
  clearClaudeSessionBackgroundActivity,
  createClaudeSessionActivityResponseObserver,
  getClaudeSessionBackgroundActivity,
  hasWorkingBackgroundCommand,
  listActiveClaudeBackgroundActivitySessions,
  listClaudeBackgroundCommandWorkSessions,
  noteClaudeSessionBackgroundCommandWork,
  noteClaudeSessionTurnState,
  observePluginEngineEvent,
  recordClaudeApiActivity,
  resetClaudeBackgroundActivityForTests,
  setClaudeBackgroundActivityBroadcaster,
  setClaudeBackgroundCommandWorkBroadcaster,
  setPluginEngineBackgroundWorkListener,
} from '../claude-session-background-activity.js';

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

const ACTIVITY_WINDOW_MS = 30_000;
const TURN_END_GRACE_MS = 2_500;

describe('claude-session-background-activity', () => {
  let broadcasts: Array<{ sessionId: string; active: boolean }>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-13T12:00:00Z'));
    broadcasts = [];
    setClaudeBackgroundActivityBroadcaster((p) => broadcasts.push(p));
  });

  afterEach(() => {
    resetClaudeBackgroundActivityForTests();
    vi.useRealTimers();
  });

  function runTurn(sessionId: string, sdkId: string): void {
    noteClaudeSessionTurnState(sessionId, true);
    recordClaudeApiActivity(sdkId, sessionId); // turn 期间的主线流量(顺带建立粘滞映射)
    noteClaudeSessionTurnState(sessionId, false);
  }

  it('turn 结束后超过宽限的活动点亮;turn 期间与收尾余波不点亮', () => {
    const sid = 's1';
    noteClaudeSessionTurnState(sid, true);
    recordClaudeApiActivity('sdk-1', sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false); // turn 期间

    noteClaudeSessionTurnState(sid, false);
    vi.advanceTimersByTime(1_000);
    recordClaudeApiActivity('sdk-1', sid); // 宽限内的收尾余波
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);

    vi.advanceTimersByTime(TURN_END_GRACE_MS);
    recordClaudeApiActivity('sdk-1', sid); // 宽限之后仍有流量 = 后台任务
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
    expect(broadcasts).toContainEqual({ sessionId: sid, active: true });
  });

  it('静默超窗自动熄灭并广播;持续活动续档', () => {
    const sid = 's2';
    runTurn(sid, 'sdk-2');
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    recordClaudeApiActivity('sdk-2', sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

    // 持续活动:窗口过半再来一笔,不应熄灭
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS / 2);
    recordClaudeApiActivity('sdk-2', sid);
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS - 1_000);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

    // 静默到窗口之外 → 自动熄灭
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS + 1_000);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    expect(broadcasts.at(-1)).toEqual({ sessionId: sid, active: false });
  });

  it('粘滞缓存:rewind 换新 sdkSessionId 后,旧 id 的请求仍归因到会话', () => {
    const sid = 's3';
    runTurn(sid, 'sdk-old'); // sdk-old 在 turn 期间解析成功,进入粘滞缓存
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    // 遗留子 agent 拿旧 id 发请求,活跃会话表已换新 id → 解析返回 null
    recordClaudeApiActivity('sdk-old', null);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
    // 从未解析成功过的 id:无从归因,不点亮任何会话
    recordClaudeApiActivity('sdk-unknown', null);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
  });

  it('重复 not-running 边沿不推后 turn 结束时刻(后台活动不被掩盖)', () => {
    const sid = 's4';
    runTurn(sid, 'sdk-4');
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    noteClaudeSessionTurnState(sid, false); // 重复 false:必须是 no-op
    recordClaudeApiActivity('sdk-4', sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
  });

  it('新 turn 开始立即熄灭;clear 清账并广播熄灭', () => {
    const sid = 's5';
    runTurn(sid, 'sdk-5');
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    recordClaudeApiActivity('sdk-5', sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

    noteClaudeSessionTurnState(sid, true);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    expect(broadcasts.at(-1)).toEqual({ sessionId: sid, active: false });

    // 再次结束 turn 并点亮,然后 clear(模拟 closeSession)
    noteClaudeSessionTurnState(sid, false);
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    recordClaudeApiActivity('sdk-5', sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
    clearClaudeSessionBackgroundActivity(sid);
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    expect(broadcasts.at(-1)).toEqual({ sessionId: sid, active: false });
  });

  it('活跃会话列表:只含 active 会话,熄灭 / clear 后移出', () => {
    expect(listActiveClaudeBackgroundActivitySessions()).toEqual([]);

    // s-a 点亮,s-b 只跑 turn 未点亮 → 列表只含 s-a
    runTurn('s-a', 'sdk-a');
    runTurn('s-b', 'sdk-b');
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    recordClaudeApiActivity('sdk-a', 's-a');
    expect(listActiveClaudeBackgroundActivitySessions()).toEqual(['s-a']);

    // s-b 也点亮 → 两个都在
    recordClaudeApiActivity('sdk-b', 's-b');
    expect(new Set(listActiveClaudeBackgroundActivitySessions())).toEqual(new Set(['s-a', 's-b']));

    // clear s-a(closeSession)→ 只剩 s-b;s-b 静默超窗 → 空
    clearClaudeSessionBackgroundActivity('s-a');
    expect(listActiveClaudeBackgroundActivitySessions()).toEqual(['s-b']);
    vi.advanceTimersByTime(ACTIVITY_WINDOW_MS + 1_000);
    expect(listActiveClaudeBackgroundActivitySessions()).toEqual([]);
  });

  // 插件引擎回合外工作(2026-11-20 Antigravity):回答完仍在推分支、建 PR、定时查 CI,
  // 任务里看不出在跑。最小失败输入:回合结束时还有一条没报完成的工具调用 —— 旧实现在
  // 回合结束时一律熄灭。从没有回合外工作的插件不得触发。
  describe('插件引擎回合外工作', () => {
    let island: Array<[string, boolean, boolean]>;
    const toolUse = (id: string, turnScope?: 'background'): AgentEvent =>
      ({ type: 'tool_use', data: { toolUseId: id }, ...(turnScope ? { turnScope } : {}) });
    const toolResult = (id: string, turnScope?: 'background'): AgentEvent =>
      ({ type: 'tool_result', data: { toolUseIds: [id] }, ...(turnScope ? { turnScope } : {}) });

    beforeEach(() => {
      island = [];
      setPluginEngineBackgroundWorkListener((id, active, options) => island.push([id, active, options.turnStarting]));
    });

    it('回合结束仍有未完成的工具调用立即点亮,结果到达后按静默窗熄灭;没有回合外工作不触发', () => {
      noteClaudeSessionTurnState('quiet', true);
      observePluginEngineEvent('quiet', toolUse('read'));
      observePluginEngineEvent('quiet', toolResult('read'));
      noteClaudeSessionTurnState('quiet', false);
      vi.advanceTimersByTime(ACTIVITY_WINDOW_MS * 2);
      expect(getClaudeSessionBackgroundActivity('quiet')).toBe(false);

      const sid = 'agy';
      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, toolUse('commit'));
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      expect(broadcasts).toEqual([{ sessionId: sid, active: true }]);
      expect(island).toEqual([[sid, true, false]]);

      vi.advanceTimersByTime(21_000);
      observePluginEngineEvent(sid, toolResult('commit', 'background'));
      vi.advanceTimersByTime(ACTIVITY_WINDOW_MS - 1_000);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      vi.advanceTimersByTime(1_100);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
      expect(island.at(-1)).toEqual([sid, false, false]);
    });

    it('回合外输出点亮、新回合让位;只剩等待中的调用时最多亮到上限', () => {
      const sid = 'agy';
      noteClaudeSessionTurnState(sid, true);
      noteClaudeSessionTurnState(sid, false);
      observePluginEngineEvent(sid, { type: 'text', turnScope: 'background', data: { text: 'Pushing.', isFinal: true } });
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      noteClaudeSessionTurnState(sid, true);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
      expect(island).toEqual([[sid, true, false], [sid, false, true]]);

      noteClaudeSessionTurnState(sid, false);
      observePluginEngineEvent(sid, { ...toolUse('wait-for-ci', 'background'), source: 'antigravity' });
      vi.advanceTimersByTime(31 * 60_000 - 1_000);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      vi.advanceTimersByTime(1_100);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
      // Unit: an expired, still-unpaired ID must not make a later turn look busy.
      // The old test only covered the off edge, before the next pair of turn events.
      noteClaudeSessionTurnState(sid, true);
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    });

    // Unit, cd245937: replay a second turn ending before the first call's cap.
    // The existing expiry test only covered turns that start after the cap.
    it('does not relight an unexpired Antigravity call when a later turn completes', () => {
      const sid = 'agy';
      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, { ...toolUse('old-command'), source: 'antigravity' });
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

      vi.advanceTimersByTime(1_053_350);
      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, { ...toolUse('new-command'), source: 'antigravity' });
      observePluginEngineEvent(sid, { ...toolResult('new-command'), source: 'antigravity' });
      vi.advanceTimersByTime(58_765);
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);

      expect(broadcasts).toEqual([{ sessionId: sid, active: true }, { sessionId: sid, active: false }]);
      expect(island).toEqual([[sid, true, false], [sid, false, true]]);

      observePluginEngineEvent(sid, {
        type: 'text', source: 'antigravity', turnScope: 'background', data: { text: 'Other work.' },
      });
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      vi.advanceTimersByTime(ACTIVITY_WINDOW_MS + 100);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);

      observePluginEngineEvent(sid, { ...toolResult('old-command', 'background'), source: 'antigravity' });
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    });

    // Unit, cd245937: matching progress in the next turn can still prove work.
    // A different old ID in the same session must stay quiet when that work ends.
    it('relights only the Antigravity call that made progress during the later turn', () => {
      const sid = 'agy';
      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, { ...toolUse('quiet'), source: 'antigravity' });
      observePluginEngineEvent(sid, { ...toolUse('working'), source: 'antigravity' });
      noteClaudeSessionTurnState(sid, false);
      vi.advanceTimersByTime(5_000);

      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, {
        type: 'antigravity_tool_activity', source: 'antigravity', turnScope: 'background',
        data: { kind: 'tool_progress', toolUseId: 'working' },
      });
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

      observePluginEngineEvent(sid, { ...toolResult('working', 'background'), source: 'antigravity' });
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
      expect(island).toEqual([[sid, true, false], [sid, false, true], [sid, true, false], [sid, false, false]]);
    });

    // Unit, cd245937: a native shell exit can precede ACP tool results. Two
    // concurrent commands expose a session-wide clear or mixing the two IDs.
    it('clears only the Antigravity call linked to the native task that exited', () => {
      const sid = 'agy';
      const exit = (taskId: string, toolUseId: string) => observePluginEngineEvent(sid, {
        type: 'antigravity_tool_activity', source: 'antigravity', turnScope: 'background',
        data: { kind: 'command_exited', taskId, toolUseId },
      });
      noteClaudeSessionTurnState(sid, true);
      for (const i of ['1', '2']) {
        observePluginEngineEvent(sid, { ...toolUse(`call-${i}`), source: 'antigravity' });
      }
      noteClaudeSessionTurnState(sid, false);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);

      exit('task-1', 'call-1');
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      exit('task-2', 'call-2');
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    });

    // Unit: one post-turn text event is enough to extend a live ACP tool's
    // quiet window, even though Antigravity's unmatched IDs have a fixed cap.
    it('preserves the rolling quiet window for ACP with new background output', () => {
      const sid = 'acp';
      noteClaudeSessionTurnState(sid, true);
      observePluginEngineEvent(sid, toolUse('long-tool'));
      noteClaudeSessionTurnState(sid, false);
      vi.advanceTimersByTime(20 * 60_000);
      observePluginEngineEvent(sid, { type: 'text', turnScope: 'background', data: { text: 'Working.' } });
      vi.advanceTimersByTime(20 * 60_000);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
      vi.advanceTimersByTime(11 * 60_000 + 100);
      expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    });
  });

  // 「后台命令仍在工作」:回合收尾时测试、构建这类命令没跑完,任务列表要显示运行中而不是已结束
  // (与 Codex / Pi 命令没跑完回合就不结束一致)。长驻服务不算;只影响展示。
  describe('后台命令仍在工作', () => {
    const COMMAND_WORK_END_GRACE_MS = 5_000;
    let workBroadcasts: Array<{ sessionId: string; active: boolean }>;

    beforeEach(() => {
      workBroadcasts = [];
      setClaudeBackgroundCommandWorkBroadcaster((p) => workBroadcasts.push(p));
    });

    it('只把会自己结束的后台命令算作工作,长驻服务与其他任务类型不算', () => {
      expect(
        hasWorkingBackgroundCommand([
          { taskType: 'local_bash', backgroundCommandKind: 'service' },
          { taskType: 'local_agent' },
        ]),
      ).toBe(false);
      expect(hasWorkingBackgroundCommand([{ taskType: 'local_bash', backgroundCommandKind: 'work' }])).toBe(true);
      // 种类未知(没见过启动它的命令)按工作算。
      expect(hasWorkingBackgroundCommand([{ taskType: 'local_bash' }])).toBe(true);
    });

    it('回合在跑时不点亮;回合结束而命令仍在工作才点亮,新回合开始即让位', () => {
      const sid = 'w1';
      noteClaudeSessionTurnState(sid, true);
      noteClaudeSessionBackgroundCommandWork(sid, true);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([]);

      noteClaudeSessionTurnState(sid, false);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([sid]);
      expect(workBroadcasts).toEqual([{ sessionId: sid, active: true }]);

      noteClaudeSessionTurnState(sid, true);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([]);
      expect(workBroadcasts.at(-1)).toEqual({ sessionId: sid, active: false });
    });

    it('命令结束后保持到自动续跑的那一轮接上,中间不闪成已结束', () => {
      const sid = 'w2';
      noteClaudeSessionTurnState(sid, true);
      noteClaudeSessionBackgroundCommandWork(sid, true);
      noteClaudeSessionTurnState(sid, false);

      noteClaudeSessionBackgroundCommandWork(sid, false); // 命令跑完,CLI 即将自动开新一轮
      vi.advanceTimersByTime(COMMAND_WORK_END_GRACE_MS - 1);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([sid]);

      noteClaudeSessionTurnState(sid, true); // 续跑那一轮开始:运行态接管
      expect(workBroadcasts).toEqual([
        { sessionId: sid, active: true },
        { sessionId: sid, active: false },
      ]);
    });

    it('续跑没来时到点熄灭;关闭任务进程立即熄灭', () => {
      const sid = 'w3';
      noteClaudeSessionTurnState(sid, true);
      noteClaudeSessionBackgroundCommandWork(sid, true);
      noteClaudeSessionTurnState(sid, false);
      noteClaudeSessionBackgroundCommandWork(sid, false);
      vi.advanceTimersByTime(COMMAND_WORK_END_GRACE_MS);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([]);

      noteClaudeSessionBackgroundCommandWork(sid, true);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([sid]);
      clearClaudeSessionBackgroundActivity(sid);
      expect(listClaudeBackgroundCommandWorkSessions()).toEqual([]);
      expect(workBroadcasts.at(-1)).toEqual({ sessionId: sid, active: false });
    });
  });

  it('响应观察器:带会话标头才建 sink,onData 节流刷新活动', () => {
    const sid = 's6';
    runTurn(sid, 'sdk-6');
    const observer = createClaudeSessionActivityResponseObserver(() => sid);
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/v1/messages',
      upstreamBase: 'https://up',
      status: 200,
      responseHeaders: {},
      requestBody: Buffer.alloc(0),
    };
    expect(observer({ ...ctx, requestHeaders: {} })).toBeNull();

    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    const sink = observer({ ...ctx, requestHeaders: { 'x-claude-code-session-id': 'sdk-6' } });
    expect(sink).not.toBeNull();
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
    // 长流持续 onData:每次推进都在窗口内刷新,不熄灭
    for (let i = 0; i < 10; i += 1) {
      vi.advanceTimersByTime(10_000);
      sink?.onData?.(Buffer.from('data: {}\n'));
    }
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
  });

  // #8671: /context 卡片(getContextUsage,默认 detail:'full')让 CLI 对每类输入各发
  // 一笔 count_tokens 计量请求 —— 不生成 token、也不是后台子 agent 的采样流量。
  // 观察器与请求侧路由 transform(anthropic-compat-proxy-host)共用同一判据:这类
  // 探测不得点亮「后台子任务运行中」;真实 /v1/messages 采样仍照常点亮。URL 带
  // ?beta=true 是 SDK 实际发出的形态(providerUpstreamErrorObserver.test 已录),
  // 判据必须剥 query 后按后缀匹配。
  it('count_tokens 用量探测不点亮横幅;真实采样仍点亮', () => {
    const sid = 's7';
    runTurn(sid, 'sdk-7');
    const observer = createClaudeSessionActivityResponseObserver(() => sid);
    const ctx = {
      reqId: 1,
      method: 'POST',
      url: '/v1/messages/count_tokens?beta=true',
      upstreamBase: 'https://up',
      status: 200,
      responseHeaders: {},
      requestBody: Buffer.alloc(0),
      requestHeaders: { 'x-claude-code-session-id': 'sdk-7' },
    };
    vi.advanceTimersByTime(TURN_END_GRACE_MS + 100);
    expect(observer(ctx)).toBeNull();
    // 探测后立刻核查:若被误记为活动,此刻(宽限外的首笔)就会点亮。
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(false);
    expect(broadcasts).not.toContainEqual({ sessionId: sid, active: true });

    // 对照:同一时刻的真实采样请求照常建 sink 并点亮。
    const sink = observer({ ...ctx, url: '/v1/messages' });
    expect(sink).not.toBeNull();
    expect(getClaudeSessionBackgroundActivity(sid)).toBe(true);
  });
});
