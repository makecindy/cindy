// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  __testing as dataOwnerGenerationTesting,
  setDataOwnerGeneration,
} from '../../contexts/dataOwnerGeneration';
import { useCompactionSettings } from '../useCompactionSettings';

describe('useCompactionSettings', () => {
  beforeEach(() => {
    dataOwnerGenerationTesting.reset();
    delete (window as unknown as { electronAPI?: unknown }).electronAPI;
    vi.useFakeTimers();
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
});
