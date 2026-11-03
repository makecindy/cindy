import { beforeEach, expect, it, vi } from 'vitest';

const storage = vi.hoisted(() => ({
  keys: [] as string[],
  getAllKeys: vi.fn(async () => storage.keys),
  multiRemove: vi.fn(async (_keys: string[]) => undefined),
}));
vi.mock('@react-native-async-storage/async-storage', () => ({
  default: { getAllKeys: storage.getAllKeys, multiRemove: storage.multiRemove },
}));

import { removeLegacyClipboardInvitationHistory } from '@/device-link/legacyClipboardInvitationHistory';

beforeEach(() => {
  vi.clearAllMocks();
  storage.keys = [];
});

it('removes only the old per-account clipboard invitation digests', async () => {
  storage.keys = [
    'cindy.mobile.shared-task.clipboard-history.v1.["global","a"]',
    'cindy.mobile.shared-task.clipboard-history.v1.["cn","b"]',
    'cindy.mobile.other',
  ];
  await removeLegacyClipboardInvitationHistory();
  expect(storage.multiRemove).toHaveBeenCalledExactlyOnceWith(storage.keys.slice(0, 2));
});

it('skips removal when nothing is left and swallows storage failures', async () => {
  await removeLegacyClipboardInvitationHistory();
  expect(storage.multiRemove).not.toHaveBeenCalled();
  storage.getAllKeys.mockRejectedValueOnce(new Error('storage unavailable'));
  await expect(removeLegacyClipboardInvitationHistory()).resolves.toBeUndefined();
});
