import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runSchedulerQueuedPreparation } from '../schedulerQueuedPreparation';
import type { UserMessage } from '@cindy/maker-core';

describe('queued scheduler pre-send preparation', () => {
  it('finishes once before the queued send captures its runtime', async () => {
    const events: string[] = [];
    const preparations = new Map([['queued-1', { onPreparing: async () => { events.push('prepare'); } }]]);
    const send = async () => {
      await runSchedulerQueuedPreparation('queued-1', preparations, () => {}, { type: 'user', content: 'work' });
      events.push('capture-session');
    };
    await Promise.all([send(), send()]);
    await send();
    expect(events).toEqual(['prepare', 'capture-session', 'capture-session', 'capture-session']);
    expect(preparations.size).toBe(1); // Accepted/discard hooks, not preparation, own cleanup.
    const source = readFileSync(resolve(__dirname, '../register.ts'), 'utf8');
    const lockBody = source.slice(source.indexOf('const sendToAgentAccepted: typeof'),
      source.indexOf('contextOverflowRolloverHolder =', source.indexOf('const sendToAgentAccepted: typeof')));
    expect(lockBody.indexOf('runSchedulerQueuedPreparation(')).toBeGreaterThan(lockBody.indexOf('withSendToSessionLock('));
    expect(lockBody.indexOf('runSchedulerQueuedPreparation(')).toBeLessThan(lockBody.lastIndexOf('sendToAgentAcceptedUnlocked(...args));'));
  });

  it('rejects the queued send on preparation failure and reports it once', async () => {
    const error = new Error('target window cannot be prepared');
    const onPreparationFailed = vi.fn();
    const onFailure = vi.fn();
    const preparations = new Map([['queued-2', {
      onPreparing: async () => { throw error; }, onPreparationFailed,
    }]]);
    const message: UserMessage = { type: 'user', content: 'work' };
    await expect(runSchedulerQueuedPreparation('queued-2', preparations, onFailure, message)).rejects.toMatchObject({
      name: 'SchedulerQueuedPreparationError', cause: error,
    });
    expect(onPreparationFailed).toHaveBeenCalledExactlyOnceWith(error);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(preparations.size).toBe(0);
    expect(message.content).toBe('work');
  });

  // #10479 review P1 / unit: preparation runs after the queue text was copied.
  // Preserve Continue/attachments and never append twice on a re-entered send.
  it.each(['raw-text', 'text', 'attachments'] as const)('appends guidance only to the outbound %s message once', async (kind) => {
    const original: UserMessage['content'] = kind !== 'attachments' ? 'Continue'
      : [{ type: 'text', text: 'Continue' }, { type: 'image', path: 'attachment.png', mimeType: 'image/png' }];
    const message: UserMessage | string = kind === 'raw-text' ? 'Continue' : { type: 'user', content: original };
    const onPreparing = vi.fn(async () => ({ getAppendText: () => '\nPi completion guidance' }));
    const preparations = new Map([['queued', { onPreparing }]]);
    let preparedMessage = await runSchedulerQueuedPreparation('queued', preparations, () => {}, message);
    preparedMessage = await runSchedulerQueuedPreparation('queued', preparations, () => {}, preparedMessage);
    const content = typeof preparedMessage === 'string' ? preparedMessage : preparedMessage.content;
    expect(content).toEqual(kind !== 'attachments' ? 'Continue\nPi completion guidance'
      : [...original, { type: 'text', text: '\nPi completion guidance' }]);
    expect(original).toEqual(kind !== 'attachments' ? 'Continue'
      : [{ type: 'text', text: 'Continue' }, { type: 'image', path: 'attachment.png', mimeType: 'image/png' }]);
    expect(onPreparing).toHaveBeenCalledOnce();
    const freshMessage: UserMessage | string = kind === 'raw-text' ? 'Continue' : { type: 'user', content: original };
    const retriedMessage = await runSchedulerQueuedPreparation('queued', preparations, () => {}, freshMessage);
    expect(typeof retriedMessage === 'string' ? retriedMessage : retriedMessage.content).toEqual(content);
    expect(onPreparing).toHaveBeenCalledOnce();
  });
});
