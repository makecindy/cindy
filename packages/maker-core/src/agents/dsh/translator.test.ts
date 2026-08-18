import { describe, expect, it } from 'vitest';

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
});
