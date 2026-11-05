import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { PluginUiVisibilityValues } from '@cindy/maker-shared/plugin-ui';
import { PLUGIN_UI_VISIBILITY_GET, PLUGIN_UI_VISIBILITY_RELEASE, PLUGIN_UI_VISIBILITY_APPLY, PLUGIN_UI_VISIBILITY_APPLIED } from '../../shared/pluginUiVisibility.js';

interface WindowTarget {
  id: number;
  nativeButtons(visible: boolean): void;
  send(channel: string, payload: unknown): void;
}
export function createPluginUiVisibilityIpc(deps: {
  assertTrusted(event: IpcMainInvokeEvent): void;
  snapshot(windowId: number): PluginUiVisibilityValues;
  open(windowId: number): boolean;
  close(windowId: number): void;
  window(windowId: number): WindowTarget | null;
}) {
  const pending = new Map<string, { windowId: number; finish(status: 'applied' | 'unconfirmed'): void }>();
  return {
    register(ipc: IpcMain) {
      ipc.handle(PLUGIN_UI_VISIBILITY_GET, event => {
        deps.assertTrusted(event);
        if (!deps.open(event.sender.id)) throw new Error('VISIBILITY_UNAVAILABLE');
        return deps.snapshot(event.sender.id);
      });
      ipc.handle(PLUGIN_UI_VISIBILITY_RELEASE, event => {
        deps.assertTrusted(event);
        deps.close(event.sender.id);
      });
      ipc.handle(PLUGIN_UI_VISIBILITY_APPLIED, (event, raw: unknown) => {
        deps.assertTrusted(event);
        if (!raw || typeof raw !== 'object') return;
        const requestId = (raw as { requestId?: unknown }).requestId;
        if (typeof requestId !== 'string') return;
        const request = pending.get(requestId);
        if (request?.windowId === event.sender.id) request.finish('applied');
      });
    },
    async apply(windowId: number, values: PluginUiVisibilityValues): Promise<'applied' | 'unconfirmed'> {
      const win = deps.window(windowId);
      if (!win || pending.size >= 64) return 'unconfirmed';
      const requestId = randomUUID();
      return new Promise(resolve => {
        const finish = (status: 'applied' | 'unconfirmed') => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer); resolve(status);
        };
        const timer = setTimeout(() => finish('unconfirmed'), 3000);
        timer.unref?.();
        pending.set(requestId, { windowId, finish });
        try {
          win.nativeButtons(values.workspace && values.windowControls);
          win.send(PLUGIN_UI_VISIBILITY_APPLY, { requestId, values });
        } catch { finish('unconfirmed'); }
      });
    },
  };
}
