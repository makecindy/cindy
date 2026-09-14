// @vitest-environment jsdom

import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useBetaChannelSettings } from '@/hooks/useBetaChannelSettings';

type ChannelSettings = {
  enableBeta: boolean;
  isCustomized?: boolean;
};

describe('useBetaChannelSettings', () => {
  let persisted: ChannelSettings;

  beforeEach(() => {
    persisted = { enableBeta: false, isCustomized: false };
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        getUpdateChannelSettings: vi.fn(async () => persisted),
        setUpdateChannelSettings: vi.fn(async ({ enableBeta }: { enableBeta: boolean }) => {
          persisted = { enableBeta, isCustomized: true };
          return persisted;
        }),
        resetUpdateChannelSettings: vi.fn(async () => {
          persisted = { enableBeta: false, isCustomized: false };
          return persisted;
        }),
        onUpdateChannelSettings: vi.fn(() => vi.fn()),
      } as unknown as Window['electronAPI'],
    });
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('keeps the switch and sidebar consumers aligned after each successful toggle', async () => {
    const switchConsumer = renderHook(() => useBetaChannelSettings());
    const badgeConsumer = renderHook(() => useBetaChannelSettings());

    await waitFor(() => {
      expect(switchConsumer.result.current.state.loading).toBe(false);
      expect(badgeConsumer.result.current.state.loading).toBe(false);
    });

    await act(async () => {
      await switchConsumer.result.current.setEnableBeta(true);
    });
    expect(switchConsumer.result.current.state.enableBeta).toBe(true);
    expect(badgeConsumer.result.current.state.enableBeta).toBe(true);

    await act(async () => {
      await switchConsumer.result.current.setEnableBeta(false);
    });
    expect(switchConsumer.result.current.state.enableBeta).toBe(false);
    expect(badgeConsumer.result.current.state.enableBeta).toBe(false);
  });
});
