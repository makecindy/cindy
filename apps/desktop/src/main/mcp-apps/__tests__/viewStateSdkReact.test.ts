/// <reference path="../../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
// @vitest-environment jsdom
import * as React from 'react';
import { createRoot } from 'react-dom/client';
import { act, cleanup, render, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { createViewState, flushViewState } from '@cindy/ext-apps';
import { createViewStateHooks } from '@cindy/ext-apps/react';
const { useViewState } = createViewStateHooks(React);
const initial = { version: 1, page: 1 };
function app() {
  return { transport: {}, getHostCapabilities: () => ({ experimental: { 'cindy/view-state': {} } }),
    getHostContext: () => ({ 'cindy/view-state': { version: 1, page: 7 } }), request: vi.fn(async (_request: unknown, _schema: unknown) => ({})) };
}
afterEach(() => { cleanup(); vi.useRealTimers(); });
// Review regression / React DOM unit: a suspended transition has rendered B but
// still shows A. Sequential rerenders cannot detect writes redirected by that
// uncommitted render. A=7, B=70; edit the visible button before resolving B.
it.each(['resume', 'discard'] as const)('keeps committed editors isolated while a transition suspends (%s)', async outcome => {
  vi.useFakeTimers();
  const a = app(), b = app();
  b.getHostContext = () => ({ 'cindy/view-state': { version: 1, page: 70 } });
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  let blocked = true, attempted = false;
  let select!: React.Dispatch<React.SetStateAction<ReturnType<typeof app>>>;
  let saved: Promise<void> | undefined;
  function Editor({ host }: { host: ReturnType<typeof app> }) {
    const [value, set] = useViewState(host, initial);
    if (host === b && blocked) { attempted = true; throw gate; }
    return React.createElement('button', { onClick: () => {
      set(s => ({ ...s, page: s.page + 1 }));
      saved = flushViewState(host);
    } }, `${host === a ? 'A' : 'B'}:${value.page}`);
  }
  function Page() {
    const [host, setHost] = React.useState(a);
    select = setHost;
    return React.createElement(React.Suspense, { fallback: 'loading' }, React.createElement(Editor, { host }));
  }
  const container = document.createElement('div');
  document.body.append(container);
  const root = createRoot(container);
  try {
    await act(async () => { root.render(React.createElement(Page)); });
    expect(container.textContent).toBe('A:7');
    await act(async () => { React.startTransition(() => select(b)); });
    expect(attempted).toBe(true);
    expect(container.textContent).toBe('A:7');
    await act(async () => { container.querySelector('button')!.click(); await saved; });
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(a.request).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ params: { state: { version: 1, page: 8 } } }), expect.anything());
    expect(b.request).not.toHaveBeenCalled();
    expect(container.textContent).toBe('A:8');
    if (outcome === 'discard') await act(async () => { select(a); });
    await act(async () => { blocked = false; release(); await gate; });
    expect(container.textContent).toBe(outcome === 'resume' ? 'B:70' : 'A:8');
    await act(() => vi.advanceTimersByTimeAsync(500));
    expect(b.request).not.toHaveBeenCalled();
    await act(async () => { container.querySelector('button')!.click(); await saved; });
    if (outcome === 'resume') {
      expect(container.textContent).toBe('B:71');
      expect(b.request).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({ params: { state: { version: 1, page: 71 } } }), expect.anything());
      expect(a.request).toHaveBeenCalledTimes(1);
    } else {
      expect(container.textContent).toBe('A:9');
      expect(a.request).toHaveBeenCalledTimes(2);
      expect(b.request).not.toHaveBeenCalled();
    }
  } finally {
    await act(async () => { root.unmount(); });
    container.remove();
    createViewState(a, initial).dispose(); createViewState(b, initial).dispose();
  }
});
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
it.each([[false, false], [true, false], [false, true], [true, true]])('restores on connection unless edited=%s (legacy=%s)', async (edited, legacy) => {
  const { useViewState } = createViewStateHooks(legacy ? { ...React, useSyncExternalStore: undefined } : React);
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

// Tester regression / React unit: two live consumers must derive functional edits
// from the same snapshot and repaint together. Single-hook/remount tests missed it.
// Minimum input: A edits draft, B increments page; neither field may disappear.
it.each(['native', 'legacy', 'unsupported'] as const)('shares live edits and subscriptions across hooks and JS (%s)', async mode => {
  vi.useFakeTimers();
  const host = app();
  host.getHostContext = () => ({ 'cindy/view-state': { version: 1, page: 7, draft: '' } });
  if (mode === 'unsupported') host.getHostCapabilities = () => ({ experimental: {} }) as ReturnType<typeof host.getHostCapabilities>;
  const hooks = createViewStateHooks(mode === 'legacy' ? { ...React, useSyncExternalStore: undefined } : React);
  const defaults = { version: 1, page: 1, draft: '' };
  type Setter = (next: typeof defaults | ((previous: typeof defaults) => typeof defaults)) => void;
  const setters: Record<string, Setter> = {};
  function Editor({ name }: { name: string }) {
    const [value, set] = hooks.useViewState(host, defaults);
    setters[name] = set;
    return React.createElement('output', { 'data-testid': name }, JSON.stringify(value));
  }
  const editors = (first: boolean) => React.createElement(React.StrictMode, null,
    first ? React.createElement(Editor, { name: 'A', key: 'A' }) : null,
    React.createElement(Editor, { name: 'B', key: 'B' }));
  const view = render(editors(true));
  const state = createViewState(host, defaults);
  const confirm = () => mode === 'unsupported'
    ? expect(flushViewState(host)).rejects.toThrow('VIEW_STATE_UNSUPPORTED') : flushViewState(host);
  const page = mode === 'unsupported' ? 1 : 7;
  const shown = (name: string) => JSON.parse(view.getByTestId(name).textContent!);
  try {
    await act(async () => { setters.A(s => ({ ...s, draft: 'user draft' })); await confirm(); });
    expect(shown('B')).toEqual({ version: 1, page, draft: 'user draft' });
    await act(async () => { setters.B(s => ({ ...s, page: s.page + 1 })); await confirm(); });
    expect(state.get()).toEqual({ version: 1, page: page + 1, draft: 'user draft' });
    expect(shown('A')).toEqual(state.get()); expect(shown('B')).toEqual(state.get());
    if (mode !== 'unsupported') expect(host.request.mock.calls.at(-1)?.[0]).toMatchObject({ params: { state: state.get() } });
    await act(async () => { state.set(s => ({ ...s, draft: 'JS edit' })); await confirm(); });
    expect(shown('A')).toEqual(state.get()); expect(shown('B')).toEqual(state.get());
    view.rerender(editors(false));
    await act(() => vi.advanceTimersByTimeAsync(0));
    await act(async () => { setters.B(s => ({ ...s, page: s.page + 1 })); await confirm(); });
    expect(shown('B')).toEqual({ version: 1, page: page + 2, draft: 'JS edit' });
    expect(host.request).toHaveBeenCalledTimes(mode === 'unsupported' ? 0 : 4);
  } finally { view.unmount(); state.dispose(); }
});

// Tester regression / React DOM unit: changing a mounted hook's App identity
// must not transplant the old connected draft. Prior tests only covered null->App
// and different Apps mounted side by side. Inputs: A=7, edited=8, B=70.
it.each([false, true].flatMap(legacy =>
  (['saved', 'pending', 'via-null', 'noop-null', 'edited-null'] as const).map(route => ({ legacy, route })),
))('isolates App transitions ($route, legacy=$legacy)', async ({ legacy, route }) => {
  vi.useFakeTimers();
  const a = app(), b = app();
  b.getHostContext = () => ({ 'cindy/view-state': { version: 1, page: 70 } });
  const hooks = createViewStateHooks(legacy ? { ...React, useSyncExternalStore: undefined } : React);
  let set!: (next: typeof initial | ((previous: typeof initial) => typeof initial)) => void;
  function Editor({ host }: { host: ReturnType<typeof app> | null }) {
    const [value, update] = hooks.useViewState(host, initial);
    set = update;
    return React.createElement('output', { 'data-testid': 'page' }, value.page);
  }
  const view = render(React.createElement(Editor, { host: a }));
  const shown = () => view.getByTestId('page').textContent;
  const aState = createViewState(a, initial);
  const bState = createViewState(b, initial);
  try {
    expect(shown()).toBe('7');
    act(() => set(s => ({ ...s, page: 8 })));
    if (route === 'saved') await act(() => flushViewState(a));
    else expect(a.request).not.toHaveBeenCalled(); // Leave A's debounce unexpired.
    if (route === 'via-null' || route === 'noop-null' || route === 'edited-null') {
      view.rerender(React.createElement(Editor, { host: null }));
      expect(shown()).toBe('1'); // A's connected value is not an unconnected draft.
      if (route === 'edited-null') act(() => set(s => ({ ...s, page: 9 })));
      if (route === 'noop-null') act(() => set(s => s));
    }
    view.rerender(React.createElement(Editor, { host: b }));
    const expected = route === 'edited-null' ? 9 : 70;
    expect(shown()).toBe(String(expected));
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(a.request).toHaveBeenCalledTimes(1); // Cleanup flushes A before its debounce expires.
    await act(() => vi.advanceTimersByTimeAsync(1000));
    expect(a.request).toHaveBeenCalledTimes(1);
    expect(a.request.mock.calls[0][0]).toMatchObject({ params: { state: { version: 1, page: 8 } } });
    expect(aState.get().page).toBe(8);
    expect(bState.get().page).toBe(expected);
    expect(b.request).toHaveBeenCalledTimes(route === 'edited-null' ? 1 : 0);
    if (route === 'edited-null') expect(b.request.mock.calls[0][0]).toMatchObject({ params: { state: { version: 1, page: 9 } } });
    // Discarding B's component also must not flush its untouched restored value:
    // the old edited flag belongs to A, except for a real null-stage edit handed to B.
    view.unmount();
    await act(() => vi.advanceTimersByTimeAsync(0));
    expect(b.request).toHaveBeenCalledTimes(route === 'edited-null' ? 1 : 0);
  } finally { view.unmount(); aState.dispose(); bState.dispose(); }
});
