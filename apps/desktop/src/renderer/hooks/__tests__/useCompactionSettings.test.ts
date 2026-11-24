// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '../../contexts/dataOwnerGeneration';
import { useCompactionSettings } from '../useCompactionSettings';
import { toast } from '@/lib/toast';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

describe('useCompactionSettings', () => {
  beforeEach(() => {
    dataOwnerGenerationTesting.reset();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('flushes a pending Pi write with the owner stamp from before unmount', async () => {
    const piCompactionSetPct = vi.fn().mockResolvedValue({
      pct: 80,
      isCustomized: true,
      defaultPct: 90,
    });
    const maker = {
      piCompactionGetState: vi.fn().mockResolvedValue({
        pct: 90,
        isCustomized: false,
        defaultPct: 90,
      }),
      piCompactionSetPct,
      piCompactionResetPct: vi.fn(),
    };
    (window as unknown as { electronAPI: { maker: typeof maker } }).electronAPI = { maker };
    setDataOwnerGeneration('owner-a', 4);

    const hook = renderHook(() => useCompactionSettings('pi'));
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      hook.result.current.setPct(80);
    });
    setDataOwnerGeneration('owner-b', 5);
    hook.unmount();

    expect(piCompactionSetPct).toHaveBeenCalledWith(80, {
      dataOwnerId: 'owner-a',
      ownerGeneration: 4,
    });
    vi.useRealTimers();
  });

  // Unit: the real deferred write also reports refusal when settings unmount
  // before its debounce ends. The old unmount branch discarded the error.
  it('reports a refused compaction write when settings close', async () => {
    const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
    vi.stubGlobal('electronAPI', {
      maker: {
        compactionGetState: vi.fn().mockResolvedValue({ pct: 90, isCustomized: false, defaultPct: 90 }),
        compactionSetPct: vi.fn().mockRejectedValue(new Error('[ATTACHED_LOCAL_WRITE_REFUSED] fixture refusal')),
        compactionResetPct: vi.fn(),
      },
    });
    const hook = renderHook(() => useCompactionSettings());
    await act(async () => { await Promise.resolve(); });
    act(() => hook.result.current.setPct(80));
    await act(async () => hook.unmount());
    expect(errorToast).toHaveBeenCalledExactlyOnceWith('ipcError.ATTACHED_LOCAL_WRITE_REFUSED');
  });
});
