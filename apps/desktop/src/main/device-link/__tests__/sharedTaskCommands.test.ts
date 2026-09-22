import { describe, expect, it, vi } from 'vitest';
import type { SharedTaskApi, SharedTaskListItem } from '@cindy/device-link';
import { executeSharedTaskAccountCommand } from '../sharedTaskCommands.js';

function listItem(sharedTaskId: string, overrides: Partial<SharedTaskListItem> = {}): SharedTaskListItem {
  return {
    sharedTaskId, sessionId: 'session-' + sharedTaskId, ownerAccountId: 'owner',
    hostDeviceId: 'device-a', title: 'task ' + sharedTaskId, revision: 1, ...overrides,
  };
}

function api(items: SharedTaskListItem[], failing = new Set<string>()): SharedTaskApi {
  return {
    list: vi.fn(async () => items),
    close: vi.fn(async (sharedTaskId: string) => {
      if (failing.has(sharedTaskId)) throw new Error('server busy');
      return { sharedTaskId, status: 'closed' as const };
    }),
  } as unknown as SharedTaskApi;
}

describe('sharedTask account commands', () => {
  it('lists owned shares for the caller account and flags locally hosted ones', async () => {
    const list = [listItem('a'), listItem('b', { ownerAccountId: 'someone-else' }), listItem('c', { hostDeviceId: 'device-b' })];
    const result = await executeSharedTaskAccountCommand({ action: 'owned' }, api(list), 'owner', { hostedIds: () => ['a'] });
    expect(result).toEqual([
      { ...listItem('a'), local: true },
      { ...listItem('c', { hostDeviceId: 'device-b' }), local: false },
    ]);
  });

  it('returns no owned shares without an account', async () => {
    const listSpy = api([listItem('a')]);
    expect(await executeSharedTaskAccountCommand({ action: 'owned' }, listSpy, undefined)).toEqual([]);
    expect(listSpy.list).not.toHaveBeenCalled();
  });

  it('closes a locally hosted task through the host journal, not the raw api', async () => {
    const closeHosted = vi.fn(async () => undefined);
    const listSpy = api([listItem('a')]);
    const result = await executeSharedTaskAccountCommand({ action: 'close', sharedTaskId: 'a' }, listSpy, 'owner',
      { hostedIds: () => ['a'], closeHosted });
    expect(closeHosted).toHaveBeenCalledWith('a');
    expect(listSpy.close).not.toHaveBeenCalled();
    expect(result).toEqual({ closed: ['a'], failed: [] });
  });

  it('closes remote-hosted tasks directly and keeps failed items for retry', async () => {
    const closeHosted = vi.fn(async () => undefined);
    const listSpy = api([listItem('a'), listItem('b', { hostDeviceId: 'device-b' }), listItem('c', { hostDeviceId: 'device-b' })], new Set(['c']));
    const result = await executeSharedTaskAccountCommand({ action: 'close', all: true }, listSpy, 'owner',
      { hostedIds: () => ['a'], closeHosted });
    expect(closeHosted).toHaveBeenCalledTimes(1);
    expect(listSpy.close).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ closed: ['a', 'b'], failed: [{ sharedTaskId: 'c' }] });
  });

  it('still rejects unknown account commands', async () => {
    await expect(executeSharedTaskAccountCommand({ action: 'nope' }, api([]), 'owner'))
      .rejects.toThrow('INVALID_PARAMS');
  });
});
