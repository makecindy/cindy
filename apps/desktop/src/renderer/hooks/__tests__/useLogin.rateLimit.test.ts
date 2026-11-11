// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

const auth = vi.hoisted(() => ({
  loginState: null as { step: string; retryAt?: number } | null,
  loadLoginState: vi.fn(),
  dispatchLoginAction: vi.fn(),
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => auth }));
import { useLogin } from '../useLogin';

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  auth.loginState = null;
});

it('shows the received deadline and clears it for a subsequent storage error or reset', async () => {
  const hook = renderHook(() => useLogin({ autoLoad: false }));
  auth.loginState = { step: 'identifier', retryAt: 1_800_000_000_000 };
  auth.dispatchLoginAction.mockResolvedValueOnce({
    success: false,
    code: 'RATE_LIMITED',
    retryAt: 1_800_000_000_000,
  });
  await act(async () => {
    await hook.result.current.dispatch({
      type: 'request-code',
      kind: 'phone',
      identifier: '13800138000',
    });
  });
  expect(hook.result.current.retryAt).toBe(1_800_000_000_000);
  auth.dispatchLoginAction.mockResolvedValueOnce({
    success: false,
    code: 'CREDENTIAL_STORE_UNAVAILABLE',
  });
  await act(async () => {
    await hook.result.current.dispatch({ type: 'reset' });
  });
  expect(hook.result.current.errorCode).toBe('CREDENTIAL_STORE_UNAVAILABLE');
  expect(hook.result.current.retryAt).toBeUndefined();
  act(() => hook.result.current.clearError());
  expect(hook.result.current.errorCode).toBeNull();
});

it('preserves the deadline when loading the initial login state', async () => {
  auth.loadLoginState.mockImplementationOnce(async () => {
    auth.loginState = { step: 'identifier', retryAt: 1_800_000_000_000 };
    return {
      success: false,
      code: 'RATE_LIMITED',
      retryAt: 1_800_000_000_000,
    };
  });
  const hook = renderHook(() => useLogin());
  await waitFor(() => expect(hook.result.current.errorCode).toBe('RATE_LIMITED'));
  expect(hook.result.current.retryAt).toBe(1_800_000_000_000);
});
