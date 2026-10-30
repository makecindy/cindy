// @vitest-environment jsdom
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { useMyIssues } from '../hooks/useMyIssues';

afterEach(cleanup);

it('rechecks after connection when an older issues request is still running', async () => {
  const response = {
    success: true,
    items: [],
    githubEnhancement: null,
    githubEnhancementFailed: false,
    degraded: null,
    truncated: false,
  };
  let finish!: (value: unknown) => void;
  const list = vi
    .fn()
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    )
    .mockResolvedValue({ ...response, githubEnhancement: { source: 'gh-cli', login: 'test' } });
  let connected!: () => void;
  const unsubscribe = vi.fn();
  window.electronAPI = {
    gitContext: {
      onGithubConnected: (listener: () => void) => {
        connected = listener;
        return unsubscribe;
      },
    },
    maker: { listMyIssues: list, getMyIssuesSnapshot: async () => null },
  } as any;
  const { result, unmount } = renderHook(() => useMyIssues());
  await waitFor(() => expect(list).toHaveBeenCalledOnce());
  act(() => connected());
  await act(async () => finish(response));
  await waitFor(() => expect(result.current.data?.githubEnhancement?.login).toBe('test'));
  expect(list).toHaveBeenCalledTimes(2);
  expect(list).toHaveBeenLastCalledWith({ force: true });
  unmount();
  expect(unsubscribe).toHaveBeenCalledOnce();
});
