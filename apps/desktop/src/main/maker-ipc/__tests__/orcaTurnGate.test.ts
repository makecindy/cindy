import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestUtilityText: vi.fn() }));
const { requestUtilityText } = mocks;
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: mocks.requestUtilityText,
}));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));

import {
  arrearsCount,
  arrearsDue,
  clearWorkerArrears,
  forgetTurnGate,
  judgeDispatchClaim,
  leadSettleCount,
  markArrearsNudged,
  markTurnGateHandled,
  noteLeadSettle,
  noteTurnToolUse,
  noteWorkerReportArrears,
  turnGateHandled,
  turnOrcaToolUseCount,
  turnToolUseCount,
} from '../orcaTurnGate.js';

beforeEach(() => {
  forgetTurnGate();
  requestUtilityText.mockReset();
});

describe('turn tool-use counter', () => {
  it('counts only the matching session and generation', () => {
    noteTurnToolUse('lead-1', 3);
    noteTurnToolUse('lead-1', 3);
    noteTurnToolUse('lead-1', 4);
    expect(turnToolUseCount('lead-1', 3)).toBe(2);
    expect(turnToolUseCount('lead-1', 4)).toBe(1);
    expect(turnToolUseCount('lead-2', 3)).toBe(0);
  });

  it('drops everything for a session when its runtime goes away', () => {
    noteTurnToolUse('lead-1', 3);
    noteTurnToolUse('lead-2', 3);
    forgetTurnGate('lead-1');
    expect(turnToolUseCount('lead-1', 3)).toBe(0);
    expect(turnToolUseCount('lead-2', 3)).toBe(1);
  });

  it('separates Orca tool use from unrelated tools', () => {
    noteTurnToolUse('lead-1', 3, 'Read');
    noteTurnToolUse('lead-1', 3, 'Bash');
    expect(turnToolUseCount('lead-1', 3)).toBe(2);
    expect(turnOrcaToolUseCount('lead-1', 3)).toBe(0);

    noteTurnToolUse('lead-1', 3, 'send_to_worker');
    expect(turnOrcaToolUseCount('lead-1', 3)).toBe(1);
  });

  it('drops counts when the session instance restarts with the same generation', () => {
    noteTurnToolUse('lead-1', 1, 'Read', 100);
    expect(turnToolUseCount('lead-1', 1, 100)).toBe(1);
    // 新实例从代次 1 重新数：旧实例同一代次的计数不能继承。
    expect(turnToolUseCount('lead-1', 1, 200)).toBe(0);
    noteTurnToolUse('lead-1', 1, 'Read', 200);
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
