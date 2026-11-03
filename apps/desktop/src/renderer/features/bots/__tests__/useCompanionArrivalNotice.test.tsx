// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { __testing, setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

const h = vi.hoisted(() => ({
  notices: undefined as string[] | undefined,
  toast: vi.fn(),
  dismiss: vi.fn((_botId: string): Promise<void> => Promise.resolve()),
  refresh: vi.fn(async () => undefined),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { info: h.toast } }));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ actors: [{ externalId: 'mia', arrivalNotices: h.notices }] }),
  companionCloudApi: () => ({ dismissCompanionArrivalNotices: h.dismiss }),
  refreshCompanionCloudSettled: h.refresh,
}));

import { useCompanionArrivalNotice } from '../useCompanionArrivalNotice';

const deferred = () => {
  let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((ok, fail) => { resolve = ok; reject = fail; });
  return { promise, resolve, reject };
};
const settle = () => act(async () => { await new Promise(done => setTimeout(done, 0)); });

describe('useCompanionArrivalNotice', () => {
  beforeEach(() => {
    h.toast.mockClear(); h.dismiss.mockReset().mockResolvedValue(undefined); h.refresh.mockClear();
    h.notices = ['permissions'];
    __testing.reset();
  });

  it('does not repeat a notice while its dismissal is still being read back, then shows the next arrival of the same notice again even when the chat was closed meanwhile', async () => {
    const pending = deferred();
    h.dismiss.mockReturnValueOnce(pending.promise);
    const first = renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    expect(h.toast).toHaveBeenCalledTimes(1);
    expect(h.dismiss).toHaveBeenCalledTimes(1);
    // A stale snapshot comes round again before main's dismissal is read back.
    first.rerender();
    expect(h.toast).toHaveBeenCalledTimes(1);
    // The chat page closes, the dismissal lands and the snapshot is read back (now empty).
    first.unmount();
    pending.resolve();
    await settle();
    expect(h.refresh).toHaveBeenCalledTimes(1);
    // The same companion arrives again with the same notice: new toast, new dismissal.
    renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    expect(h.toast).toHaveBeenCalledTimes(2);
    expect(h.dismiss).toHaveBeenCalledTimes(2);
  });

  it('ends the dedupe when the dismissal fails, so a later arrival can show it again', async () => {
    const pending = deferred();
    h.dismiss.mockReturnValueOnce(pending.promise);
    const view = renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    pending.reject(new Error('IPC'));
    await settle();
    expect(h.refresh).not.toHaveBeenCalled();
    view.unmount();
    renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    expect(h.toast).toHaveBeenCalledTimes(2);
  });

  it('does not carry what was shown for one account over to the next', () => {
    h.dismiss.mockReturnValue(new Promise<void>(() => undefined));
    setDataOwnerGeneration('owner-a');
    const view = renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    expect(h.toast).toHaveBeenCalledTimes(1);
    view.unmount();
    setDataOwnerGeneration('owner-b');
    renderHook(() => useCompanionArrivalNotice('mia', 'Mia'));
    expect(h.toast).toHaveBeenCalledTimes(2);
  });
});
