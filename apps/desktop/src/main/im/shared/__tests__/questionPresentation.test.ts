import { describe, it, expect, vi } from 'vitest';
import type { ImOutputDriver, TextChannelIM, IMCardActionEvent } from '@cindy/im';
import type { InteractionDecision } from '@cindy/maker-core';
import { presentImQuestion, findImQuestionReply } from '../questionPresentation';

// The same production presenter must retain async replies and reject other actors/lanes.
function fixture(kind: 'rich-card' | 'chunked-text', name: string) {
  let finish!: (decision: InteractionDecision) => void;
  let action: ((event: IMCardActionEvent) => void) | undefined;
  const frames: Array<{ body: string; buttons?: Array<{ id: string; label: string }> }> = [];
  const sendText = vi.fn(async (_lane: string, body: string) => { frames.push({ body }); return { messageId: `m${frames.length}` }; });
  const im = { name, sendText, onCardAction: (h: typeof action) => { action = h; return () => { action = undefined; }; },
    sendInteractiveCard: vi.fn(async (_lane: string, spec: typeof frames[number]) => { frames.push(spec); return { messageId: 'm1' }; }),
    updateInteractiveCard: vi.fn(async (_id: string, spec: typeof frames[number]) => { frames.push(spec); }),
  } as unknown as TextChannelIM;
  const controls = { answer: vi.fn(), settled: new Promise<InteractionDecision>(resolve => { finish = resolve; }) };
  let current = true;
  const open = (multi = false) => presentImQuestion({ output: { kind, im } as ImOutputDriver,
    lane: 'group', respondent: 'alice', request: { kind: 'ask_user_question', requestId: 'q', delivery: 'async',
      questions: multi ? [{ id: 'a', question: 'First?' }, { id: 'b', question: 'Second?' }] : [{ id: 'a', question: 'Answer?' }] },
    controls, current: () => current, warn: vi.fn() });
  const reply = (text: string, actor = 'alice', lane = 'group') => findImQuestionReply(im,
    { senderId: lane, text, speaker: { id: actor, name: actor, isOwner: false } });
  const code = () => frames[0].body.match(/Q[0-9a-f]{8}/)![0];
  return { im, controls, frames, open, reply, code, finish, invalidate: () => { current = false; }, click: (e: IMCardActionEvent) => action?.(e) };
}

describe('shared IM ordinary questions', () => {
  it.each(['wechat', 'wecom', 'dingtalk', 'imessage'])('%s routes only explicitly addressed text to the requester’s pending question', async name => {
    const f = fixture('chunked-text', name);
    await f.open();
    expect(f.reply('unrelated conversation')).toBeUndefined();
    expect(await f.reply(`${f.code()} wrong`, 'bob')!()).toBe(false);
    expect(await f.reply(`${f.code()} wrong`, 'alice', 'other-group')!()).toBe(false);
    expect(f.controls.answer).not.toHaveBeenCalled();
    expect(await f.reply(`${f.code()} OK`)!()).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { a: 'OK' } });
    f.finish(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.reply(`${f.code()} late`)).toBeUndefined());
  });
  it('requires every answer and explicit submit, while preserving stable IDs', async () => {
    const f = fixture('chunked-text', 'wecom'); await f.open(true);
    expect(await f.reply(`${f.code()} OK`)!()).toBe(false);
    await f.reply(`${f.code()} 2: second`)!();
    expect(await f.reply(`${f.code()} OK`)!()).toBe(false);
    await f.reply(`${f.code()} 1: first`)!();
    await f.reply(`${f.code()} OK`)!();
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { a: 'first', b: 'second' } });
    f.finish(f.controls.answer.mock.calls[0][0]);
  });
  it.each(['feishu', 'discord'])('%s keeps the card in the source lane and accepts a quoted answer only from its requester', async name => {
    const f = fixture('rich-card', name); await f.open();
    expect((f.im as any).sendInteractiveCard).toHaveBeenCalledWith('group', expect.anything(), { threadTs: undefined, questionRespondentId: 'alice' });
    const reply = findImQuestionReply(f.im, { senderId: 'group', speaker: { id: 'alice', name: 'Alice', isOwner: false },
      text: 'my answer', replyContext: { messageId: 'm1', author: 'Cindy', text: '', isBot: true } });
    await reply!();
    f.finish(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect((f.im as any).updateInteractiveCard).toHaveBeenCalledWith('m1', expect.anything(), { questionRespondentId: 'alice', questionClosed: true }));
  });
  it('rejects a delayed answer after the session is replaced', async () => {
    const f = fixture('chunked-text', 'dingtalk'); await f.open(); f.invalidate();
    expect(await f.reply(`${f.code()} no`)!()).toBe(false);
    expect(f.controls.answer).not.toHaveBeenCalled(); f.finish({ kind: 'ask_user_question', answers: {} });
  });
});
