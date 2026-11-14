import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import { createMsgOpResultRouter, MSG_OP_UNKNOWN_REPLAYS, type MsgOpResultRouter } from '../telegramMsgOp';
import { createTelegramNoticePublisher } from '../telegramNoticeOps';

afterEach(() => vi.useRealTimers());
const question = { kind: 'ask_user_question' as const, requestId: 'question', delivery: 'async' as const,
  questions: [{ question: 'Which format?', options: [{ label: 'PDF' }, { label: 'Text' }] }] };

// Production transport pairing + publisher: bounded completion and no duplicate questions.
describe('Telegram async card delivery', () => {
  function fixture(acknowledge: boolean, onFrame?: (frame: Extract<HookMessage, { type: 'msg.op' }>, router: MsgOpResultRouter) => void) {
    const router = createMsgOpResultRouter();
    const frames: HookMessage[] = [];
    let online = true;
    let settle!: (value: InteractionDecision) => void;
    const controls = { answer: vi.fn(), settled: new Promise<InteractionDecision>(r => { settle = r; }) };
    const handlers = new Map<string, (button: string, text?: string) => Promise<boolean>>();
    const send = (frame: HookMessage) => {
      frames.push(frame);
      if (onFrame && frame.type === 'msg.op') { onFrame(frame, router); return true; }
      if (acknowledge && frame.type === 'msg.op') queueMicrotask(() => {
        router.settle({ opId: frame.payload.opId, ok: true, messageId: '10' });
      });
      return true;
    };
    let currentSend = send;
    const publisher = createTelegramNoticePublisher({
      connectionId: 'connection', requestId: 'request',
      externalKey: 'telegram:group:123456789:-100:101:g1', router,
      getSend: () => online ? currentSend : undefined,
      register(id, click) { handlers.set(id, click); return () => { handlers.delete(id); }; },
    });
    return { publisher, frames, controls, handlers, settle, offline: () => { online = false; },
      replaceConnection: () => { currentSend = frame => send(frame); } };
  }

  // Server #1433: unit through the production publisher + result router. Previous
  // coverage only exercised unknown SEND; lost EDIT receipts must reconcile the
  // exact same frame without reopening a keyboard or sending another question.
  it.each([false, true])('reconciles the same unknown edit, including closure=%s', async closed => {
    let edits = 0;
    const f = fixture(true, (frame, router) => queueMicrotask(() => {
      const unknown = frame.payload.action.kind === 'edit' && edits++ === 0;
      router.settle({ opId: frame.payload.opId, ok: !unknown, ...(unknown ? { errorCode: 'OUTCOME_UNKNOWN' } : { messageId: '10' }) });
    }));
    await f.publisher.open({ ...question, questions: [{ ...question.questions[0], multiSelect: true }] }, f.controls);
    if (closed) f.settle({ kind: 'ask_user_question', answers: {} });
    else {
      const first = f.frames[0];
      if (first.type !== 'msg.op' || first.payload.action.kind !== 'send') throw new Error('missing card');
      await f.handlers.get(first.payload.interactionId!)!(first.payload.action.buttons![0][0].token);
    }
    await vi.waitFor(() => expect(f.frames).toHaveLength(3));
    expect(f.frames[1]).toBe(f.frames[2]);
    expect(f.frames[2]).toMatchObject({ payload: { action: { kind: 'edit', messageId: '10' },
      ...(closed ? { interactionClosed: true } : {}) } });
    if (!closed) f.settle({ kind: 'ask_user_question', answers: {} });
  });

  it('reconciles an edit whose receipt timed out, without changing its opId or content', async () => {
    vi.useFakeTimers();
    let edits = 0;
    const f = fixture(true, (frame, router) => {
      if (frame.payload.action.kind === 'edit' && edits++ === 0) return;
      queueMicrotask(() => router.settle({ opId: frame.payload.opId, ok: true, messageId: '10' }));
    });
    await f.publisher.open(question, f.controls);
    const frame = f.frames[0];
    if (frame.type !== 'msg.op') throw new Error('missing card');
    const reply = f.handlers.get(frame.payload.interactionId!)!('question:reply', 'Markdown');
    const accepted = expect(reply).resolves.toBe(true);
    await vi.advanceTimersByTimeAsync(10_001);
    await accepted;
    expect(f.frames[1]).toBe(f.frames[2]);
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.advanceTimersByTimeAsync(0);
  });

  it.each(['unknown', 'rejected', 'offline', 'replaced'] as const)('bounds edit reconciliation for %s', async mode => {
    const f = fixture(true, (frame, router) => queueMicrotask(() => {
      if (frame.payload.action.kind === 'send') {
        router.settle({ opId: frame.payload.opId, ok: true, messageId: '10' }); return;
      }
      if (mode === 'offline') f.offline();
      if (mode === 'replaced') f.replaceConnection();
      router.settle({ opId: frame.payload.opId, ok: false, errorCode: mode === 'rejected' ? 'BINDING_REVOKED' : 'OUTCOME_UNKNOWN' });
    }));
    await f.publisher.open(question, f.controls);
    const frame = f.frames[0];
    if (frame.type !== 'msg.op') throw new Error('missing card');
    await expect(f.handlers.get(frame.payload.interactionId!)!('question:reply', 'Markdown')).rejects.toThrow('not confirmed');
    expect(f.frames).toHaveLength(mode === 'unknown' ? 2 + MSG_OP_UNKNOWN_REPLAYS : 2);
    for (const edit of f.frames.slice(1)) expect(edit).toBe(f.frames[1]);
    f.offline(); f.settle({ kind: 'ask_user_question', answers: {} });
  });

  it('never replays an explicit unknown initial send', async () => {
    const f = fixture(true, (frame, router) => queueMicrotask(() => {
      router.settle({ opId: frame.payload.opId, ok: false, errorCode: 'OUTCOME_UNKNOWN' });
    }));
    await expect(f.publisher.open(question, f.controls)).rejects.toThrow('not confirmed');
    f.settle({ kind: 'ask_user_question', answers: {} });
    await vi.waitFor(() => expect(f.handlers.size).toBe(0));
    expect(f.frames).toHaveLength(1);
  });

  it('keeps callbacks and edits alive after drain, then closes when the Host settles', async () => {
    const f = fixture(true);
    await f.publisher.open(question, f.controls);
    await f.publisher.drain();
    const frame = f.frames[0];
    if (frame.type !== 'msg.op' || frame.payload.action.kind !== 'send') throw new Error('missing card');
    expect(frame.payload.action.buttons?.flat()).toHaveLength(2);
    const click = f.handlers.get(frame.payload.interactionId!)!;
    await click(frame.payload.action.buttons![0][0].token);
    expect(f.controls.answer).toHaveBeenCalledWith({ kind: 'ask_user_question', answers: { 'Which format?': 'PDF' } });
    // Submission is not final until the existing App/pause gate resolves.
    expect(f.frames.at(-1)).not.toMatchObject({ payload: { interactionClosed: true } });
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.frames.at(-1)).toMatchObject({ payload: {
      interactionClosed: true, action: { kind: 'edit', messageId: '10', buttons: [] },
    } }));
    expect(f.handlers.size).toBe(0);
    const count = f.frames.length;
    await f.publisher.open(question, f.controls);
    expect(f.frames).toHaveLength(count);
  });

  it('passes a quoted blocking answer through the same Host gate', async () => {
    const f = fixture(true);
    await f.publisher.open({ ...question, delivery: undefined }, f.controls);
    const frame = f.frames[0];
    if (frame.type !== 'msg.op') throw new Error('missing question');
    expect(frame.payload.questionMode).toBe('blocking');
    await f.handlers.get(frame.payload.interactionId!)!('question:reply', 'Markdown');
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question', answers: { 'Which format?': 'Markdown' } });
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.frames.at(-1)).toMatchObject({ payload: { interactionClosed: true } }));
  });

  // PR #10511: unit, production msg.op callback. Existing coverage stopped at
  // a single text answer; quoted multi-select OK must submit, not overwrite it.
  it('submits multiple selections from quoted replies after the async turn ends', async () => {
    const f = fixture(true);
    await f.publisher.open({ ...question, questions: [{ ...question.questions[0], multiSelect: true }] }, f.controls);
    await f.publisher.drain();
    const frame = f.frames[0];
    if (frame.type !== 'msg.op') throw new Error('missing question');
    const reply = f.handlers.get(frame.payload.interactionId!)!;
    expect(await reply('question:reply', '1,2')).toBe(true);
    expect(await reply('question:reply', 'OK')).toBe(true);
    expect(f.controls.answer).toHaveBeenCalledExactlyOnceWith({ kind: 'ask_user_question',
      answers: { 'Which format?': '["PDF","Text"]' } });
    f.settle(f.controls.answer.mock.calls[0][0]);
    await vi.waitFor(() => expect(f.handlers.size).toBe(0));
  });

  it('bounds an unknown send and never retries it when App settles', async () => {
    vi.useFakeTimers();
    const f = fixture(false);
    const delivered = f.publisher.open(question, f.controls);
    const rejected = expect(delivered).rejects.toThrow('not confirmed');
    const drained = f.publisher.drain();
    await vi.advanceTimersByTimeAsync(10_001);
    await drained;
    await rejected;
    f.settle({ kind: 'ask_user_question', answers: {} });
    await vi.advanceTimersByTimeAsync(1);
    expect(f.frames).toHaveLength(1);
    expect(f.handlers.size).toBe(0);
  });

  it('rechecks the current account/connection before queued sends', async () => {
    const f = fixture(true);
    const delivered = f.publisher.open(question, f.controls);
    f.offline();
    await expect(delivered).rejects.toThrow('channel unavailable');
    await f.publisher.drain();
    expect(f.frames).toHaveLength(0);
    expect(f.handlers.size).toBe(0);
  });
});
