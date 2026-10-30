import { beforeEach, expect, it, vi } from 'vitest';
import { providerShareHostPeer } from '@cindy/device-link';
import { createNativeHistoryRelocator } from '../controller/relocateNativeHistory';

const h = vi.hoisted(() => ({ generation: 1, caps: vi.fn(), remote: vi.fn(), transfer: vi.fn(), local: vi.fn() }));
vi.mock('../../appSessionState', () => ({ getActiveAppSession: () => ({ generation: h.generation }) }));
vi.mock('../nativeHistoryStorage', () => ({ nativeHistoryStorage: () => ({}) }));
vi.mock('../nativeHistoryTransfer', () => ({ createNativeHistoryTransfer: () => h.local, transferNativeHistory: h.transfer }));
vi.mock('../controller/runClient', () => ({
  remoteAgentInvoker: (device: string) => async (args: unknown[]) => h.remote(device, args),
  RemoteAgentRunClient: { caps: h.caps },
}));
beforeEach(() => { vi.resetAllMocks(); h.generation = 1; });
const input = { sessionId: 'task', kind: 'codex' as const, nativeId: 'native', workingDir: '/project',
  fromDevice: null, toDevice: 'mini', assertCurrent: () => {} };

it.each([
  ['task source', 'share:untrusted', 'mini'],
  ['task destination', null, 'share:untrusted'],
  ['resolved source', providerShareHostPeer('untrusted', 'host'), 'mini'],
  ['resolved destination', null, providerShareHostPeer('untrusted', 'host')],
])('rejects a sharing %s before consulting its advertised capability', async (_label, fromDevice, toDevice) => {
  h.caps.mockResolvedValue({ nativeHistoryTransfer: true });
  h.transfer.mockResolvedValue('restored');
  expect(await createNativeHistoryRelocator('/test-user-data', vi.fn())({ ...input, fromDevice, toDevice })).toBeNull();
  expect(h.caps).not.toHaveBeenCalled();
  expect(h.transfer).not.toHaveBeenCalled();
  expect(h.remote).not.toHaveBeenCalled();
  expect(h.local).not.toHaveBeenCalled();
});

it('leaves old peers on the existing handoff path without starting a snapshot', async () => {
  h.caps.mockResolvedValue({});
  expect(await createNativeHistoryRelocator('/test-user-data', vi.fn())(input)).toBeNull();
  expect(h.transfer).not.toHaveBeenCalled();
  expect(h.local).not.toHaveBeenCalled();
});

it('requires support at both endpoints before transferring between remote computers', async () => {
  h.caps.mockResolvedValueOnce({ nativeHistoryTransfer: true }).mockResolvedValueOnce({});
  expect(await createNativeHistoryRelocator('/test-user-data', vi.fn())({ ...input, fromDevice: 'studio' })).toBeNull();
  expect(h.transfer).not.toHaveBeenCalled();
});

it('routes the entire transfer through the source and target of this task', async () => {
  h.caps.mockResolvedValue({ nativeHistoryTransfer: true });
  h.transfer.mockImplementation(async (source, target, _kind, _id, assertCurrent) => {
    assertCurrent();
    await source({ action: 'export', kind: 'codex', nativeId: 'native' });
    await target({ action: 'restore', id: 'handle' });
    return 'restored';
  });
  expect(await createNativeHistoryRelocator('/test-user-data', vi.fn())({ ...input, fromDevice: 'studio' })).toBe('restored');
  expect(h.remote.mock.calls).toEqual([
    ['studio', [{ op: 'native-history', sessionId: 'task', command: { action: 'export', kind: 'codex', nativeId: 'native' } }]],
    ['mini', [{ op: 'native-history', sessionId: 'task', command: { action: 'restore', id: 'handle' } }]],
  ]);
});

it('rejects a late capability result from a previous account', async () => {
  h.caps.mockImplementation(async () => { h.generation++; return { nativeHistoryTransfer: true }; });
  await expect(createNativeHistoryRelocator('/test-user-data', vi.fn())(input)).rejects.toThrow('REMOTE_AGENT_ACCOUNT_CHANGED');
  expect(h.transfer).not.toHaveBeenCalled();
});
