/// <reference path="../../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
// @vitest-environment jsdom
import * as React from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { flushViewState } from '@cindy/ext-apps';
import { createViewStateHooks } from '@cindy/ext-apps/react';
const { useViewState } = createViewStateHooks(React);
const initial = { version: 1, page: 1 };
function app() {
  return { transport: {}, getHostCapabilities: () => ({ experimental: { 'cindy/view-state': {} } }),
    getHostContext: () => ({ 'cindy/view-state': { version: 1, page: 7 } }), request: vi.fn(async (_request: unknown, _schema: unknown) => ({})) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
// React unit tier: actual hook renders and StrictMode lifecycle; core RPC tests cannot
// catch first-paint defaults, overwritten pre-connect edits or duplicate effect writes.
it('first renders restored state under StrictMode without saving it', async () => {
  vi.useFakeTimers(); const host = app(); const renders: number[] = [];
  const hook = renderHook(() => { const result = useViewState(host, initial); renders.push(result[0].page); return result; },
    { wrapper: ({ children }) => React.createElement(React.StrictMode, null, children) });
  expect(renders.every(page => page === 7)).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(500)); expect(host.request).not.toHaveBeenCalled();
  act(() => hook.result.current[1](s => ({ ...s, page: 8 })));
  await act(() => flushViewState(host)); expect(host.request).toHaveBeenCalledTimes(1);
  expect(hook.result.current[0].page).toBe(8);
});
it.each([false, true])('restores on connection unless the user has edited first (%s)', async edited => {
  vi.useFakeTimers(); const host = app(); const renders: Array<[boolean, number]> = [];
  const hook = renderHook(({ connected }) => {
    const result = useViewState(connected ? host : null, initial);
    renders.push([connected, result[0].page]); return result;
  }, { initialProps: { connected: false } });
  if (edited) act(() => hook.result.current[1]({ version: 1, page: 2 }));
  hook.rerender({ connected: true });
  expect(renders.filter(([connected]) => connected).every(([, page]) => page === (edited ? 2 : 7))).toBe(true);
  await act(() => vi.advanceTimersByTimeAsync(500)); expect(host.request).toHaveBeenCalledTimes(edited ? 1 : 0);
});

// Review regression: a setter and flush in one React event must submit the new
// value before effects run. Existing act-separated coverage flushed after effects.
it('flushes synchronous and functional edits in the same batched event without flushSync', async () => {
  vi.useFakeTimers(); const host = app();
  const hook = renderHook(() => useViewState(host, initial),
    { wrapper: ({ children }) => React.createElement(React.StrictMode, null, children) });
  await act(() => flushViewState(host)); // The old snapshot is already confirmed.
  host.request.mockClear();
  const updater = vi.fn((s: typeof initial) => ({ ...s, page: s.page + 1 }));
  await act(async () => {
    hook.result.current[1]({ version: 1, page: 8 });
    hook.result.current[1](updater);
    hook.result.current[1](updater);
    await flushViewState(host);
    expect(host.request).toHaveBeenCalledTimes(1);
    expect(host.request.mock.calls[0][0]).toMatchObject({ method: 'cindy/view-state/set', params: { state: { version: 1, page: 10 } } });
  });
  expect(updater).toHaveBeenCalledTimes(2);
  expect(hook.result.current[0].page).toBe(10);
  await act(() => vi.advanceTimersByTimeAsync(1000));
  expect(host.request).toHaveBeenCalledTimes(1);
});

// Same connected App retains its page-local draft across a component lifetime;
// saved-state and in-flight-state variants protect remount and delayed cleanup.
it.each(['saved', 'in-flight'] as const)('remounts the latest %s draft without cancelling or duplicating saves', async mode => {
  vi.useFakeTimers(); const host = app();
  const first = renderHook(() => useViewState(host, initial));
  act(() => first.result.current[1]({ version: 1, page: 8 }));
  let finish!: () => void;
  if (mode === 'in-flight') host.request.mockImplementationOnce(async () => {
    await new Promise<void>(resolve => { finish = resolve; }); return {};
  });
  const flushed = flushViewState(host);
  await act(() => vi.advanceTimersByTimeAsync(0));
  if (mode === 'saved') await flushed;
  first.unmount();
  await act(() => vi.advanceTimersByTimeAsync(0)); // Old cleanup must not drop the App cache.
  const second = renderHook(() => useViewState(host, initial));
  expect(second.result.current[0]).toEqual({ version: 1, page: 8 });
  if (mode === 'in-flight') {
    finish(); await act(() => flushed);
    await act(() => vi.advanceTimersByTimeAsync(0)); // Late completion cannot dispose the remount.
  }
  await act(() => vi.advanceTimersByTimeAsync(500));
  expect(host.request).toHaveBeenCalledTimes(1);
  await act(async () => {
    second.result.current[1](s => ({ ...s, page: s.page + 1 }));
    await flushViewState(host);
  });
  expect(host.request.mock.calls.at(-1)?.[0]).toMatchObject({ params: { state: { version: 1, page: 9 } } });
  expect(host.request).toHaveBeenCalledTimes(2);
});
