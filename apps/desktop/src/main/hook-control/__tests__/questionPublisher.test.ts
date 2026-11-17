import { describe, it, expect, vi } from 'vitest';
import { parseHookMessage, type HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import { createHookQuestionPublisher } from '../questionPublisher';
import { imText } from '../../im/shared/imText';

// Exercise actual wire validation and Host reply pairing; no simulated success at the answer gate.
describe('generic Hook question publisher', () => {
  // PR #10511: unit, real protocol parser. 25 choices or 24 + submit used
  // to invalidate the entire request; earlier cases only used one option.
  it.each([1, 4])('keeps every choice reachable when %i questions overflow the wire button limit', async count => {
    const frames: HookMessage[] = [];
    let respond!: (button: string, text?: string) => Promise<boolean>;
    const answer = vi.fn();
    const publisher = createHookQuestionPublisher({ requestId: 'turn',
      send: frame => { expect(parseHookMessage(frame).ok).toBe(true); frames.push(frame); return true; },
      register: (_id, handler) => { respond = handler; return () => {}; },
    });
    await publisher.open({ kind: 'ask_user_question', requestId: 'q', delivery: 'async', questions:
      Array.from({ length: count }, (_, i) => ({ id: `q${i}`, question: `Question ${i}`, options:
        Array.from({ length: count === 1 ? 25 : 6 }, (_, j) => ({ label: `Choice ${j + 1}` })) })) },
    { answer, settled: new Promise(() => {}) });
    expect(frames[0]).toMatchObject({ payload: { body: expect.stringContaining(count === 1 ? 'Choice 25' : '4·6.') } });
    for (let i = 0; i < count; i++) expect(await respond('question:reply', count === 1 ? '25' : `${i + 1}: 6`)).toBe(true);
    if (count > 1) expect(await respond('question:reply', 'OK')).toBe(true);
    expect(answer).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: Object.fromEntries(
      Array.from({ length: count }, (_, i) => [`q${i}`, count === 1 ? 'Choice 25' : 'Choice 6'])) });
  });
  it.each(['async', 'blocking'] as const)('%s questions reuse one card and wait for Host settlement', async mode => {
    const frames: HookMessage[] = [];
    let respond!: (button: string, text?: string) => Promise<boolean>;
    let settle!: (decision: InteractionDecision) => void;
    const answer = vi.fn(); const off = vi.fn();
    const controls = { answer, settled: new Promise<InteractionDecision>(r => { settle = r; }) };
    const publisher = createHookQuestionPublisher({ requestId: 'turn',
      send: frame => { expect(parseHookMessage(frame).ok).toBe(true); frames.push(frame); return true; },
      register: (_id, handler) => { respond = handler; return off; },
    });
    await publisher.open({ kind: 'ask_user_question', requestId: 'q', delivery: mode === 'async' ? 'async' : undefined,
      questions: [{ id: 'format', question: 'Format?', options: [{ label: 'PDF' }] }] }, controls);
    expect(frames[0]).toMatchObject({ type: 'interaction.request', payload: { questionMode: mode, questionCode: expect.stringMatching(/^Q[0-9a-f]{16}$/) } });
    if (mode === 'async') await publisher.drain();
    await respond('question:reply', 'plain text');
    expect(answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { format: 'plain text' } });
    expect(frames.at(-1)?.type).toBe('interaction.request');
    settle(answer.mock.calls[0][0]);
    await publisher.drain();
    await vi.waitFor(() => expect(frames.at(-1)?.type).toBe('interaction.cancel'));
    expect(off).toHaveBeenCalledTimes(1);
    expect(await respond('question:reply', 'late')).toBe(false);
  });
});

