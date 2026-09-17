import { beforeEach, expect, it, vi } from 'vitest';

const native = vi.hoisted(() => ({ readSnapshot: vi.fn(), clearSnapshot: vi.fn() }));
vi.mock('expo-modules-core', () => ({ requireOptionalNativeModule: () => native }));
import { getSharedPayloads, clearSharedPayloads } from '@/session/incomingShareNative';

beforeEach(() => vi.clearAllMocks());

it('acknowledges the exact captured bytes, not a subsequent read or re-encoded payload', () => {
  const first = '[ { "type":"file", "value":"file:///a/report.pdf", "mimeType":"application/pdf" } ]';
  native.readSnapshot.mockReturnValueOnce(first).mockReturnValueOnce('[]');
  const payloads = getSharedPayloads();
  expect(payloads).toEqual([{ shareType: 'file', value: 'file:///a/report.pdf', mimeType: 'application/pdf' }]);
  getSharedPayloads();
  clearSharedPayloads(payloads);
  expect(native.clearSnapshot).toHaveBeenCalledWith(first);
  expect(native.readSnapshot).toHaveBeenCalledTimes(2);
});

it('never clears a slot for an unknown array or missing native snapshot', () => {
  native.readSnapshot.mockReturnValue(null);
  clearSharedPayloads(getSharedPayloads());
  clearSharedPayloads([]);
  expect(native.clearSnapshot).not.toHaveBeenCalled();
});
