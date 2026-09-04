// @vitest-environment jsdom

import { act, renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { useAppearanceBackground } from '../useAppearanceBackground';

const initialSettings = {
  uiFamily: '',
  codeFamily: '',
  uiSize: 13,
  codeSize: 14,
  windowZoom: 1,
  backgroundImage: 'cindy-background://current/background-123e4567-e89b-12d3-a456-426614174000.jpg',
  backgroundOverlay: 0.58,
  backgroundBlur: 0,
};

function installBridge(setPatch: ReturnType<typeof vi.fn>) {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      appearanceSettings: {
        getSync: () => initialSettings,
        setPatch,
        onChanged: () => () => undefined,
      },
    },
  });
}

describe('useAppearanceBackground', () => {
  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('rolls an optimistic appearance update back when persistence fails', async () => {
    installBridge(vi.fn().mockRejectedValue(new Error('settings locked')));
    const { result } = renderHook(() => useAppearanceBackground());

    let saved = true;
    await act(async () => {
      saved = await result.current.setPatch({ backgroundOverlay: 0.8 });
    });

    expect(saved).toBe(false);
    expect(result.current.backgroundOverlay).toBe(initialSettings.backgroundOverlay);
  });

  it('keeps the normalized persisted value after a successful update', async () => {
    installBridge(vi.fn().mockResolvedValue({ ...initialSettings, backgroundBlur: 12 }));
    const { result } = renderHook(() => useAppearanceBackground());

    let saved = false;
    await act(async () => {
      saved = await result.current.setPatch({ backgroundBlur: 12 });
    });

    expect(saved).toBe(true);
    expect(result.current.backgroundBlur).toBe(12);
  });
});
