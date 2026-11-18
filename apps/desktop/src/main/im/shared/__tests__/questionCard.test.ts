import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InteractionDecision } from '@cindy/maker-core';
import type { InteractiveCardSpec } from '@cindy/im';
import { setMainLocale } from '../../../i18n.desktop';
afterEach(() => setMainLocale('en'));
import { createQuestionCard, type QuestionRequest } from '../questionCard';

// Shared production choice model: prevent partial, stale or duplicate answers on either transport.
function fixture(questions: QuestionRequest['questions']) {
  let settle!: (answer: InteractionDecision) => void;
  const controls = { answer: vi.fn(), settled: new Promise<InteractionDecision>(r => { settle = r; }) };
  const frames: Array<{ card: InteractiveCardSpec; closed: boolean }> = [];
  const card = createQuestionCard({ kind: 'ask_user_question', requestId: 'q', questions }, controls,
    async (value, closed) => { frames.push({ card: value, closed }); });
  const click = (suffix: string) => card.click(frames.at(-1)!.card.buttons!.find(b => b.id.endsWith(suffix))!.id);
  return { card, controls, frames, click, settle };
}

describe('async question choices', () => {
  // PR #10511 review: unit regressions through createQuestionCard. Earlier fixtures
  // lacked MCP constraints, optional fields and oversized option lists.
  it('allows optional fields to stay empty, including an entirely optional form', async () => {
    const f = fixture([{ id: 'name', question: 'Name?' },
      { id: 'note', question: 'Note?', answerConstraints: { required: false } }]);
    await f.card.ready;
    await f.card.replyText('1: Cindy');
    expect(await f.card.submit()).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: { name: 'Cindy', note: '' } });
    const optional = fixture([{ id: 'note', question: 'Note?', answerConstraints: { required: false } }]);
    await optional.card.ready;
    expect(optional.frames[0].card.buttons!.some(b => b.id.endsWith(':submit'))).toBe(true);
    expect(await optional.card.replyText('OK')).toBe(true);
    expect(optional.controls.answer).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: { note: '' } });
  });
  it('validates the decoded option label rather than its number and preserves the previous valid answer', async () => {
    const f = fixture([{ id: 'mode', question: 'Mode?', options: [{ label: 'Personal' }, { label: 'No' }],
      answerConstraints: { required: true, choices: ['Personal', 'No'], minLength: 3 } },
      { id: 'note', question: 'Note?', answerConstraints: { required: false } }]);
    await f.card.ready;
    expect(await f.card.replyText('1: 1')).toBe(true);
    expect(await f.card.replyText('1: 2')).toBe(false);
    expect(await f.card.submit()).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: { mode: 'Personal', note: '' } });
  });
  // Real locale catalogs: misplaced keys used to expose raw key names in the card.
  it.each(['en', 'zh-CN', 'zh-TW', 'ja', 'ko', 'fr', 'es', 'de', 'pt-PT', 'pt-BR', 'zh-Hant-x-lzh', 'zh-Hans-x-lzh'] as const)(
    'renders instructions and submit controls in %s', async locale => {
      setMainLocale(locale);
      const f = fixture([{ question: 'Choose', multiSelect: true, options: [{ label: 'A' }] }]);
      await f.card.ready;
      expect(f.frames[0].card.body).not.toContain('imBot.text.');
      expect(f.frames[0].card.buttons!.at(-1)!.label).not.toContain('imBot.text.');
    });
  it('uses stable question IDs, requires all questions and serializes multi-select as the native UI does', async () => {
    const f = fixture([
      { id: 'format', question: 'Format?', options: [{ label: 'PDF' }, { label: 'Text' }] },
      { id: 'languages', question: 'Languages?', multiSelect: true, options: [{ label: 'English' }, { label: 'Chinese' }] },
    ]);
    await f.card.ready;
    expect(await f.click(':submit')).toBe(false);
    await f.click(':0:0');
    expect(await f.click(':submit')).toBe(false);
    await f.click(':1:0');
    await f.click(':1:1');
    expect(f.controls.answer).not.toHaveBeenCalled();
    expect(await f.click(':submit')).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: {
      format: 'PDF', languages: '["English","Chinese"]',
    } });
    expect(f.frames.at(-1)!.closed).toBe(false);
    expect(f.frames.at(-1)!.card.buttons).toEqual([]);
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.frames.at(-1)!.closed).toBe(true));
  });
  it('rejects stale revisions, lets users uncheck choices and ignores clicks after App answers', async () => {
    const f = fixture([{ question: 'Choose', multiSelect: true, options: [{ label: 'A' }, { label: 'B' }] }]);
    await f.card.ready;
    const stale = f.frames[0].card.buttons![1].id;
    await f.click(':0:0');
    expect(await f.card.click(stale)).toBe(false);
    await f.click(':0:0');
    expect(await f.click(':submit')).toBe(false);
    const live = f.frames.at(-1)!.card.buttons![0].id;
    f.settle({ kind: 'ask_user_question', answers: { Choose: '["B"]' } });
    await vi.waitFor(() => expect(f.frames.at(-1)!.closed).toBe(true));
    expect(await f.card.click(live)).toBe(false);
    expect(f.controls.answer).not.toHaveBeenCalled();
  });
  it('maps text option numbers to the same multi-select answer as buttons', async () => {
    const f = fixture([{ id: 'format', question: 'Formats?', multiSelect: true, options: [{ label: 'PDF' }, { label: 'Text' }] }]);
    await f.card.ready;
    await f.card.replyText('1,2');
    expect(f.controls.answer).not.toHaveBeenCalled();
    await f.card.submit();
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { format: '["PDF","Text"]' } });
    f.settle(f.controls.answer.mock.calls[0][0]);
  });
  it('accepts quoted free text and combines numbered answers with button choices', async () => {
    const f = fixture([{ id: 'format', question: 'Format?', options: [{ label: 'PDF' }] },
      { id: 'notes', question: 'Any constraints?' }]);
    await f.card.ready;
    await f.click(':0:0');
    expect(await f.card.replyText('ambiguous unnumbered text')).toBe(false);
    expect(await f.card.replyText('2: Keep it short')).toBe(true);
    expect(f.controls.answer).not.toHaveBeenCalled();
    await f.click(':submit');
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: {
      format: 'PDF', notes: 'Keep it short',
    } });
    const single = fixture([{ id: 'name', question: 'Name?' }]);
    await single.card.ready;
    expect(await single.card.replyText('Cindy')).toBe(true);
    expect(await single.card.replyText('Duplicate')).toBe(false);
    expect(single.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { name: 'Cindy' } });
  });
  it('does not accept options violating server-authored constraints', async () => {
    const f = fixture([{ question: 'Choose', options: [{ label: 'A' }], answerConstraints: { required: true, minLength: 2 } }]);
    await f.card.ready;
    expect(await f.click(':0:0')).toBe(false);
    expect(f.controls.answer).not.toHaveBeenCalled();
  });
  it('single-select sends exactly once and abort removes its keyboard', async () => {
    const f = fixture([{ question: 'Choose', options: [{ label: 'A' }] }]);
    await f.card.ready;
    const button = f.frames[0].card.buttons![0].id;
    await f.card.click(button);
    expect(await f.card.click(button)).toBe(false);
    expect(f.controls.answer).toHaveBeenCalledOnce();
    f.settle({ kind: 'ask_user_question', answers: {} });
    await vi.waitFor(() => expect(f.frames.at(-1)).toMatchObject({ closed: true, card: { buttons: [] } }));
  });
});

