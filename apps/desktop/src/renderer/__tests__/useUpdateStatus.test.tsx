// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { useUpdateStatus } from '../hooks/useUpdateStatus';

let listener: (payload: UpdateStatusPayload) => void;
let resolve: (payload: UpdateStatusPayload) => void;
const unsubscribe = vi.fn();
beforeEach(() => {
  unsubscribe.mockClear();
  window.electronAPI = {
    getUpdateStatus: () => new Promise(r => { resolve = r; }),
    onUpdateStatus: (callback: typeof listener) => { listener = callback; return unsubscribe; },
  } as unknown as Window['electronAPI'];
});
afterEach(cleanup);

it('hydrates the sidebar from the current download snapshot', async () => {
  const { result } = renderHook(useUpdateStatus);
  await act(async () => resolve({ status: 'downloading', version: '2.0', progress: 25 }));
  expect(result.current).toMatchObject({ status: 'downloading', version: '2.0', progress: 25 });
});
it('does not let a late idle snapshot hide a running download', async () => {
  const { result } = renderHook(useUpdateStatus);
  act(() => listener({ status: 'downloading', version: '2.0', progress: 45 }));
  await act(async () => resolve({ status: 'idle' }));
  expect(result.current).toMatchObject({ status: 'downloading', progress: 45 });
  act(() => listener({ status: 'ready', version: '2.0' }));
  expect(result.current.progress).toBeUndefined();
  expect(result.current.status).toBe('ready');
});
it('clears obsolete version and progress when a new check begins', () => {
  const { result } = renderHook(useUpdateStatus);
  act(() => listener({ status: 'downloading', version: '2.0', progress: 75 }));
  act(() => listener({ status: 'checking' }));
  expect(result.current).toMatchObject({ status: 'checking', version: undefined, progress: undefined });
});
it('unsubscribes on unmount and ignores the late snapshot', async () => {
  const { unmount } = renderHook(useUpdateStatus);
  unmount();
  await act(async () => resolve({ status: 'ready', version: '2.0' }));
  await waitFor(() => expect(unsubscribe).toHaveBeenCalledTimes(1));
});
