import { afterEach, expect, it } from 'vitest';
import { configureBotRuntimeEpochRefreshRequest, requestBotRuntimeEpochRefresh } from '../botRuntimeEpochRefreshSignal.js';

afterEach(() => configureBotRuntimeEpochRefreshRequest(null));
it('does not claim a refresh when no handler is installed', async () => {
  expect(await requestBotRuntimeEpochRefresh('chat', 'resource')).toBe(false);
});
it.each(['refreshed', 'deferred', 'not-bot'] as const)('uses the actual %s outcome', async outcome => {
  configureBotRuntimeEpochRefreshRequest(async () => outcome);
  expect(await requestBotRuntimeEpochRefresh('chat', 'resource')).toBe(outcome === 'refreshed');
});
it('contains asynchronous and synchronous handler failures', async () => {
  configureBotRuntimeEpochRefreshRequest(async () => { throw new Error('bootstrap failed'); });
  expect(await requestBotRuntimeEpochRefresh('chat', 'resource')).toBe(false);
  configureBotRuntimeEpochRefreshRequest(() => { throw new Error('owner changed'); });
  expect(await requestBotRuntimeEpochRefresh('chat', 'resource')).toBe(false);
});
