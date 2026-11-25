import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import type { ManagementExecution } from '../../host-settings/management';
import { fixture } from './fixture';

// Unit: a session keeps a callback receiver only while its operation runs.
const receivers = vi.hoisted(() => ({ made: [] as Array<{ close: ReturnType<typeof vi.fn>; finish: ReturnType<typeof vi.fn> }> }));
vi.mock('../authorizationCallback', () => ({
  createCloudAuthorizationCallback: ({ prompt }: { prompt: { url: string } }) => {
    const receiver = { url: prompt.url, ready: Promise.resolve(), close: vi.fn(), finish: vi.fn(), claimManual: vi.fn() };
    receivers.made.push(receiver);
    return receiver;
  },
}));
const cleanups: Array<() => void> = [];
afterEach(() => { cleanups.splice(0).forEach((stop) => stop()); receivers.made.length = 0; });

it('keeps no callback receiver for an ended authorization', async () => {
  const f = fixture();
  cleanups.push(f.stop);
  f.run.mockImplementation(async (_values: Record<string, string>, execution: ManagementExecution) => {
    execution.prompt({ kind: 'callback', url: 'https://login.example.test/authorize', expiresAt: Date.now() + 60_000 });
    await new Promise<void>((resolve) => execution.signal.addEventListener('abort', () => resolve(), { once: true }));
  });
  const bridge = f.bridge(),
    { handle } = await bridge.open({ deviceId: 'cloud-a' });
  for (let i = 0; i < 20; i++) {
    const page = await bridge.manage({ handle, command: { operation: 'list', section: 'providers' } });
    if (!page.ok || !('management' in page) || page.management.kind !== 'page') throw Error('fixture');
    const operationId = randomUUID();
    await bridge.manage({ handle, command: { operation: 'run', actionId: page.management.items[0]!.actions[0]!.id, operationId, values: {} } });
    await vi.waitFor(async () => {
      const status = await bridge.manage({ handle, command: { operation: 'status', operationId } });
      expect(status.ok && 'management' in status && status.management.kind === 'operation' && status.management.phase).toBe('waiting');
    });
    await bridge.manage({ handle, command: { operation: 'cancel', operationId } });
  }
  expect(receivers.made).toHaveLength(20);
  // Closing the session closes every receiver it still holds: none, since each ended with its operation.
  const ended = receivers.made.map((receiver) => receiver.close.mock.calls.length + receiver.finish.mock.calls.length);
  await bridge.close({ handle });
  expect(receivers.made.map((receiver) => receiver.close.mock.calls.length + receiver.finish.mock.calls.length)).toEqual(ended);
  expect(ended.every((count) => count >= 1)).toBe(true);
});
