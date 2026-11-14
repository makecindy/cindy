import { describe, it, expect, vi } from 'vitest';
import { parseHookMessage, type HookMessage } from '@cindy/slack-hook-protocol';
import type { InteractionDecision } from '@cindy/maker-core';
import { createHookQuestionPublisher } from '../questionPublisher';

// Exercise actual wire validation and Host reply pairing; no simulated success at the answer gate.
describe('generic Hook question publisher', () => {
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
