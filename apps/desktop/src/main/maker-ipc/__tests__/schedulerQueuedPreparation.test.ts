import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import { runSchedulerQueuedPreparation } from '../schedulerQueuedPreparation';

describe('queued scheduler pre-send preparation', () => {
  it('finishes once before the queued send captures its runtime', async () => {
    const events: string[] = [];
    const preparations = new Map([['queued-1', { onPreparing: async () => { events.push('prepare'); } }]]);
    const send = async () => {
      await runSchedulerQueuedPreparation('queued-1', preparations, () => {});
      events.push('capture-session');
    };
    await send();
    await send();
    expect(events).toEqual(['prepare', 'capture-session', 'capture-session']);
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
    await expect(runSchedulerQueuedPreparation('queued-2', preparations, onFailure)).rejects.toMatchObject({
      name: 'SchedulerQueuedPreparationError', cause: error,
    });
    expect(onPreparationFailed).toHaveBeenCalledExactlyOnceWith(error);
    expect(onFailure).toHaveBeenCalledOnce();
    expect(preparations.size).toBe(0);
  });
});
