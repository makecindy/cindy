import { afterEach, describe, expect, it, vi } from 'vitest';
import type { HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import { createMsgOpResultRouter } from '../telegramMsgOp';
import { createTelegramNoticePublisher } from '../telegramNoticeOps';

afterEach(() => vi.useRealTimers());
const question = { kind: 'ask_user_question' as const, requestId: 'question', delivery: 'async' as const,
  questions: [{ question: 'Which format?', options: [{ label: 'PDF' }, { label: 'Text' }] }] };

// Production transport pairing + publisher: bounded completion and no duplicate questions.
describe('Telegram async card delivery', () => {
  function fixture(acknowledge: boolean) {
    const router = createMsgOpResultRouter();
    const frames: HookMessage[] = [];
    let online = true;
    let settle!: (value: InteractionDecision) => void;
    const controls = { answer: vi.fn(), settled: new Promise<InteractionDecision>(r => { settle = r; }) };
    const handlers = new Map<string, (button: string, text?: string) => Promise<boolean>>();
    const send = (frame: HookMessage) => {
      frames.push(frame);
      if (acknowledge && frame.type === 'msg.op') queueMicrotask(() => {
        router.settle({ opId: frame.payload.opId, ok: true, messageId: '10' });
      });
      return true;
    };
    const publisher = createTelegramNoticePublisher({
      connectionId: 'connection', requestId: 'request',
      externalKey: 'telegram:group:123456789:-100:101:g1', router,
      getSend: () => online ? send : undefined,
      register(id, click) { handlers.set(id, click); return () => { handlers.delete(id); }; },
    });
    return { publisher, frames, controls, handlers, settle, offline: () => { online = false; } };
  }

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
