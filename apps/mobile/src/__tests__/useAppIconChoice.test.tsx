// @vitest-environment jsdom
// Unit regression for #10727 / discussion_r4580229577: the real settings hook
// must keep the selected icon equal to the native result after overlapping taps.
// Native bridge tests do not mount the hook or exercise pending/failure timing.
// Measured: 2.32s standalone with the adjacent native tests (4 hook cases).
// Separate DOM file keeps the native/config-plugin tests in their node environment.
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { APP_ICONS } from '@cindy/maker-shared';

const bridge = vi.hoisted(() => ({ read: vi.fn(), apply: vi.fn(), alert: vi.fn() }));
vi.mock('@/platform/appIcon', () => ({ readAppIconState: bridge.read, applyAppIcon: bridge.apply }));
vi.mock('react-native', () => ({ Alert: { alert: bridge.alert } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
import { useAppIconChoice } from '@/settings/useAppIconChoice';

afterEach(() => { cleanup(); vi.resetAllMocks(); });

it.each([
  { fails: false, next: APP_ICONS[0] },
  { fails: true, next: APP_ICONS[0] },
  { fails: false, next: APP_ICONS[2] },
  { fails: true, next: APP_ICONS[2] },
])('keeps native and selected state consistent for $next, fails=$fails', async ({ fails, next }) => {
  const initial = { icons: [...APP_ICONS], current: APP_ICONS[0], darkArtwork: true };
  bridge.read.mockResolvedValue(initial);
  let settle!: () => void;
  bridge.apply.mockImplementation(() => new Promise<void>((resolve, reject) => {
    settle = () => fails ? reject(new Error('denied')) : resolve();
  }));
  const { result } = renderHook(() => useAppIconChoice());
  await waitFor(() => expect(result.current).not.toBeNull());
  act(() => {
    result.current!.select(APP_ICONS[1]);
    result.current!.select(next);
  });
  expect(bridge.apply).toHaveBeenCalledTimes(1);
  // The ring represents the confirmed icon, not a still-pending request.
  expect(result.current!.state.current).toBe(APP_ICONS[0]);
  const confirmed = { ...initial, current: fails ? APP_ICONS[0] : APP_ICONS[1] };
  bridge.read.mockResolvedValue(confirmed);
  await act(async () => { settle(); });
  expect(result.current!.state.current).toBe(confirmed.current);
  expect(bridge.alert).toHaveBeenCalledTimes(fails ? 1 : 0);
  // Both settle paths release pending state, allowing the next selection.
  act(() => result.current!.select(fails ? APP_ICONS[1] : APP_ICONS[0]));
  expect(bridge.apply).toHaveBeenCalledTimes(2);
  await act(async () => { settle(); });
});
