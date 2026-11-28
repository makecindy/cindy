// @vitest-environment jsdom
import { act } from 'react';
import { createRoot } from 'react-dom/client';
import { expect, it, vi } from 'vitest';
import { HomePullRefreshControl } from '@/session/HomePullRefreshControl';

vi.mock('react-native', () => ({
  RefreshControl: ({ refreshing, onRefresh }: { refreshing: boolean; onRefresh(): void }) =>
    <button aria-busy={refreshing} onClick={onRefresh}>Pull</button>,
}));

it('reserves native refresh space only for a pull and releases it when the current pull settles', async () => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  const host = document.createElement('div');
  const root = createRoot(host);
  const requests: Array<{ resolve(): void; reject(): void }> = [];
  const refresh = () => new Promise<void>((resolve, reject) => requests.push({ resolve, reject }));
  try {
    await act(async () => root.render(<HomePullRefreshControl onRefresh={refresh} />));
    const button = host.querySelector('button')!;
    const background = refresh();
    expect(button.getAttribute('aria-busy')).toBe('false');
    await act(async () => button.click());
    await act(async () => { requests[0]!.resolve(); await background; });
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => button.click());
    await act(async () => requests[1]!.resolve());
    expect(button.getAttribute('aria-busy')).toBe('true');
    await act(async () => requests[2]!.reject());
    expect(button.getAttribute('aria-busy')).toBe('false');
  } finally {
    await act(async () => root.unmount());
  }
});
