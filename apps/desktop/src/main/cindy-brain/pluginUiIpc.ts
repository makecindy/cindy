import type { IpcMainInvokeEvent } from 'electron';
import { parsePluginUiInvokeInput, pluginUiRecord, pluginUiText } from '@cindy/maker-shared';
import { parsePluginUiReadRequest } from '../../shared/pluginUi.js';
import { PluginUiError, type PluginUiService } from './pluginUiService.js';
import type { PluginUiPageHost } from './pluginUiPageHost.js';

export function createPluginUiIpcHandlers(deps: {
  service(): PluginUiService;
  pageHost(): PluginUiPageHost;
  assertTrusted(event: IpcMainInvokeEvent): void;
  devEnabled(): boolean;
  fail(code: 'PERMISSION_DENIED' | 'INVALID_PARAMS' | 'NOT_FOUND' | 'UNSUPPORTED_CAPABILITY' | 'INTERNAL', message: string): never;
}) {
  const current = (event: IpcMainInvokeEvent) => () => {
    try { deps.assertTrusted(event); return !event.sender.isDestroyed(); } catch { return false; }
  };
  const run = async <T>(operation: () => Promise<T>): Promise<T> => {
    try { return await operation(); }
    catch (error) {
      if (error instanceof PluginUiError) return deps.fail(error.code, error.message);
      return deps.fail('INTERNAL', 'Plugin UI unavailable');
    }
  };
  return {
    async read(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      const request = parsePluginUiReadRequest(raw);
      if (!request) return deps.fail('INVALID_PARAMS', 'Invalid UI read');
      return run(() => deps.service().read(`local:${event.sender.id}`, request, current(event)));
    },
    async invoke(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      const input = pluginUiRecord(raw) ? parsePluginUiInvokeInput(raw.input) : null;
      if (!pluginUiRecord(raw) || !pluginUiText(raw.sessionId) || !input) return deps.fail('INVALID_PARAMS', 'Invalid UI invoke');
      const sessionId = raw.sessionId;
      return run(() => deps.service().invoke(`local:${event.sender.id}`, sessionId, input, current(event)));
    },
    async choose(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      const request = pluginUiRecord(raw) ? parsePluginUiReadRequest(raw.request) : null;
      const value = pluginUiRecord(raw) ? raw.choice : undefined;
      const choice = value === null ? null : pluginUiRecord(value) && pluginUiText(value.instanceId) &&
        typeof value.contributionId === 'string' && /^[a-zA-Z0-9_-]{1,64}$/.test(value.contributionId)
        ? { instanceId: value.instanceId, contributionId: value.contributionId } : undefined;
      if (!request || choice === undefined) return deps.fail('INVALID_PARAMS', 'Invalid renderer choice');
      return run(() => deps.service().chooseRenderer(`local:${event.sender.id}`, request, choice, current(event)));
    },
    async openPage(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      if (!pluginUiRecord(raw) || !pluginUiText(raw.sessionId) || !pluginUiText(raw.viewId) || !pluginUiText(raw.revision))
        return deps.fail('INVALID_PARAMS', 'Invalid UI page');
      const { sessionId, viewId, revision } = raw;
      return run(() => deps.pageHost().open(`local:${event.sender.id}`, sessionId, viewId, revision, current(event)));
    },
    async closePage(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      if (!pluginUiRecord(raw) || !pluginUiText(raw.pageId)) return deps.fail('INVALID_PARAMS', 'Invalid UI page');
      return run(() => deps.pageHost().close(`local:${event.sender.id}`, raw.pageId as string));
    },
    release(event: IpcMainInvokeEvent, raw: unknown) {
      deps.assertTrusted(event);
      if (!pluginUiRecord(raw) || !pluginUiText(raw.subscriptionId)) return deps.fail('INVALID_PARAMS', 'Invalid UI release');
      deps.service().release(`local:${event.sender.id}`, raw.subscriptionId);
    },
    inspect(event: IpcMainInvokeEvent) {
      deps.assertTrusted(event);
      if (!deps.devEnabled()) return deps.fail('PERMISSION_DENIED', 'UI inspection is development-only');
      return deps.service().inspect();
    },
  };
}