describe('submitting before every question is answered', () => {
  // 实踩(2026-11-17, 官方飞书两题合卡): 只答了第 1 题就点「提交答案」, 渠道已回「已收到你的选择」,
  // 卡片却毫无变化, 看起来像点击失效, 用户连点两次后放弃。入口: createQuestionCard().click(提交);
  // 可观察结果: 卡片正文点名没答的题, 按钮保留, 不交答案。既有用例只断言返回 false, 没看卡片(unit)。
  it('names the unanswered questions on the card and keeps it answerable', async () => {
    const f = fixture([
      { id: 'platform', question: 'Platforms?', multiSelect: true, options: [{ label: 'Android' }, { label: 'iOS' }] },
      { id: 'source', question: 'Source?', options: [{ label: 'release' }, { label: 'custom' }] },
    ]);
    await f.card.ready;
    await f.click(':0:0');
    const shown = f.frames.length;
    expect(await f.click(':submit')).toBe(false);
    expect(f.frames).toHaveLength(shown + 1);
    expect(f.frames.at(-1)!.card.body).toContain('Not answered yet: question 2');
    expect(f.frames.at(-1)!.card.buttons!.some(b => b.id.endsWith(':submit'))).toBe(true);
    expect(f.controls.answer).not.toHaveBeenCalled();

    await f.click(':1:0');
    expect(f.frames.at(-1)!.card.body).not.toContain('Not answered yet');
    expect(await f.click(':submit')).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledOnce();
  });

  it('asks for a choice when the only question has none', async () => {
    const f = fixture([{ question: 'Platforms?', multiSelect: true, options: [{ label: 'Android' }, { label: 'iOS' }] }]);
    await f.card.ready;
    expect(await f.click(':submit')).toBe(false);
    expect(f.frames.at(-1)!.card.body).toContain('No answer yet');
    expect(f.controls.answer).not.toHaveBeenCalled();
  });
});

