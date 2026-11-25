import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestUtilityText: vi.fn() }));
const { requestUtilityText } = mocks;
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: mocks.requestUtilityText,
}));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));

import { noteLeadDispatchFact } from '../orcaDispatchClaims.js';
import {
  arrearsCount,
  arrearsDue,
  clearWorkerArrears,
  evaluateTurnGate,
  forgetTurnGate,
  judgeDispatchClaim,
  leadSettleCount,
  markArrearsNudged,
  markTurnGateHandled,
  noteLeadSettle,
  noteTurnEvent,
  noteWorkerReportArrears,
  turnGateHandled,
  currentTurnGeneration,
  turnOrcaToolUseCount,
  turnToolUseCount,
} from '../orcaTurnGate.js';

beforeEach(() => {
  forgetTurnGate();
  requestUtilityText.mockReset();
});

describe('turn tool-use counter', () => {
  it('counts only the matching session and generation', () => {
    noteTurnEvent('lead-1', 3, 'Read');
    noteTurnEvent('lead-1', 3, 'Read');
    noteTurnEvent('lead-1', 4, 'Read');
    expect(turnToolUseCount('lead-1', 3)).toBe(2);
    expect(turnToolUseCount('lead-1', 4)).toBe(1);
    expect(turnToolUseCount('lead-2', 3)).toBe(0);
  });

  it('drops everything for a session when its runtime goes away', () => {
    noteTurnEvent('lead-1', 3, 'Read');
    noteTurnEvent('lead-2', 3, 'Read');
    forgetTurnGate('lead-1');
    expect(turnToolUseCount('lead-1', 3)).toBe(0);
    expect(turnToolUseCount('lead-2', 3)).toBe(1);
  });

  it('tracks the turn generation even when the turn used no tool at all', () => {
    // 无工具回合没有任何 tool_use；代次只能靠每个事件都记，否则 Stop hook 会
    // 拿上一轮的代次去查凭据账。
    noteTurnEvent('lead-gen', 2);
    noteTurnEvent('lead-gen', 5);
    expect(currentTurnGeneration('lead-gen')).toBe(5);
    expect(turnToolUseCount('lead-gen', 5)).toBe(0);
  });

  it('separates Orca tool use from unrelated tools', () => {
    noteTurnEvent('lead-1', 3, 'Read');
    noteTurnEvent('lead-1', 3, 'Bash');
    expect(turnToolUseCount('lead-1', 3)).toBe(2);
    expect(turnOrcaToolUseCount('lead-1', 3)).toBe(0);

    noteTurnEvent('lead-1', 3, 'send_to_worker');
    expect(turnOrcaToolUseCount('lead-1', 3)).toBe(1);
  });

  it('drops counts when the session instance restarts with the same generation', () => {
    noteTurnEvent('lead-1', 1, 'Read', 100);
    expect(turnToolUseCount('lead-1', 1, 100)).toBe(1);
    // 新实例从代次 1 重新数：旧实例同一代次的计数不能继承。
    expect(turnToolUseCount('lead-1', 1, 200)).toBe(0);
    noteTurnEvent('lead-1', 1, 'Read', 200);
    expect(turnToolUseCount('lead-1', 1, 200)).toBe(1);
  });

  it('remembers which turns an engine-side gate already judged, per instance', () => {
    expect(turnGateHandled('lead-1', 2, 100)).toBe(false);
    markTurnGateHandled('lead-1', 2, 100);
    expect(turnGateHandled('lead-1', 2, 100)).toBe(true);
    expect(turnGateHandled('lead-1', 2, 200)).toBe(false);
    // 一个会话只能有一个否决点：引擎判过的回合，宿主 settle 必须看得到。
    expect(turnGateHandled('lead-1', 3, 100)).toBe(false);
  });
});

describe('dispatch claim judge', () => {
  const base = { leadSessionId: 'lead-1', turnGeneration: 1, workerLabels: ['research'] };

  it('reports a claim when the judge says claim', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    await expect(judgeDispatchClaim({ ...base, finalText: '已派给它了。' })).resolves.toBe(
      'claim',
    );
  });

  it('stays quiet only when the judge answers exactly quiet', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await expect(judgeDispatchClaim({ ...base, finalText: '修完了，综述如下。' })).resolves.toBe(
      'quiet',
    );
  });

  it('treats an ambiguous answer as unavailable instead of guessing', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'no claim' });
    await expect(judgeDispatchClaim({ ...base, finalText: '修完了。' })).resolves.toBe(
      'unavailable',
    );
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim or quiet' });
    await expect(judgeDispatchClaim({ ...base, finalText: '修完了。' })).resolves.toBe(
      'unavailable',
    );
  });

  it('fails open when the utility model throws', async () => {
    requestUtilityText.mockRejectedValue(new Error('timeout'));
    await expect(judgeDispatchClaim({ ...base, finalText: '已派。' })).resolves.toBe('unavailable');
  });

  it('skips the model for empty text and caches one verdict per turn and text', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    await expect(judgeDispatchClaim({ ...base, finalText: '   ' })).resolves.toBe('quiet');
    expect(requestUtilityText).toHaveBeenCalledTimes(0);

    await judgeDispatchClaim({ ...base, finalText: '已派。' });
    await judgeDispatchClaim({ ...base, finalText: '已派。' });
    expect(requestUtilityText).toHaveBeenCalledTimes(1);
  });
});

