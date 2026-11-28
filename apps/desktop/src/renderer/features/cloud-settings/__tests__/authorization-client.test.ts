import { afterEach, expect, it, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { fixture } from '../../../../main/cloud-settings-client/__tests__/fixture';
import { createCloudSettingsClient } from '../client';
const cleanups: Array<() => void> = [];
afterEach(() => cleanups.splice(0).forEach((f) => f()));
async function setup() {
  const f = fixture();
  cleanups.push(f.stop);
  const client = createCloudSettingsClient('cloud-a', f.bridge(), () => {});
  const page = await client.manage!({ operation: 'list', section: 'providers' });
  if (page.kind !== 'page') throw Error('invalid fixture');
  return { ...f, client, actionId: page.items[0]!.actions[0]!.id };
}
it('uses the existing management engine and device-code prompt', async () => {
  const f = await setup(),
    operationId = randomUUID();
  await f.client.manage!({ operation: 'run', actionId: f.actionId, operationId, values: {} });
  expect(await f.client.manage!({ operation: 'status', operationId })).toMatchObject({
    phase: 'waiting',
    prompt: { userCode: 'SAMPLE-CODE' },
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('lost login reply does not start login twice', async () => {
  const f = await setup(),
    operationId = randomUUID();
  f.loseReply();
  await f.client.manage!({ operation: 'run', actionId: f.actionId, operationId, values: {} });
  expect(await f.client.manage!({ operation: 'status', operationId })).toMatchObject({
    phase: 'waiting',
  });
  expect(f.run).toHaveBeenCalledTimes(1);
});
it('another window cannot run a ticket or query/cancel an operation', async () => {
  const f = await setup(),
    other = createCloudSettingsClient('cloud-a', f.bridge(2), () => {}),
    operationId = randomUUID();
  await expect(
    other.manage!({ operation: 'run', actionId: f.actionId, operationId, values: {} }),
  ).rejects.toThrow();
  await f.client.manage!({ operation: 'run', actionId: f.actionId, operationId, values: {} });
  await expect(other.manage!({ operation: 'status', operationId })).rejects.toThrow(
    'SCOPE_CHANGED',
  );
  await expect(other.manage!({ operation: 'cancel', operationId })).rejects.toThrow(
    'SCOPE_CHANGED',
  );
  expect(f.cancelled).not.toHaveBeenCalled();
});
it('close cancels its own active authorization once and does not log out', async () => {
  const f = await setup(),
    operationId = randomUUID();
  await f.client.manage!({ operation: 'run', actionId: f.actionId, operationId, values: {} });
  f.client.close();
  f.client.close();
  await vi.waitFor(() => expect(f.cancelled).toHaveBeenCalledTimes(1));
  expect(
    f.history.filter((c) => c.kind === 'manage' && c.command.operation === 'run'),
  ).toHaveLength(1);
  expect(f.request.mock.calls.some((c) => /logout|disconnect/.test(c[1]))).toBe(false);
});
it('unrelated management sections are rejected without dispatch', async () => {
  const f = await setup();
  const count = f.request.mock.calls.length;
  await expect(f.client.manage!({ operation: 'list', section: 'memory' })).rejects.toThrow(
    'UNSUPPORTED',
  );
  expect(f.request).toHaveBeenCalledTimes(count);
});
