import { expect, it } from 'vitest';
import { RemoteInvokeTiming } from '../remoteInvokeTiming';
it('records failed stages without changing the error and separates subsequent work', async () => {
  let now = 0;
  const timing = new RemoteInvokeTiming(() => now);
  const failure = new Error('private');
  await expect(timing.measure('authorizeBefore', async () => { now += 125; throw failure; })).rejects.toBe(failure);
  expect(await timing.measure('handler', async () => { now += 250; return 42; })).toBe(42);
  expect(timing.stages).toEqual({ authorizeBefore: 125, handler: 250 });
  expect(JSON.stringify(timing)).not.toContain('private');
});
