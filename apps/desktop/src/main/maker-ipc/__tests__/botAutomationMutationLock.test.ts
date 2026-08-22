import { beforeEach, describe, expect, it } from 'vitest';

import {
  resetBotAutomationMutationLocksForTest,
  withBotAutomationMutationLock,
} from '../botAutomationMutationLock';

beforeEach(() => resetBotAutomationMutationLocksForTest());

describe('Bot automation mutation lock', () => {
  it('serializes one schedule while allowing unrelated schedules to proceed', async () => {
    const order: string[] = [];
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });

    const first = withBotAutomationMutationLock('schedule-1', async () => {
      order.push('first:start');
      await firstGate;
      order.push('first:end');
    });
    const second = withBotAutomationMutationLock('schedule-1', async () => {
      order.push('second');
    });
    const unrelated = withBotAutomationMutationLock('schedule-2', async () => {
      order.push('unrelated');
    });

    await unrelated;
    expect(order).toEqual(['first:start', 'unrelated']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(order).toEqual(['first:start', 'unrelated', 'first:end', 'second']);
  });

  it('releases the next mutation after a failure', async () => {
    const first = withBotAutomationMutationLock('schedule-1', async () => {
      throw new Error('failed mutation');
    });
    const second = withBotAutomationMutationLock('schedule-1', async () => 'continued');

    await expect(first).rejects.toThrow('failed mutation');
    await expect(second).resolves.toBe('continued');
  });
});
