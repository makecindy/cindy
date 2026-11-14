import { describe, it, expect, vi } from 'vitest';
import { parseHookMessage, type HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import { createHookQuestionPublisher } from '../questionPublisher';

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
