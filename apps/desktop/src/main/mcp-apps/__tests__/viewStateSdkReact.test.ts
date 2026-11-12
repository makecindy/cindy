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
    getHostContext: () => ({ 'cindy/view-state': { version: 1, page: 7 } }), request: vi.fn(async () => ({})) };
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
