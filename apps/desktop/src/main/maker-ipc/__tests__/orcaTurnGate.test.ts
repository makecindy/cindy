import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ requestUtilityText: vi.fn() }));
const { requestUtilityText } = mocks;
vi.mock('../../utility-model/oneShotCandidates.js', () => ({
  requestUtilityText: mocks.requestUtilityText,
}));
vi.mock('../../maker-host/index.js', () => ({ getMaker: () => ({}) }));

import { noteLeadDispatchFact, resetDispatchClaimState } from '../orcaDispatchClaims.js';
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
} from '../orcaTurnGate.js';

beforeEach(() => {
  forgetTurnGate();
  // 凭据账在另一个模块里，forgetTurnGate 清不掉它：不清就会把上一条用例
  // 一分钟内的派发带进来，让「本回合零派发」的用例静默变成「有派发」。
  resetDispatchClaimState();
  requestUtilityText.mockReset();
});

describe('turn generation tracking', () => {
  it('tracks the turn generation even when the turn used no tool at all', () => {
    // 无工具回合没有任何 tool_use；代次只能靠每个事件都记，否则 Stop hook 会
    // 拿上一轮的代次去查凭据账。
    noteTurnEvent('lead-gen', 2);
    noteTurnEvent('lead-gen', 5);
    expect(currentTurnGeneration('lead-gen')).toBe(5);
  });

  it('drops judgment state when the session instance starts counting again', () => {
    noteTurnEvent('lead-1', 3);
    markTurnGateHandled('lead-1', 'fp-3');
    expect(turnGateHandled('lead-1', 'fp-3')).toBe(true);

    // 会话被重建后代次从 1 重新数：旧代次的「已判」不能继承，否则新会话的
    // 第 3 回合会被当成判过而静默放过。
    noteTurnEvent('lead-1', 1);
    expect(turnGateHandled('lead-1', 'fp-3')).toBe(false);
  });

  it('forgets everything for one session without touching another', () => {
    noteTurnEvent('lead-1', 3);
    noteTurnEvent('lead-2', 3);
    forgetTurnGate('lead-1');
    expect(currentTurnGeneration('lead-1')).toBeUndefined();
    expect(currentTurnGeneration('lead-2')).toBe(3);
  });

  it('remembers which turns a gate already judged', () => {
    expect(turnGateHandled('lead-1', 'fp-a')).toBe(false);
    markTurnGateHandled('lead-1', 'fp-a');
    expect(turnGateHandled('lead-1', 'fp-a')).toBe(true);
    // 一个会话只能有一个否决点：引擎判过的回合，宿主 settle 必须看得到。
    expect(turnGateHandled('lead-1', 'fp-b')).toBe(false);
  });
});

describe('dispatch claim judge', () => {
  const base = {
    leadSessionId: 'lead-1',
    turnGeneration: 1,
    workers: [{ label: 'research', status: 'idle' }],
  };

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

  it('shows the judge the recorded handoffs so a restatement can stay quiet', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await judgeDispatchClaim({ ...base, finalText: '本轮没有派单。' });
    expect(String(requestUtilityText.mock.calls[0]?.[1] ?? '')).toContain('  (none)');

    requestUtilityText.mockClear();
    await judgeDispatchClaim({
      ...base,
      finalText: '上一轮已经派给 research 了。',
      priorDispatches: ['  research — accepted 1 turn(s) earlier, delivery direct, worker status running'],
    });
    const prompt = String(requestUtilityText.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('research — accepted 1 turn(s) earlier');
    // 判官只能靠「有账 / 没账」分辨复述与新声称；没账时它必须看到明确的 none。
    expect(prompt).not.toContain('  (none)');
  });

  it('judges a claim that sits in the middle of a long turn', async () => {
    // 一轮真实形态：先跑一堆测试、中途派单、再收尾一大段。凭据在中段，任何窗口都会漏。
    requestUtilityText.mockImplementation((_maker: unknown, prompt: string) =>
      Promise.resolve({ ok: true, text: prompt.includes('已派给 research 了') ? 'claim' : 'quiet' }),
    );
    const filler = '测试输出行\n\n'.repeat(400);
    const verdict = await judgeDispatchClaim({
      ...base,
      finalText: `${filler}已派给 research 了，凭据如下。\n\n${filler}`,
    });
    expect(verdict).toBe('claim');
  });

  it('sends the whole turn to the judge in one call', async () => {
    const marks = ['MARK-ALPHA', 'MARK-BRAVO', 'MARK-CHARLIE', 'MARK-DELTA', 'MARK-ECHO'];
    const filler = '无关明细。\n\n'.repeat(200);
    const text = marks.map((mark) => `${mark}\n\n${filler}`).join('');
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await judgeDispatchClaim({ ...base, finalText: text });

    // 不取窗口、不切块：一次调用就要把全文送进去，位置不参与判定。
    expect(requestUtilityText.mock.calls).toHaveLength(1);
    const prompt = String(requestUtilityText.mock.calls[0]?.[1] ?? '');
    for (const mark of marks) expect(prompt).toContain(mark);
  });

  it('passes instead of sampling when the turn is too long to read whole', async () => {
    // 抽样可能恰好漏掉声称，比不判更坏；超过上限就不判，并在日志里留下长度。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    await expect(
      judgeDispatchClaim({ ...base, finalText: '无关。'.repeat(20_000) }),
    ).resolves.toBe('unavailable');
    expect(requestUtilityText).not.toHaveBeenCalled();
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
    noteLeadSettle('lead-1', 'fp-1');
    expect(arrearsDue('lead-1')).toHaveLength(0);
    noteLeadSettle('lead-1', 'fp-2');
    expect(arrearsDue('lead-1')).toHaveLength(1);

    clearWorkerArrears('lead-1', 'w-1');
    expect(arrearsDue('lead-1')).toHaveLength(0);
  });

  it('nudges an arrear only once', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteLeadSettle('lead-1', 'fp-1');
    noteLeadSettle('lead-1', 'fp-2');
    markArrearsNudged('lead-1', 'w-1');
    noteLeadSettle('lead-1', 'fp-3');
    expect(arrearsDue('lead-1')).toHaveLength(0);
  });

  it('counts one settle per closing text, not per delivery', () => {
    // 两个出口（引擎 Stop hook 与宿主 settle）都会调 noteLeadSettle；同一段
    // 收口文本被数两次，「连续两个回合没回答」就变成一个回合。
    noteLeadSettle('lead-1', 'fp-same');
    noteLeadSettle('lead-1', 'fp-same');
    expect(leadSettleCount('lead-1')).toBe(1);
    noteLeadSettle('lead-1', 'fp-next');
    expect(leadSettleCount('lead-1')).toBe(2);
  });

  it('keeps leads apart and clears arrears with the session', () => {
    noteWorkerReportArrears({ ...report, state: 'waiting', question: '问题' });
    noteLeadSettle('lead-1', 'fp-1');
    noteLeadSettle('lead-1', 'fp-2');
    expect(arrearsDue('lead-2')).toHaveLength(0);
    expect(leadSettleCount('lead-1')).toBe(2);

    forgetTurnGate('lead-1');
    expect(arrearsCount('lead-1')).toBe(0);
    expect(leadSettleCount('lead-1')).toBe(0);
  });
});

