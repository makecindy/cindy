import { describe, expect, it, vi } from 'vitest';

import { createDshEventQueue, createDshTranslateContext, settleDshTurnOnIdle, translateDshEvent } from './translator.js';

const logger = { trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child() { return this; } };

describe('DSH event translator', () => {
  it('keeps translated events attributed to dsh', async () => {
    const queue = createDshEventQueue();
    const context = createDshTranslateContext(logger);
    translateDshEvent({ type: 'turn/start' }, queue, context);
    translateDshEvent({ type: 'assistant/chunk', data: { chunk: { type: 'text-delta', text: 'hello' } } }, queue, context);
    translateDshEvent({ type: 'turn/end', data: { reason: { kind: 'completed' } } }, queue, context);
    settleDshTurnOnIdle(queue, context);

    const iterator = queue[Symbol.asyncIterator]();
    expect((await iterator.next()).value.source).toBe('dsh');
    expect((await iterator.next()).value).toMatchObject({ type: 'text', source: 'dsh', data: { text: 'hello' } });
    expect((await iterator.next()).value).toMatchObject({ type: 'done', source: 'dsh' });
  });

  it('finalizes reasoning with authoritative text and duration', async () => {
    const queue = createDshEventQueue();
    const context = createDshTranslateContext(logger);
    const now = vi.spyOn(Date, 'now').mockReturnValue(1_000);

    try {
      translateDshEvent({ type: 'turn/start' }, queue, context);
      translateDshEvent({
        type: 'assistant/chunk',
        data: { chunk: { type: 'reasoning-delta', index: 0, text: 'partial' } },
      }, queue, context);
      now.mockReturnValue(1_250);
      translateDshEvent({
        type: 'assistant/chunk',
        data: {
          chunk: {
            type: 'block-end',
            index: 0,
            block: { type: 'reasoning', text: 'complete reasoning' },
          },
        },
      }, queue, context);

      const iterator = queue[Symbol.asyncIterator]();
      await iterator.next(); // turn/start status
      expect((await iterator.next()).value).toMatchObject({
        type: 'thinking',
        source: 'dsh',
        data: { stage: 'start', blockId: 'dsh-think-1', startedAt: 1_000 },
      });
      expect((await iterator.next()).value).toMatchObject({
        type: 'thinking',
        source: 'dsh',
        data: { stage: 'delta', blockId: 'dsh-think-1', text: 'partial' },
      });
      expect((await iterator.next()).value).toMatchObject({
        type: 'thinking',
        source: 'dsh',
        data: {
          stage: 'final',
          blockId: 'dsh-think-1',
          text: 'complete reasoning',
          durationMs: 250,
        },
      });
    } finally {
      now.mockRestore();
    }
  });

  it('falls back to streamed reasoning when block-end omits text', async () => {
    const queue = createDshEventQueue();
    const context = createDshTranslateContext(logger);

    translateDshEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', index: 2, text: 'one ' } },
    }, queue, context);
    translateDshEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'reasoning-delta', index: 2, text: 'two' } },
    }, queue, context);
    translateDshEvent({
      type: 'assistant/chunk',
      data: { chunk: { type: 'block-end', index: 2, block: { type: 'reasoning' } } },
    }, queue, context);

    const iterator = queue[Symbol.asyncIterator]();
    await iterator.next(); // thinking start
    await iterator.next(); // first delta
    await iterator.next(); // second delta
    expect((await iterator.next()).value).toMatchObject({
      type: 'thinking',
      source: 'dsh',
      data: { stage: 'final', text: 'one two' },
    });
  });
});
