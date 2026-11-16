/** Unit: new production host projection/publisher. Existing notify tests only
 * exercise individual alerts; these cover full inventory and account teardown
 * while an upload is in flight (fake timers, no real waits). */
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentIslandSessionSnapshot } from '../../../shared/agentIsland.js';
import { createTaskActivityPublisher, projectHostTaskActivity } from '../taskActivity';

afterEach(() => vi.useRealTimers());
const row = (sessionId: string, phase: AgentIslandSessionSnapshot['phase'], attention = false) =>
  ({ sessionId, title: sessionId, phase, attention }) as AgentIslandSessionSnapshot;
it('counts all owned inventory and prioritizes waiting, unread, running without private content', () => {
  const unread = Array.from({ length: 240 }, (_, i) => row(`result-${i}`, 'completed', true));
  const result = projectHostTaskActivity([
    row('run', 'running'),
    ...unread,
    row('read', 'completed'),
    {
      ...row('wait', 'needs-interaction'),
      activityLines: [{ text: 'secret tool arguments' }],
    } as AgentIslandSessionSnapshot,
  ]);
  expect(result).toEqual({
    schemaVersion: 1,
    waitingCount: 1,
    unreadCount: 240,
    runningCount: 1,
    selected: { sessionId: 'wait', title: 'wait', status: 'attention' },
  });
  expect(projectHostTaskActivity([row('run', 'running'), ...unread]).selected?.status).toBe(
    'completed',
  );
  expect(projectHostTaskActivity([row('read', 'completed')]).selected).toBeNull();
});
it('coalesces bursts, uploads the latest state and aborts the previous connection', async () => {
  vi.useFakeTimers();
  let resolve!: () => void;
  const send = vi.fn(
    (_signal: AbortSignal) =>
      new Promise<void>((done) => {
        resolve = done;
      }),
  );
  const publisher = createTaskActivityPublisher(send);
  publisher.setOnline(true);
  for (let i = 0; i < 50; i++) publisher.changed();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send).toHaveBeenCalledTimes(1);
  publisher.changed();
  publisher.changed();
  resolve();
  await vi.advanceTimersByTimeAsync(1_000);
  expect(send).toHaveBeenCalledTimes(2);
  const old = send.mock.calls[1][0];
  publisher.setOnline(false);
  expect(old.aborted).toBe(true);
  resolve();
  await vi.advanceTimersByTimeAsync(120_000);
  expect(send).toHaveBeenCalledTimes(2);
  publisher.dispose();
});