describe('closing a card with the final answer', () => {
  // 实踩(2026-11-17, 官方飞书): 答完的卡片上「✅ 已选」写了两遍(题目下面一行, 末尾又汇总一行); 在 App 里
  // 答了别的选项时, 题目下面还留着卡片上没提交的勾选, 和末尾的最终答案互相矛盾。入口: createQuestionCard
  // + Host settled; 可观察结果: 收口帧正文里每道题的最终答案只写一次, 且以 Host 的答案为准。既有用例只
  // 断言收口帧的 closed 与 buttons, 没看正文(unit)。
  it('writes the final answer once', async () => {
    const f = fixture([{ id: 'env', question: 'Where?', options: [{ label: 'Staging' }, { label: 'Production' }] }]);
    await f.card.ready;
    await f.click(':0:0');
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.frames.at(-1)!.closed).toBe(true));
    expect(f.frames.at(-1)!.card.body.split('Selected: Staging')).toHaveLength(2);
  });

  it('shows the answer given in the App rather than an unsubmitted choice on the card', async () => {
    const f = fixture([{ id: 'langs', question: 'Languages?', multiSelect: true, options: [{ label: 'English' }, { label: 'Chinese' }] }]);
    await f.card.ready;
    await f.click(':0:0');
    f.settle({ kind: 'ask_user_question', answers: { langs: '["Chinese"]' } });
    await vi.waitFor(() => expect(f.frames.at(-1)!.closed).toBe(true));
    expect(f.frames.at(-1)!.card.body).toContain('Selected: Chinese');
    expect(f.frames.at(-1)!.card.body).not.toContain('Selected: English');
  });
});

describe('question card layout', () => {
  // 飞书: 选项多、文案长时同一行挤多个按钮会压缩文字; 问答卡一行一个满宽按钮。
  it('lays choices out as a list', async () => {
    const f = fixture([{ question: 'Pick a long option', options: [
      { label: 'A fairly long first option label' }, { label: 'Another fairly long option label' },
    ] }]);
    await f.card.ready;
    expect(f.frames[0].card.buttonLayout).toBe('list');
  });
});
