import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { pluginUiRecord, pluginUiText } from '@cindy/maker-shared/plugin-ui-host';
import { PLUGIN_TAB_VIEW_HOST, PLUGIN_TAB_VIEW_NAVIGATE, PLUGIN_TAB_VIEW_OPENED, PLUGIN_TAB_VIEW_MOUNT,
  PLUGIN_TAB_VIEW_UPDATE, PLUGIN_TAB_VIEW_RELEASE, PLUGIN_TAB_VIEW_READ, PLUGIN_TAB_VIEW_RECEIVED } from '../../shared/pluginUi.js';
import type { PluginTabViewHost } from './pluginTabViewHost.js';

export function registerPluginTabViewIpc(ipc: Pick<IpcMain, 'handle'>, host: () => PluginTabViewHost,
  assertTrusted: (event: IpcMainInvokeEvent) => void): void {
  const renderer = (run: (controller: number, raw: unknown) => unknown) => (event: IpcMainInvokeEvent, raw: unknown) => {
    assertTrusted(event); return run(event.sender.id, raw);
  };
  ipc.handle(PLUGIN_TAB_VIEW_HOST, renderer(id => host().ready(id)));
  ipc.handle(PLUGIN_TAB_VIEW_NAVIGATE, renderer((id, raw) => {
    if (!pluginUiRecord(raw) || !pluginUiText(raw.requestId)) throw new Error('VIEW_UNAVAILABLE');
    return host().navigate(`local:${id}`, raw.requestId);
  }));
  ipc.handle(PLUGIN_TAB_VIEW_OPENED, renderer((id, raw) => host().opened(id, raw)));
  ipc.handle(PLUGIN_TAB_VIEW_MOUNT, renderer((id, raw) => host().mount(id, raw)));
  ipc.handle(PLUGIN_TAB_VIEW_UPDATE, renderer((id, raw) => host().update(id, raw)));
  ipc.handle(PLUGIN_TAB_VIEW_RELEASE, renderer((id, raw) => {
    if (!pluginUiRecord(raw) || !pluginUiText(raw.token)) throw new Error('VIEW_UNAVAILABLE');
    host().release(id, raw.token, raw.moving === true);
  }));
  const guest = (run: (id: number, raw: unknown) => unknown) => (event: IpcMainInvokeEvent, raw: unknown) => {
    if (!event.senderFrame || event.senderFrame !== event.sender.mainFrame || event.senderFrame.parent !== null) throw new Error('VIEW_UNAVAILABLE');
    return run(event.sender.id, raw);
  };
  ipc.handle(PLUGIN_TAB_VIEW_READ, guest(id => host().read(id)));
  ipc.handle(PLUGIN_TAB_VIEW_RECEIVED, guest((id, raw) => host().received(id, raw)));
}
