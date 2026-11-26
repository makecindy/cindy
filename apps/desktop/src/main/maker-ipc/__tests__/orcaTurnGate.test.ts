import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestUtilityText: vi.fn() }));
const { requestUtilityText } = mocks;
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: mocks.requestUtilityText,
}));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));

import { noteLeadDispatchFact, resetDispatchClaimState } from '../orcaDispatchClaims.js';
import {
  JUDGE_TEXT_LIMIT,
  MAX_PRIOR_DISPATCH_LINES,
  currentTurnSeq,
  evaluateTurnGate,
  forgetTurnGate,
  judgeDispatchClaim,
  markTurnGateHandled,
  noteTurnEvent,
  turnGateHandled,
} from '../orcaTurnGate.js';

const WORKERS = [{ label: 'developer2', status: 'running' }];

beforeEach(() => {
  forgetTurnGate();
  resetDispatchClaimState();
  requestUtilityText.mockReset();
});

describe('turn numbering', () => {
  it('opens a new turn number when the engine generation advances', () => {
    noteTurnEvent('lead-1', 1);
    expect(currentTurnSeq('lead-1')).toBe(1);
    noteTurnEvent('lead-1', 2);
    expect(currentTurnSeq('lead-1')).toBe(2);
  });

  it('keeps the same number for later events of the same turn', () => {
    // 一个回合会产生很多事件；每来一个就开新号会让同一回合被判很多次。
    noteTurnEvent('lead-1', 7);
    noteTurnEvent('lead-1', 7);
    noteTurnEvent('lead-1', 7);
    expect(currentTurnSeq('lead-1')).toBe(1);
  });

  it('never reuses a number after the instance restarts counting', () => {
    // 引擎侧代次会从 1 重数；宿主这里只增不减，否则新会话的第 1 回合会继承
    // 旧会话第 1 回合的「已判」标记而静默放过。
    noteTurnEvent('lead-1', 5);
    noteTurnEvent('lead-1', 1);
    expect(currentTurnSeq('lead-1')).toBe(2);
    expect(turnGateHandled('lead-1', 1)).toBe(false);
  });

  it('reports 0 for a session the host has never seen', () => {
    expect(currentTurnSeq('nobody')).toBe(0);
  });
});

describe('claimed-turn bookkeeping', () => {
  it('marks one turn once and leaves the next turn unmarked', () => {
    markTurnGateHandled('lead-1', 1);
    expect(turnGateHandled('lead-1', 1)).toBe(true);
    expect(turnGateHandled('lead-1', 2)).toBe(false);
  });

  it('forgets one session without touching another', () => {
    markTurnGateHandled('lead-1', 1);
    markTurnGateHandled('lead-2', 1);
    forgetTurnGate('lead-1');
    expect(turnGateHandled('lead-1', 1)).toBe(false);
    expect(turnGateHandled('lead-2', 1)).toBe(true);
  });
});

describe('evaluateTurnGate: 凭据层', () => {
  it('flags a wake_kind the protocol never issues', async () => {
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '已交付，`wake_kind=teleported`。',
      workers: WORKERS,
    });
    expect(reason).toContain('You cited a dispatch result value the protocol never issues');
    expect(reason).toContain('teleported');
  });

  it('never judges a dispatch id, however unknown it is', async () => {
    // 凭据账只在内存里且有保留上限：重启或过期后，一条真实编号与编造的完全一样，
    // 所以编号本身不能当证据。这条守住「不核对编号」的裁决。
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '已派出（dispatch_id: d-999999，queued_message_id: q-888888）。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
  });

  it('accepts a wake_kind the protocol does issue', async () => {
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '到了，`wake_kind=resumed`。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
  });

  it('does not re-wake for the same fabricated value', async () => {
    const params = {
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '`wake_kind=teleported`',
      workers: WORKERS,
    };
    expect(await evaluateTurnGate(params)).toBeDefined();
    expect(await evaluateTurnGate(params)).toBeUndefined();
  });

  it('wakes again when the next turn cites another fabricated value', async () => {
    expect(
      await evaluateTurnGate({
        leadSessionId: 'lead-1',
        turnSeq: 1,
        finalText: '`wake_kind=teleported`',
        workers: WORKERS,
      }),
    ).toBeDefined();
    expect(
      await evaluateTurnGate({
        leadSessionId: 'lead-1',
        turnSeq: 2,
        finalText: '`wake_kind=wormholed`',
        workers: WORKERS,
      }),
    ).toBeDefined();
  });
});

