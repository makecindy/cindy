// @vitest-environment jsdom
import { act, renderHook } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { remoteProviderDisableKey } from '@cindy/model-providers';
import { useRemoteProviderDisable } from '../lib/remoteProviderDisable';
const state = vi.hoisted(() => ({ disabledProviders: {} as Record<string, boolean>, loading: false, refetch: vi.fn() }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => state }));
const setModelDisable = vi.fn();
beforeEach(() => {
  state.disabledProviders = {}; state.refetch.mockReset(); setModelDisable.mockReset();
  Object.assign(window, { electronAPI: { maker: { setModelDisable } } });
});
it('uses the existing disable command and shared provider refresh, without local storage', async () => {
  const storage = vi.spyOn(Storage.prototype, 'setItem');
  const { result, rerender } = renderHook(useRemoteProviderDisable);
  await act(() => result.current.setDisabled('peer', 'openai', true));
  expect(setModelDisable).toHaveBeenCalledWith({ kind: 'provider', remoteDeviceId: 'peer', providerId: 'openai', disabled: true });
  expect(state.refetch).toHaveBeenCalledOnce();
  expect(storage).not.toHaveBeenCalled(); storage.mockRestore();
  state.disabledProviders = { [remoteProviderDisableKey('peer', 'openai')]: true };
  rerender();
  expect(result.current.isDisabled('peer', 'openai')).toBe(true);
  expect(result.current.isDisabled('other-peer', 'openai')).toBe(false);
  await act(() => result.current.setDisabled('peer', 'openai', false));
  expect(setModelDisable).toHaveBeenLastCalledWith({ kind: 'provider', remoteDeviceId: 'peer', providerId: 'openai', disabled: false });
});
it('does not refresh or pretend success when persisting fails', async () => {
  setModelDisable.mockRejectedValueOnce(new Error('write failed'));
  const { result } = renderHook(useRemoteProviderDisable);
  await expect(result.current.setDisabled('peer', 'openai', true)).rejects.toThrow('write failed');
  expect(state.refetch).not.toHaveBeenCalled();
});