describe('gate trigger scope', () => {
  const base = {
    leadSessionId: 'lead-1',
    turnGeneration: 2,
    workers: [{ label: 'research', status: 'idle' }],
  };

  it('keeps the judge out once the host has a dispatch to point at', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-earlier',
      delivery: 'queued',
      turnGeneration: 2,
      at: Date.now() - 10 * 60_000,
    });
    // 这一回合自己派过活：再判就成了纠正一句真话。
    await expect(evaluateTurnGate({ ...base, finalText: '已派给它了。' })).resolves.toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('exempts a dispatch accepted after the last close even when its turn number is stale', async () => {
    // Stop hook 可能在本轮事件到达前触发，那时 currentTurnGeneration 还停在上一轮。
    // 归属看「上一次收口之后落地」，不看代次等值：否则把握到本轮的派发漏掉，
    // 把一句真话判成假话。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-prev',
      delivery: 'queued',
      turnGeneration: 1,
      settlesAtAccept: 0,
      at: Date.now(),
    });
    await expect(
      evaluateTurnGate({ ...base, turnGeneration: 2, finalText: '已派给 research 了。' }),
    ).resolves.toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('still judges a claim whose ledger entry was accepted before an earlier close', async () => {
    // 同一张账，但那次投递在上一轮收口之前就落地了：它不属于本轮。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-old',
      delivery: 'queued',
      turnGeneration: 1,
      settlesAtAccept: 0,
      at: Date.now(),
    });
    await evaluateTurnGate({ ...base, turnGeneration: 1, finalText: '先记一条。' });
    requestUtilityText.mockClear();
    await expect(
      evaluateTurnGate({ ...base, turnGeneration: 2, finalText: '已派给 research 了。' }),
    ).resolves.toContain('dispatched nothing');
  });

  it('judges a claim made right after the previous turn dispatched to someone else', async () => {
    // 最要防的一格：上一轮派给 research 的凭据刚落账（就在几秒前），这一轮
    // 什么都没派，却说「已派给 developer2」。按「最近派过」或「账本里有这个
    // 名字」放行，都会把这一格整段漏掉。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-2',
      workerLabel: 'developer2',
      dispatchId: 'q-earlier',
      delivery: 'queued',
      turnGeneration: 1,
      at: Date.now(),
    });
    await expect(
      evaluateTurnGate({
        ...base,
        finalText: '已派给 developer2 了，它在跑。',
      }),
    ).resolves.toContain('dispatched nothing');
    expect(requestUtilityText).toHaveBeenCalledTimes(1);
  });

  it('tells the judge which handoffs the host already recorded', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    noteLeadDispatchFact('lead-1', {
      workerId: 'w-1',
      workerLabel: 'research',
      dispatchId: 'q-yesterday',
      delivery: 'direct',
      turnGeneration: 1,
      at: Date.now() - 3 * 60 * 60 * 1000,
    });
    // 上一轮真派过 research，这一轮只是复述那条派单。不给判官看这笔账，
    // 「我上一轮派过了」与「我刚派了」在它眼里一模一样，真话会被当成假话纠正。
    await expect(
      evaluateTurnGate({
        ...base,
        workers: [{ label: 'research', status: 'running' }],
        finalText: '派单发生在前一轮，research 正在跑。',
      }),
    ).resolves.toBeUndefined();
    const prompt = String(requestUtilityText.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('research — accepted 1 turn(s) earlier');
    expect(prompt).toContain('worker status running');
  });

  it('shows the handoff this turn cites even when eight newer ones exist', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'quiet' });
    const now = Date.now();
    // 十条旧账，被点名的 research 排在最久之前：只按时间取最近八条会把它裁掉，
    // 于是一句真复述又变回「新声称」。
    for (let step = 0; step < 10; step += 1) {
      noteLeadDispatchFact('lead-1', {
        workerId: `w-${step}`,
        workerLabel: step === 9 ? 'research' : `worker-${step}`,
        dispatchId: `q-${step}`,
        delivery: 'direct',
        turnGeneration: 1,
        at: now - (step + 1) * 60_000,
      });
    }
    await evaluateTurnGate({
      ...base,
      workers: [{ label: 'research', status: 'running' }],
      finalText: '昨天就派给 research 的那件事还在跑。',
    });
    const prompt = String(requestUtilityText.mock.calls[0]?.[1] ?? '');
    expect(prompt).toContain('research —');
  });

  it('judges a claim made after dispatch attempts that all failed', async () => {
    // 两次 send_to_worker 都报错、第三次才成的情况在真实会话里出现过：本回合
    // 碰过 Orca 工具但一条都没派成，说「已派」同样是假话——所以「碰过工具」
    // 不构成免检，只有本回合真有被接受的派发才算。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    await expect(
      evaluateTurnGate({ ...base, finalText: '已派出去了，不需要重发。' }),
    ).resolves.toContain('dispatched nothing');
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
    expect(seen).toContain('are not claims');
  });

  it('skips the judge when the turn says nothing about dispatching', async () => {
    // 绝大多数回合是普通对话：没有「派/安排/交给」这类词就不该付一次模型调用。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    await expect(
      evaluateTurnGate({ ...base, finalText: 'README 已更新，两处公式按你给的写法改了。' }),
    ).resolves.toBeUndefined();
    expect(requestUtilityText).not.toHaveBeenCalled();
  });

  it('corrects one restated claim once, and a fresh worker again', async () => {
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const lead = {
      ...base,
      leadSessionId: 'lead-repeat',
      workers: [
        { label: 'research', status: 'idle' },
        { label: 'developer2', status: 'idle' },
      ],
    };
    await expect(
      evaluateTurnGate({
        ...lead,
        turnGeneration: 2,
        finalText: '这次已经交给 research 了。',
      }),
    ).resolves.toBeTruthy();
    // 同一轮不重复叫醒：模型在纠正回合里解释不会陷入来回空转。
    await expect(
      evaluateTurnGate({
        ...lead,
        turnGeneration: 2,
        finalText: '这次已经交给 research 了。',
      }),
    ).resolves.toBeUndefined();
    // 下一轮还是同一批人、同一件事：复述不是新问题，不再纠一遍。
    await expect(
      evaluateTurnGate({
        ...lead,
        turnGeneration: 3,
        finalText: '已经交给 research 在做了。',
      }),
    ).resolves.toBeUndefined();
    // 换一个人说已派：新的声称，该纠。
    await expect(
      evaluateTurnGate({
        ...lead,
        turnGeneration: 4,
        finalText: '也交给 developer2 了。',
      }),
    ).resolves.toBeTruthy();
  });

  it('keeps two different unnamed claims apart', async () => {
    // 不点名 worker 的声称不能共用一个身份：否则第一句被拦后，接下来窗口内
    // 所有不点名的假声称都被吞掉，连理由都不给。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const lead = { ...base, leadSessionId: 'lead-unnamed' };
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 2, finalText: '已经安排好了。' }),
    ).resolves.toBeTruthy();
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 3, finalText: '已经派人去做了。' }),
    ).resolves.toBeTruthy();
    // 同一句复述仍然只纠一次。
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 4, finalText: '已经派人去做了。' }),
    ).resolves.toBeUndefined();
  });

  it('does not treat a longer word as naming the worker', async () => {
    // Worker 叫 research 时，researcher 不算点名。名字参与声称身份，
    // 子串命中会把两句不同的声称并成一个，后一句就此静默放过。
    requestUtilityText.mockResolvedValue({ ok: true, text: 'claim' });
    const lead = {
      ...base,
      leadSessionId: 'lead-boundary',
      workers: [{ label: 'research', status: 'running' }],
    };
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 2, finalText: '已派给 research。' }),
    ).resolves.toBeTruthy();
    await expect(
      evaluateTurnGate({ ...lead, turnGeneration: 3, finalText: '已派给 researcher 团队。' }),
    ).resolves.toBeTruthy();
  });
});