describe('evaluateTurnGate: 免检与触发', () => {
  it('passes a turn that dispatched to this very worker', async () => {
    noteLeadDispatchFact('lead-1', {
      workerId: 'worker-1',
      workerLabel: 'developer2',
      dispatchId: 'c-1',
      turnSeq: 1,
      delivery: 'direct',
      at: Date.now(),
    });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '已派给 developer2 了。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('judges a claim made right after the previous turn dispatched', async () => {
    // 「上一轮派过」不能替本轮作证。
    noteLeadDispatchFact('lead-1', {
      workerId: 'worker-1',
      workerLabel: 'developer2',
      dispatchId: 'c-1',
      turnSeq: 1,
      delivery: 'direct',
      at: Date.now(),
    });
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 2,
      finalText: '已经派给 developer2 了。',
      workers: WORKERS,
    });
    expect(reason).toContain('This turn dispatched nothing');
  });

  it('skips a plain report that names no worker and uses no dispatch verb', async () => {
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '这两条 SQL 都只读，第二条返回 0 行就说明旧班名不是主线。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('judges a claim that names a worker without any dispatch verb', async () => {
    // `在跑了` 这类说法没有动词，点名就必须判，否则粗筛会漏掉一整类声称。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: 'developer2 那边已经在跑了。',
      workers: WORKERS,
    });
    expect(reason).toContain('This turn dispatched nothing');
    expect(requestUtilityText).toHaveBeenCalledTimes(1);
  });

  it('passes when the judge answers quiet', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '还没派，等你确认口径。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
  });

  it('does not interrupt for a plan that has not happened yet', async () => {
    // 「下一步安排」是计划，不是声称；判官说 quiet 时用户不该看到纠正。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '下一步安排 developer2 去做 Q2 取证，等它回来我再汇总。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
    expect(String(requestUtilityText.mock.calls[0]?.[1] ?? '')).toContain('not a claim');
  });

  it('passes when the judge is unavailable, and does not remember that verdict', async () => {
    // 判官超时不能等于「这一回合永久放过」：下一出口还得能再判一次。
    requestUtilityText.mockRejectedValueOnce(new Error('timeout'));
    const params = {
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '已经派给 developer2 了。',
      workers: WORKERS,
    };
    expect(await evaluateTurnGate(params)).toBeUndefined();
    // 同一回合的第二个出口可以再判一次，并如实给出结论。
    requestUtilityText.mockResolvedValueOnce({ ok: true, text: 'claim' });
    expect(await evaluateTurnGate(params)).toContain('This turn dispatched nothing');
  });

  it('needs a real turn number to judge anything', async () => {
    // 拿不到回合号 = 宿主还没见过这一回合：无法认领就不要下结论。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const reason = await evaluateTurnGate({
      leadSessionId: 'lead-1',
      turnSeq: 0,
      finalText: '已派给 developer2 了。',
      workers: WORKERS,
    });
    expect(reason).toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('judges each of two turns that end with identical text', async () => {
    // 定时任务与唤醒重投会连续发同样的话；按文本归并会把第二回合漏掉。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const text = '已经派给 developer2 了。';
    expect(await evaluateTurnGate({ leadSessionId: 'lead-1', turnSeq: 1, finalText: text, workers: WORKERS }))
      .toBeDefined();
    expect(await evaluateTurnGate({ leadSessionId: 'lead-1', turnSeq: 2, finalText: text, workers: WORKERS }))
      .toBeDefined();
    expect(requestUtilityText).toHaveBeenCalledTimes(2);
  });
});

describe('judgeDispatchClaim', () => {
  it('sends the whole closing text instead of a slice', async () => {
    // 派发证据可能落在中段：首尾截取会漏，切块会切坏句子。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const text = `${'普通汇报。'.repeat(400)}已经派给 developer2 了。${'继续收尾。'.repeat(400)}`;
    await judgeDispatchClaim({ leadSessionId: 'lead-1', turnSeq: 1, finalText: text, workerLabels: ['developer2'] });
    const sent = requestUtilityText.mock.calls[0]![1] as string;
    expect(sent).toContain(text);
  });

  it('skips an oversized turn without caching the skip', async () => {
    const text = 'x'.repeat(JUDGE_TEXT_LIMIT + 1);
    const first = await judgeDispatchClaim({ leadSessionId: 'lead-1', turnSeq: 1, finalText: text });
    expect(first).toBe('unavailable');
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('tells the judge which handoffs the host already recorded', async () => {
    noteLeadDispatchFact('lead-1', {
      workerId: 'worker-1',
      workerLabel: 'research',
      dispatchId: 'q-1',
      turnSeq: 1,
      delivery: 'queued',
      queuedMessageId: 'q-1',
      at: Date.now(),
    });
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await judgeDispatchClaim({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: 'research 那条是上一轮派的。',
      workerLabels: ['research'],
      priorDispatches: ['  research — accepted an earlier turn, delivery queued, worker status running'],
    });
    const sent = requestUtilityText.mock.calls[0]![1] as string;
    expect(sent).toContain('accepted an earlier turn');
  });

  it('caps how many earlier handoffs it shows', async () => {
    const many = Array.from({ length: MAX_PRIOR_DISPATCH_LINES + 5 }, (_, index) => `  w${index}`);
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await judgeDispatchClaim({
      leadSessionId: 'lead-1',
      turnSeq: 1,
      finalText: '已经派了。',
      workerLabels: ['w0'],
      priorDispatches: many.slice(0, MAX_PRIOR_DISPATCH_LINES),
    });
    const sent = requestUtilityText.mock.calls[0]![1] as string;
    expect(sent).toContain(`w${MAX_PRIOR_DISPATCH_LINES - 1}`);
    expect(sent).not.toContain(`w${MAX_PRIOR_DISPATCH_LINES}`);
  });
});