// 官方飞书 / Lark 一题一张卡(2026-11-17 用户裁决: 答完一题再出下一题)。旧行为把 4 道题拼进一张卡:
// 题干挤成一段、13 个按钮平铺, 题干自带「（可多选）」时还会重复两遍。unit, 真实协议解析器。
describe('sequential Hook question cards', () => {
  const multiHint = imText('imBot.text.questions.multiSelectHint').trim();
  function harness() {
    const frames: HookMessage[] = [];
    const handlers = new Map<string, (button: string, text?: string) => Promise<boolean>>();
    let settle!: (decision: InteractionDecision) => void;
    const answer = vi.fn();
    const controls = { answer, settled: new Promise<InteractionDecision>(r => { settle = r; }) };
    const publisher = createHookQuestionPublisher({ requestId: 'turn', sequential: true,
      send: frame => { expect(parseHookMessage(frame).ok).toBe(true); frames.push(frame); return true; },
      register: (id, handler) => { handlers.set(id, handler); return () => { handlers.delete(id); }; },
    });
    const requests = () => frames.filter(f => f.type === 'interaction.request') as Extract<HookMessage, { type: 'interaction.request' }>[];
    const cards = () => [...new Set(requests().map(f => f.payload.interactionId))];
    const latest = (interactionId: string) => requests().filter(f => f.payload.interactionId === interactionId).at(-1)!.payload;
    const click = (interactionId: string, label: string) => {
      const button = latest(interactionId).buttons.find(b => b.label.endsWith(label))!;
      return handlers.get(interactionId)!(button.id);
    };
    const closing = (interactionId: string) => frames.find((f): f is Extract<HookMessage, { type: 'interaction.cancel' }> =>
      f.type === 'interaction.cancel' && f.payload.interactionId === interactionId)?.payload.reason;
    return { frames, handlers, answer, settle, controls, publisher, cards, latest, click, closing };
  }
  const grey = (text: string) => `<font color='grey'>${text}</font>`;
  const receiptTitle = (label: string, option: string) => imText('imBot.text.questions.resolvedLabeled', { label, option });
  const request = { kind: 'ask_user_question' as const, requestId: 'q', questions: [
    { id: 'env', header: '运行环境', question: '发到哪个环境？', options: [{ label: '测试环境', description: '影响最小' }, { label: '正式环境' }] },
    { id: 'lang', header: '语言', question: `需要哪些语言？${multiHint}`, multiSelect: true, options: [{ label: '中文' }, { label: '英语' }] },
  ] };

  it('shows one question per card and submits all answers once after the last one', async () => {
    const h = harness();
    await h.publisher.open(request, h.controls);
    expect(h.cards()).toHaveLength(1);
    const first = h.latest(h.cards()[0]!);
    expect(first.title).toBe('运行环境 1/2');
    expect(first.body).toContain('发到哪个环境？');
    expect(first.body).toContain(`1. **测试环境** ${grey('影响最小')}`);
    expect(first.body).not.toContain('需要哪些语言？');
    expect(first.buttons.map(b => b.label)).toEqual(['测试环境', '正式环境']);

    // 单选: 点一下就答完这一题, 关掉这张卡并发出下一题; 还不交给 Host。
    expect(await h.click(h.cards()[0]!, '测试环境')).toBe(true);
    await vi.waitFor(() => expect(h.cards()).toHaveLength(2));
    expect(h.answer).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(h.closing(h.cards()[0]!)).toBeDefined());
    // 实踩(2026-11-17): 答完的卡还留着题干、全部选项、说明和提示, 外加两遍「✅ 已选」, 聊天里堆着一张张
    // 过期的表单。答完收成回执: 标题写结论, 正文只留弱化的原问题; 收口帧的正文与它一致。
    const answered = h.latest(h.cards()[0]!);
    expect(answered).toMatchObject({ title: receiptTitle('运行环境', '测试环境'), body: grey('发到哪个环境？'), buttons: [] });
    expect(h.closing(h.cards()[0]!)).toBe(answered.body);
    const second = h.latest(h.cards()[1]!);
    expect(second.title).toContain('2/2');
    expect(second.body.split(multiHint)).toHaveLength(2);

    // 最后一题多选: 勾选两项后提交, 两题答案一次交给 Host。
    expect(await h.click(h.cards()[1]!, '中文')).toBe(true);
    expect(await h.click(h.cards()[1]!, '英语')).toBe(true);
    expect(await h.click(h.cards()[1]!, imText('imBot.text.questions.submitLabel'))).toBe(true);
    expect(h.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question',
      answers: { env: '测试环境', lang: JSON.stringify(['中文', '英语']) } });
    expect(h.latest(h.cards()[1]!).title).toBe(receiptTitle('语言', '中文, 英语'));
  });

  // 回执的两个边界(同一入口, 结果不同): 答案太长写不进标题时放进正文; 没拿到答案就收口时不再列选项,
  // 只说明卡片已失效。最小输入: 一道带选项的题 + 一段 60 字以上的文字回答 / 一个空的 Host 收口(unit)。
  it('keeps a long written answer in the body and marks an unanswered card expired', async () => {
    const one = { ...request, questions: [request.questions[0]!] };
    const long = '先发测试环境，确认没有问题以后再灰度到预发布环境，最后由我手动放量到正式环境，过程中任何一步失败都立即回滚并通知我，不要自动重试';
    const h = harness();
    await h.publisher.open(one, h.controls);
    expect(await h.handlers.get(h.cards()[0]!)!('question:reply', long)).toBe(true);
    expect(h.latest(h.cards()[0]!)).toMatchObject({ title: '✅ 运行环境', body: `${long}\n\n${grey('发到哪个环境？')}` });

    const idle = harness();
    await idle.publisher.open(one, idle.controls);
    idle.settle({ kind: 'ask_user_question', answers: {} });
    await vi.waitFor(() => expect(idle.closing(idle.cards()[0]!)).toBe(
      `${grey('发到哪个环境？')}\n\n${imText('imBot.text.questions.expired')}`));
  });

  // 评审 #11136: 异步多题逐题发时, 本轮一结束(drain)后面的题就再也发不出去(服务端只在轮次运行期间
  // 受理新卡), 提问永远答不完。入口: open(异步多题) + drain() 后继续作答; 可观察结果: 只有一张卡,
  // 本轮结束后仍能答完并交给 Host。最小失败输入: 两题的异步提问(unit, 真实协议解析)。
  it('keeps an async multi-question request on one card so it can be finished after the turn ends', async () => {
    const h = harness();
    await h.publisher.open({ ...request, delivery: 'async' }, h.controls);
    expect(h.cards()).toHaveLength(1);
    const card = h.cards()[0]!;
    expect(h.latest(card).body).toContain('发到哪个环境？');
    expect(h.latest(card).body).toContain('需要哪些语言？');

    await h.publisher.drain();
    expect(await h.click(card, '测试环境')).toBe(true);
    expect(await h.click(card, '中文')).toBe(true);
    expect(await h.click(card, imText('imBot.text.questions.submitLabel'))).toBe(true);
    expect(h.cards()).toHaveLength(1);
    expect(h.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question',
      answers: { env: '测试环境', lang: JSON.stringify(['中文']) } });
  });

  // 评审 #11136: 单题版式在选项没有说明时不把选项写进正文, 而按钮超过 24 个时又不发选项按钮,
  // 选项就全部不见了。入口: open(单题 25 个无说明选项); 可观察结果: 正文逐行列出全部选项,
  // 仍可用编号文字作答(unit, 真实协议解析)。
  it('lists every option in the body when a single question has too many for buttons', async () => {
    const h = harness();
    await h.publisher.open({ kind: 'ask_user_question', requestId: 'q', questions: [{ id: 'pick', question: '选哪个？',
      options: Array.from({ length: 25 }, (_, i) => ({ label: `选项 ${i + 1}` })) }] }, h.controls);
    const card = h.cards()[0]!;
    expect(h.latest(card).buttons).toEqual([]);
    expect(h.latest(card).body).toContain('1. 选项 1');
    expect(h.latest(card).body).toContain('25. 选项 25');
    expect(await h.handlers.get(card)!('question:reply', '25')).toBe(true);
    expect(h.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { pick: '选项 25' } });
  });

  it('stops after the open card when the Host settles first', async () => {
    const h = harness();
    await h.publisher.open(request, h.controls);
    // App 先答完(或超时、轮次结束): 当前卡收口, 后面的题不再发, 迟到的点击也不再生效。
    h.settle({ kind: 'ask_user_question', answers: { env: '正式环境', lang: '[]' } });
    await vi.waitFor(() => expect(h.frames.at(-1)?.type).toBe('interaction.cancel'));
    // 不是在这张卡上答的: 收口帧只带正文, 所以先更新一帧把标题换成 App 里的答案, 再收口。
    expect(h.frames.at(-2)).toMatchObject({ type: 'interaction.request',
      payload: { title: receiptTitle('运行环境', '正式环境'), body: grey('发到哪个环境？'), buttons: [] } });
    expect(h.handlers.size).toBe(0);
    expect(h.cards()).toHaveLength(1);
    expect(h.answer).not.toHaveBeenCalled();
  });
});
