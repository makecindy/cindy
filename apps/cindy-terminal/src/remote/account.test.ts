import { expect, it, vi } from 'vitest';
import { TerminalRemoteAccountService } from './account.js';

it('reuses the shared-task account protocol and withholds late replies after an owner change', async () => {
  let scope: string | null = 'owner:global:1';
  const fetchMock = vi.fn<typeof fetch>().mockResolvedValue(new Response(JSON.stringify({ sharedTasks: [] })));
  const service = new TerminalRemoteAccountService({ getApiBaseUrl: () => 'https://example.test',
    getToken: async () => 'invalid-test-token', getOwnerScope: () => scope, fetch: fetchMock });
  await expect(service.sharedTasks.list()).resolves.toEqual([]);
  expect(fetchMock.mock.calls[0][0].toString()).toBe('https://example.test/api/device-link/shared-tasks');
  expect(fetchMock.mock.calls[0][1]?.headers).toMatchObject({ authorization: 'Bearer invalid-test-token' });
  fetchMock.mockImplementationOnce(async () => {
    scope = 'another-owner:global:2';
    return new Response(JSON.stringify({ sharedTasks: [] }));
  });
  await expect(service.sharedTasks.list()).rejects.toMatchObject({ code: 'OWNER_CHANGED' });
  scope = null;
  const count = fetchMock.mock.calls.length;
  await expect(service.sharedTasks.list()).rejects.toThrow();
  expect(fetchMock).toHaveBeenCalledTimes(count);
});
