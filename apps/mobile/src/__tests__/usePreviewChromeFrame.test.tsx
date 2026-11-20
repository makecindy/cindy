// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { WindowGeometry } from '@/platform/windowGeometry';
import { usePreviewChromeFrame } from '@/session/usePreviewChromeFrame';

const state = vi.hoisted(() => ({ window: {} as WindowGeometry, platform: 'ios' }));
vi.mock('react-native', () => ({ Platform: { get OS() { return state.platform; } } }));
vi.mock('@/platform/AdaptiveWindowContext', () => ({ useAdaptiveWindow: () => state.window }));
vi.mock('react-native-safe-area-context', () => ({ useSafeAreaInsets: () => state.window.insets }));

it('moves document chrome and content together when Duo rotates into its vertical bar', () => {
  state.platform = 'ios';
  state.window = { width: 662, height: 942, insets: { top: 82, left: 0, right: 0, bottom: 20 },
    regularWidth: true, regularHeight: true, barEdge: 'none', reservedRegionsSupported: true,
    regions: [{ kind: 'occlusion', x: 520, y: 0, width: 142, height: 82 }] };
  const { result, rerender } = renderHook(usePreviewChromeFrame);
  expect(result.current).toMatchObject({ top: 26, right: 150, sharedStatusRow: true,
    documentHeaderHeight: 44, documentContentTop: 82 });
  state.window = { ...state.window, width: 942, height: 662, barEdge: 'right',
    insets: { top: 0, left: 0, right: 60, bottom: 20 }, regions: [] };
  rerender();
  expect(result.current).toMatchObject({ top: 12, right: 72, sharedStatusRow: false,
    documentHeaderHeight: 44, documentContentTop: 60 });
});

describe.each(['ios', 'android'])('ordinary %s document chrome', platform => {
  it('retains the 64pt header below the safe area', () => {
    state.platform = platform;
    state.window = { width: 390, height: 844, insets: { top: 59, left: 0, right: 0, bottom: 34 },
      regularWidth: false, regularHeight: true, barEdge: 'none', reservedRegionsSupported: false, regions: [] };
    const { result } = renderHook(usePreviewChromeFrame);
    expect(result.current).toMatchObject({ top: 59, documentHeaderHeight: 64, documentContentTop: 123 });
  });
});
