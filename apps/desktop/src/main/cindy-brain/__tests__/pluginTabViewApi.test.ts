import { expect, it, vi } from 'vitest';
import type { CindyPluginTabView } from '@cindy/maker-shared/plugin-ui';
import { PLUGIN_TAB_VIEW_READ, PLUGIN_TAB_VIEW_CHANGED, PLUGIN_TAB_VIEW_RECEIVED } from '../../../shared/pluginUi';
const host = vi.hoisted(() => ({ bridge: {} as Record<string, unknown>, invoke: vi.fn(),
  listeners: new Map<string, (event: unknown, value: unknown) => void>() }));
vi.mock('electron', () => ({ contextBridge: { exposeInMainWorld: (name: string, value: unknown) => { host.bridge[name] = value; } },
  ipcRenderer: { on: (channel: string, listener: (event: unknown, value: unknown) => void) => host.listeners.set(channel, listener), invoke: host.invoke } }));

// 4.3 unit: actual preload entry in view mode. A late initial read must not
// overwrite a newer navigation push or expose the logic page's privileged pipe.
it('exposes only the view bridge and returns the newest snapshot when read races a change', async () => {
  const previousArgv = process.argv;
  process.argv = [...previousArgv, '--cindy-plugin-tab-view'];
  try { await import('../../../preload/ghostPreload.js'); } finally { process.argv = previousArgv; }
  const cindy = host.bridge.cindy as { ui: { view: CindyPluginTabView } };
  expect(Object.keys(cindy)).toEqual(['ui']); expect(Object.keys(cindy.ui)).toEqual(['view']);
  let answer!: (value: unknown) => void;
  host.invoke.mockImplementation((channel: string) => channel === PLUGIN_TAB_VIEW_READ ? new Promise(resolve => { answer = resolve; }) : Promise.resolve());
  const changed = vi.fn(), off = cindy.ui.view.onChanged(changed);
  const pending = cindy.ui.view.read();
  const snapshot = { id: 'log', scope: { kind: 'global' as const }, params: { item: 'new' }, generation: 'mount', visible: true };
  host.listeners.get(PLUGIN_TAB_VIEW_CHANGED)!(undefined, { snapshot, sequence: 2 });
  answer({ snapshot: { ...snapshot, params: { item: 'old' } }, sequence: 1 });
  expect(await pending).toEqual(snapshot);
  expect(host.invoke).toHaveBeenCalledWith(PLUGIN_TAB_VIEW_RECEIVED, { generation: 'mount', sequence: 2 });
  off(); host.listeners.get(PLUGIN_TAB_VIEW_CHANGED)!(undefined, { snapshot, sequence: 3 });
  expect(changed).toHaveBeenCalledOnce();
});