describe('worker arrears', () => {
  const report = { leadSessionId: 'lead-1', workerId: 'w-1', workerLabel: 'research' };

  it('records a waiting worker that left a question', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '删净还是保留？' });
    expect(arrearsCount('lead-1')).toBe(1);
  });

  it('ignores reports without waiting state or without a question', () => {
    noteWorkerReportArrears({ ...report, state: 'ready', question: '删净还是保留？' });
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '   ' });
    expect(arrearsCount('lead-1')).toBe(0);
  });

  it('withdraws the arrear when the worker reports a settled state', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteWorkerReportArrears({ ...report, state: 'ready', question: '问题' });
    expect(arrearsCount('lead-1')).toBe(0);
  });

  it('waits one turn, then becomes due, and is cleared by a real dispatch', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteLeadSettle('lead-1');
    expect(arrearsDue('lead-1')).toHaveLength(0);
    noteLeadSettle('lead-1');
    expect(arrearsDue('lead-1')).toHaveLength(1);

    clearWorkerArrears('lead-1', 'w-1');
    expect(arrearsDue('lead-1')).toHaveLength(0);
  });

  it('nudges an arrear only once', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteLeadSettle('lead-1');
    noteLeadSettle('lead-1');
    markArrearsNudged('lead-1', 'w-1');
    noteLeadSettle('lead-1');
    expect(arrearsDue('lead-1')).toHaveLength(0);
  });

  it('keeps leads apart and clears arrears with the session', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteLeadSettle('lead-1');
    noteLeadSettle('lead-1');
    expect(arrearsDue('lead-2')).toHaveLength(0);
    expect(leadSettleCount('lead-1')).toBe(2);

    forgetTurnGate('lead-1');
    expect(arrearsCount('lead-1')).toBe(0);
    expect(leadSettleCount('lead-1')).toBe(0);
  });
});

describe('gate trigger scope', () => {
  const base = { leadSessionId: 'lead-1', turnGeneration: 2, workerLabels: ['research'] };

  it('keeps the judge out once the host has a dispatch to point at', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-earlier',
      delivery: 'queued',
      turnGeneration: 1,
      at: Date.now() - 60_000,
    });
    // 账本里就有一笔真派发，「已经交给 research」是对它的复述；
    // 单回合文本分不清复述与新声称，宁可不判，也不要纠正真话。
    await expect(evaluateTurnGate({ ...base, finalText: '已派给它了。' })).resolves.toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('lets a dispatch that landed a moment ago pass, whatever its generation says', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    // 写入与判定两侧各取一次轮次，异步投递落地时常常错开一轮。
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-this-turn',
      delivery: 'queued',
      turnGeneration: 99,
      at: Date.now(),
    });
    await expect(evaluateTurnGate({ ...base, finalText: '已派给它了。' })).resolves.toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('still judges a claim that names a worker the ledger never dispatched to', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    // 这个会话昨天真派过 research；今天说「已派给 developer2」而账本里没有
    // 任何给 developer2 的凭据——这不是复述，宿主能核实。
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-yesterday',
      delivery: 'queued',
      turnGeneration: 1,
      at: Date.now() - 60_000,
    });
    await expect(
      evaluateTurnGate({
        ...base,
        workerLabels: ['research', 'developer2'],
        finalText: '已改派给 developer2 了。',
      }),
    ).resolves.toBeTruthy();
    expect(requestUtilityText).toHaveBeenCalledTimes(1);
  });

  it('tells the judge that a denial is not a claim', async () => {
    // 判定器是模型，唯一能固定下来的就是「否认」这条指令：没有它，
    // 一句「本轮没有派单」会被判成声称已派，同一个回合反复纠正。
    let seen = '';
    requestUtilityText.mockImplementation((_maker: unknown, prompt: string) => {
      seen = prompt;
      return Promise.resolve({ ok: true, text: 'quiet' });
    });
    await judgeDispatchClaim({
      leadSessionId: 'lead-1',
      turnGeneration: 1,
      workerLabels: ['research'],
      finalText: '本轮没有派单。',
    });
    expect(seen).toContain('denies having dispatched');
  });

  it('still treats a namespaced Orca tool name as Orca', () => {
    noteTurnEvent('lead-1', 2, 'mcp__cindy__send_to_worker');
    expect(turnOrcaToolUseCount('lead-1', 2)).toBe(1);
  });

  it('judges every turn, so insisting on the next turn is still corrected', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const lead = { ...base, leadSessionId: 'lead-repeat' };
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 2, finalText: '这次已经交给 research 了。' }),
    ).resolves.toBeTruthy();
    // 同一轮不重复叫醒：模型在纠正回合里解释不会陷入来回空转。
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 2, finalText: '这次已经交给 research 了。' }),
    ).resolves.toBeUndefined();
    // 不绑会话也不看时间窗：下一轮仍然坚持，就是新的声称。
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 3, finalText: '已经交给 research 在做了。' }),
    ).resolves.toBeTruthy();
  });
});
