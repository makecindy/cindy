// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  MAX_HIDDEN_HISTORY_CHASE_PAGES,
  initialHiddenHistoryChase,
  planHiddenHistoryChase,
  useHiddenHistoryChase,
  type HiddenHistoryChaseInput,
} from '@/session/hiddenHistoryChase';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
const base: HiddenHistoryChaseInput = { scope: 'a:mac:s1', enabled: true, visibleCount: 0, canLoadEarlier: true, loading: false, cursor: 'c20' };

it('pages back while the loaded window shows nothing, and stops once a row shows or history ends', () => {
  let plan = planHiddenHistoryChase(initialHiddenHistoryChase(base.scope), base);
  expect(plan.load).toBe(true);
  // Waiting for the page: nothing new.
  plan = planHiddenHistoryChase(plan.state, { ...base, loading: true });
  expect(plan.load).toBe(false);
  // The page moved the cursor but still only hidden prompts: read the next one.
  plan = planHiddenHistoryChase(plan.state, { ...base, cursor: 'c40' });
  expect(plan.load).toBe(true);
  expect(planHiddenHistoryChase(plan.state, { ...base, cursor: 'c60', visibleCount: 1 }).load).toBe(false);
  expect(planHiddenHistoryChase(plan.state, { ...base, cursor: 'c60', canLoadEarlier: false }).load).toBe(false);
});

it('stops when a page makes no progress or the cap is reached, and restarts for another chat', () => {
  let plan = planHiddenHistoryChase(initialHiddenHistoryChase(base.scope), base);
  // A failed page leaves the cursor where it was: give up instead of retrying forever.
  plan = planHiddenHistoryChase(plan.state, base);
  expect(plan).toMatchObject({ load: false, state: { exhausted: true } });
  expect(planHiddenHistoryChase(plan.state, { ...base, cursor: 'c40' }).load).toBe(false);
  expect(planHiddenHistoryChase(plan.state, { ...base, scope: 'a:mac:s2' }).load).toBe(true);

  let state = initialHiddenHistoryChase(base.scope);
  let loads = 0;
  for (let page = 0; page < MAX_HIDDEN_HISTORY_CHASE_PAGES + 5; page += 1) {
    const next = planHiddenHistoryChase(state, { ...base, cursor: `c${page}` });
    state = next.state;
    if (next.load) loads += 1;
  }
  expect(loads).toBe(MAX_HIDDEN_HISTORY_CHASE_PAGES);
  expect(state.exhausted).toBe(true);
});

it('does nothing offline, in the background, or while the window already shows rows', () => {
  const idle = initialHiddenHistoryChase(base.scope);
  expect(planHiddenHistoryChase(idle, { ...base, enabled: false }).load).toBe(false);
  expect(planHiddenHistoryChase(idle, { ...base, visibleCount: 3 }).load).toBe(false);
  expect(planHiddenHistoryChase(idle, { ...base, canLoadEarlier: false }).load).toBe(false);
});

let root: Root;
let host: HTMLDivElement;
let chasing: boolean | null = null;
function Probe({ input, onLoad }: { input: HiddenHistoryChaseInput; onLoad(): void }) {
  chasing = useHiddenHistoryChase(input, onLoad);
  return null;
}
beforeEach(() => { host = document.createElement('div'); root = createRoot(host); chasing = null; });
afterEach(() => act(() => root.unmount()));

it('reports chasing for the syncing placeholder, then lets the empty state show once it gives up', async () => {
  const onLoad = vi.fn();
  await act(async () => root.render(<Probe input={base} onLoad={onLoad} />));
  expect(onLoad).toHaveBeenCalledTimes(1);
  expect(chasing).toBe(true);
  await act(async () => root.render(<Probe input={{ ...base, loading: true }} onLoad={onLoad} />));
  // The page came back without moving the cursor.
  await act(async () => root.render(<Probe input={base} onLoad={onLoad} />));
  expect(onLoad).toHaveBeenCalledTimes(1);
  expect(chasing).toBe(false);
  // A visible row ends the chase for good.
  await act(async () => root.render(<Probe input={{ ...base, scope: 'a:mac:s2', visibleCount: 2 }} onLoad={onLoad} />));
  expect(onLoad).toHaveBeenCalledTimes(1);
  expect(chasing).toBe(false);
});
