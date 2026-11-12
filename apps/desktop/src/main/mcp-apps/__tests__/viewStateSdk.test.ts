/// <reference path="../../../../resources/system-skills/cindy-plugin-creator/references/examples/interactive-pages/cindy-ext-apps.d.ts" />
import { afterEach, expect, it, vi } from 'vitest';
import { App } from '@modelcontextprotocol/ext-apps';
import { AppBridge } from '@modelcontextprotocol/ext-apps/app-bridge';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpError } from '@modelcontextprotocol/sdk/types.js';
import { z } from 'zod';
import { createViewState, flushViewState } from '@cindy/ext-apps';

// Unit: public helper + real SDK/initialize/RPC; Host tests do not cover the page's
// debounce/flush queue. Minimum input: two edits behind one unresolved save.
// Fake time and in-memory transport keep this layer independent of browser/DB I/O.
const cleanup: Array<() => unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.useRealTimers(); vi.restoreAllMocks();
});
function gate() {
  let resolve!: () => void, reject!: (reason: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}
async function fixture(saved: unknown = null, supported = true) {
  vi.useFakeTimers();
  const save = vi.fn(async (_state: unknown) => ({}));
  const bridge = new AppBridge(null, { name: 'fixture', version: '1' },
    supported ? { experimental: { 'cindy/view-state': { maxBytes: 65536 } } } : {},
    { hostContext: { 'cindy/view-state': saved } });
  bridge.setRequestHandler(z.object({ method: z.literal('cindy/view-state/set'), params: z.object({ state: z.unknown() }) }),
    request => save(request.params.state));
  const app = new App({ name: 'fixture', version: '1' }, {}, { autoResize: false });
  const [page, host] = InMemoryTransport.createLinkedPair();
  await bridge.connect(host); await app.connect(page);
  cleanup.push(() => app.close(), () => bridge.close());
  const state = createViewState(app, { version: 1, page: 1 });
  cleanup.push(() => state.dispose());
  return { app, save, state };
}
it('restores before rendering, writes only changes, and debounces the newest value', async () => {
  const f = await fixture({ version: 1, page: 3 });
  expect(f.state.get()).toEqual({ version: 1, page: 3 });
  await vi.advanceTimersByTimeAsync(500); expect(f.save).not.toHaveBeenCalled();
  f.state.set({ version: 1, page: 4 }); f.state.set(s => ({ ...s, page: 5 }));
  await vi.advanceTimersByTimeAsync(499); expect(f.save).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  expect(f.save.mock.calls).toEqual([[{ version: 1, page: 5 }]]);
  await flushViewState(f.app); expect(f.save).toHaveBeenCalledTimes(1);
});
it.each([null, [], { page: 7 }, { version: 2, page: 7 }])('uses the default without writing incompatible history: %j', async saved => {
  const f = await fixture(saved);
  expect(f.state.get()).toEqual({ version: 1, page: 1 });
  await vi.advanceTimersByTimeAsync(500); expect(f.save).not.toHaveBeenCalled();
  await f.state.flush(); expect(f.save).toHaveBeenCalledWith({ version: 1, page: 1 });
});
it('waits for the pending commit, coalesces its receipts and continues after an older failure', async () => {
  const f = await fixture(), a = gate(), b = gate();
  f.save.mockImplementationOnce(async () => { await a.promise; return {}; })
    .mockImplementationOnce(async () => { await b.promise; return {}; });
  f.state.set({ version: 1, page: 2 });
  const first = f.state.flush(); const failed = expect(first).rejects.toThrow('storage');
  await vi.advanceTimersByTimeAsync(0);
  f.state.set({ version: 1, page: 3 }); const second = f.state.flush();
  f.state.set({ version: 1, page: 4 }); const third = f.state.flush();
  expect(second).toBe(third);
  let settled = false; void second.then(() => { settled = true; });
  a.reject(new McpError(-32603, 'storage')); await failed;
  await vi.advanceTimersByTimeAsync(0);
  expect(settled).toBe(false); expect(f.save.mock.calls[1]).toEqual([{ version: 1, page: 4 }]);
  b.resolve(); await second; expect(settled).toBe(true);
});
it.each([-32602, -32603])('keeps the visible value and does not retry a failed snapshot (%s)', async code => {
  const f = await fixture(); const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.save.mockRejectedValueOnce(new McpError(code, 'private server message'));
  f.state.set({ version: 1, page: 2 }); await vi.advanceTimersByTimeAsync(500);
  expect(f.state.get()).toEqual({ version: 1, page: 2 });
  await expect(f.state.flush()).rejects.toMatchObject({ code });
  f.state.set({ version: 1, page: 2 }); await vi.advanceTimersByTimeAsync(5000);
  await expect(f.state.flush()).rejects.toMatchObject({ code });
  expect(f.save).toHaveBeenCalledTimes(1); expect(warn).toHaveBeenCalledTimes(1);
  expect(warn.mock.calls.flat().join(' ')).not.toMatch(/private|page/);
  f.state.set({ version: 1, page: 3 }); await f.state.flush(); expect(f.save).toHaveBeenCalledTimes(2);
});
it('keeps old-host interactions local and cannot claim a successful explicit save', async () => {
  const f = await fixture({ version: 1, page: 7 }, false);
  expect(f.state.get().page).toBe(1);
  f.state.set({ version: 1, page: 2 }); await vi.advanceTimersByTimeAsync(500);
  expect(f.state.get().page).toBe(2); expect(f.save).not.toHaveBeenCalled();
  await expect(f.state.flush()).rejects.toThrow('VIEW_STATE_UNSUPPORTED');
});
it('rejects non-JSON and oversized state without sending lossy data; dispose cancels the unsent edit', async () => {
  const f = await fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  for (const next of [{ version: 1, page: undefined }, { version: 1, draft: '汉'.repeat(22000) }, { version: 1, when: new Date() }]) {
    const untyped: (value: unknown) => void = f.state.set as (value: unknown) => void;
    untyped(next); await expect(f.state.flush()).rejects.toMatchObject({ code: -32602 });
  }
  expect(f.save).not.toHaveBeenCalled();
  f.state.set({ version: 1, page: 5 }); f.state.dispose();
  await vi.advanceTimersByTimeAsync(1000); expect(f.save).not.toHaveBeenCalled();
  await expect(f.state.flush()).rejects.toThrow('VIEW_STATE_DISPOSED');
});

it('cancels a queued flush when teardown happens before its request is sent', async () => {
  const f = await fixture(); vi.spyOn(console, 'warn').mockImplementation(() => {});
  f.state.set({ version: 1, page: 2 });
  const flushed = f.state.flush();
  f.state.dispose();
  await expect(flushed).rejects.toThrow('VIEW_STATE_DISPOSED');
  expect(f.save).not.toHaveBeenCalled();
});

// Review regression / unit: a second caller on one App must see the confirmed
// page-local draft, not the immutable initialization context, and share its writer.
it('shares the current value and writer when createViewState is called again on the same App', async () => {
  const f = await fixture({ version: 1, page: 3 });
  f.state.set({ version: 1, page: 4 }); await f.state.flush();
  const again = createViewState(f.app, { version: 1, page: 1 });
  cleanup.push(() => again.dispose());
  expect(again.get()).toEqual({ version: 1, page: 4 });
  await again.flush(); expect(f.save).toHaveBeenCalledTimes(1);
  again.set(s => ({ ...s, page: s.page + 1 }));
  expect(f.state.get()).toEqual({ version: 1, page: 5 });
  await flushViewState(f.app);
  expect(f.save.mock.calls).toEqual([[{ version: 1, page: 4 }], [{ version: 1, page: 5 }]]);
});

// Unit: the public shared store must notify local consumers even without host
// capability; unsubscription must not stop another consumer or the writer.
it.each([true, false])('publishes current local snapshots and removes only the cancelled subscription (supported %s)', async supported => {
  const f = await fixture(null, supported);
  const first: number[] = [], second: number[] = [];
  const stopFirst = f.state.subscribe(() => first.push(f.state.get().page));
  const stopSecond = f.state.subscribe(() => second.push(f.state.get().page));
  expect(first).toEqual([]); expect(second).toEqual([]);
  f.state.set({ version: 1, page: 2 });
  f.state.set({ version: 1, page: 2 }); // Equal values do not notify or write twice.
  stopFirst();
  f.state.set(s => ({ ...s, page: s.page + 1 }));
  expect(first).toEqual([2]); expect(second).toEqual([2, 3]);
  if (supported) {
    await f.state.flush(); expect(f.save.mock.calls).toEqual([[{ version: 1, page: 3 }]]);
  } else {
    await expect(f.state.flush()).rejects.toThrow('VIEW_STATE_UNSUPPORTED');
    expect(f.save).not.toHaveBeenCalled();
  }
  f.state.dispose();
  f.state.set({ version: 1, page: 4 });
  expect(second).toEqual([2, 3]); stopSecond();
});
