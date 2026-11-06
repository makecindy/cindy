import { randomUUID } from 'node:crypto';
import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { AppearanceSettings } from '../../shared/appearanceSettings.js';
import { PLUGIN_APPEARANCE_FONT, PLUGIN_APPEARANCE_APPLY, PLUGIN_APPEARANCE_APPLIED } from '../../shared/pluginAppearance.js';
import type { PluginAppearanceResult } from '@cindy/maker-shared/plugin-ui';
import type { PluginAppearanceService } from './pluginAppearanceService.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Only transient application receipts; the original appearance store owns values. */
export function createPluginAppearanceIpc(deps: {
  assertTrusted(event: IpcMainInvokeEvent): void;
  service(): PluginAppearanceService;
  viewingWindow(): { id: number; send(channel: string, payload: unknown): void } | null;
}) {
  const pending = new Map<string, { windowId: number; finish(value: PluginAppearanceResult['application']): void }>();
  return {
    register(ipc: IpcMain) {
      ipc.handle(PLUGIN_APPEARANCE_FONT, async (event, role: unknown) => {
        deps.assertTrusted(event);
        if (typeof role !== 'string' || !['uiFont', 'codeFont', 'bodyFont'].includes(role)) throwIpcError('INVALID_PARAMS', 'Invalid font role');
        try { return await deps.service().font(role); }
        catch { throwIpcError('NOT_FOUND', 'Plugin font unavailable'); }
      });
      ipc.handle(PLUGIN_APPEARANCE_APPLIED, (event, raw: unknown) => {
        deps.assertTrusted(event);
        if (!raw || typeof raw !== 'object') return;
        const value = raw as { requestId?: unknown; status?: unknown };
        if (typeof value.requestId !== 'string') return;
        const request = pending.get(value.requestId);
        if (!request || request.windowId !== event.sender.id) return;
        if (value.status === 'applied' || value.status === 'saved' || value.status === 'failed')
          request.finish({ status: value.status, ...(value.status === 'applied' ? {} : { reason: value.status === 'saved' ? 'APPLICATION_PENDING' : 'APPLICATION_FAILED' }) });
      });
    },
    async apply(settings: AppearanceSettings): Promise<PluginAppearanceResult['application']> {
      const win = deps.viewingWindow();
      if (!win || pending.size >= 64) return { status: 'saved', reason: 'NO_VIEWING_WINDOW' };
      const requestId = randomUUID();
      return new Promise(resolve => {
        const finish = (result: PluginAppearanceResult['application']) => {
          if (!pending.delete(requestId)) return;
          clearTimeout(timer); resolve(result);
        };
        const timer = setTimeout(() => finish({ status: 'saved', reason: 'APPLICATION_UNCONFIRMED' }), 3000);
        timer.unref?.();
        pending.set(requestId, { windowId: win.id, finish });
        try { win.send(PLUGIN_APPEARANCE_APPLY, { requestId, settings }); }
        catch { finish({ status: 'saved', reason: 'VIEWING_WINDOW_CLOSED' }); }
      });
    },
  };
}
