// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { toast } from '@/lib/toast';
import { getSwallowActivationClickEnabled, useSwallowActivationClickSettings } from '../useSwallowActivationClickSettings';

vi.mock('@/i18n', () => ({ i18n: { t: (key: string) => key } }));

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.removeItem('input.swallowActivationClick');
});

// Unit: a refused Main write must leave both the rendered toggle and the DOM
// click adapter's current value intact.
it('keeps the last applied activation setting when the new value is refused', async () => {
  localStorage.setItem('input.swallowActivationClick', 'false');
  const save = vi.fn().mockRejectedValue(new Error('[ATTACHED_LOCAL_WRITE_REFUSED] fixture refusal'));
  vi.stubGlobal('electronAPI', { windowBehavior: { setSwallowActivationClick: save } });
  const errorToast = vi.spyOn(toast, 'error').mockImplementation(() => undefined as never);
  const { result } = renderHook(useSwallowActivationClickSettings);

  await act(async () => { result.current.setEnabled(true); });

  expect(save).toHaveBeenCalledExactlyOnceWith(true);
  expect(result.current.enabled).toBe(false);
  expect(getSwallowActivationClickEnabled()).toBe(false);
  expect(errorToast).toHaveBeenCalledExactlyOnceWith('ipcError.ATTACHED_LOCAL_WRITE_REFUSED');
});
