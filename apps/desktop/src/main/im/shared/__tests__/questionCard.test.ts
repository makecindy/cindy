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
