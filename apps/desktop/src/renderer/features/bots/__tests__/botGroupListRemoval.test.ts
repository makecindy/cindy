// @vitest-environment jsdom
import { afterEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ seed: vi.fn(), generation: 1 }));
vi.mock('../botReadState', () => ({ seedBotGroupReadState: h.seed }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => h.generation, isDataOwnerGenerationCurrent: (owner: number) => owner === h.generation,
  isDataOwnerPushCurrent: () => true,
}));
let stop = () => {};
afterEach(() => { stop(); vi.resetModules(); vi.clearAllMocks(); });
it('removes an acknowledged personal entry immediately and filters an older in-flight list response', async () => {
  let changed!: (payload: unknown) => void;
  let finish!: (value: unknown) => void;
  const group = { id: 'room' };
  const list = vi.fn().mockResolvedValueOnce({ ok: true, groups: [group] }).mockImplementation(() => new Promise(resolve => { finish = resolve; }));
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: { listBotGroups: list,
    onBotGroupChanged: (fn: typeof changed) => { changed = fn; return () => {}; } } } });
  const store = await import('../botGroupStore');
  stop = store.startBotGroupSync(); await Promise.resolve(); await Promise.resolve();
  expect(store.getBotGroupListSnapshot().groups).toEqual([group]);
  store.refreshBotGroups();
  changed({ groupId: 'room', change: 'list', listState: { hidden: true, revision: 2 } });
  expect(store.getBotGroupListSnapshot().groups).toEqual([]);
  finish({ ok: true, groups: [group] }); await Promise.resolve(); await Promise.resolve();
  expect(store.getBotGroupListSnapshot().groups).toEqual([]);
  changed({ groupId: 'room', change: 'list', listState: { hidden: false, revision: 1 } });
  expect(store.getBotGroupListSnapshot().groups).toEqual([]);
  expect(h.seed).toHaveBeenLastCalledWith([]);
});
