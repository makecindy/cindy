import type { WebContents } from 'electron';
import {
  isPluginModelPickerRect,
  type PluginModelPickerPresentation,
  type PluginModelPickerResult,
} from '../../shared/pluginModelPicker.js';
import type { GhostModelPicker } from './ghostModelPicker.js';

/** The attach gate supplies the physical installation and its owner/approval lease. */
export function installGhostPageModelPicker(deps: {
  guest: WebContents;
  host: WebContents;
  instanceId: string;
  isCurrent(): boolean;
  picker(): GhostModelPicker;
  push(channel: string, payload: unknown): void;
}): void {
  const { guest, host } = deps;
  guest.ipc.handle(
    'ghost-page:pick-model',
    async (event, raw: unknown): Promise<PluginModelPickerResult> => {
      const denied = (): PluginModelPickerResult => ({
        ok: false,
        errorCode: 'PERMISSION_DENIED',
        message: 'Plugin page is no longer available',
      });
      if (
        guest.isDestroyed() ||
        host.isDestroyed() ||
        event.sender !== guest ||
        event.senderFrame !== guest.mainFrame ||
        !deps.isCurrent()
      )
        return denied();
      if (!raw || typeof raw !== 'object' || Array.isArray(raw))
        return { ok: false, errorCode: 'INVALID_REQUEST', message: 'Invalid model picker options' };
      const options = raw as Record<string, unknown>;
      if (
        Object.keys(options).some((key) => !['anchor', 'initial', 'allowRemote'].includes(key)) ||
        !isPluginModelPickerRect(options.anchor)
      )
        return { ok: false, errorCode: 'INVALID_REQUEST', message: 'Invalid model picker anchor' };
      const anchor = { ...options.anchor };
      const frame = guest.mainFrame;
      const controller = new AbortController();
      let presented = false;
      const current = () =>
        !controller.signal.aborted &&
        !guest.isDestroyed() &&
        !host.isDestroyed() &&
        guest.mainFrame === frame &&
        deps.isCurrent();
      const cancel = () => controller.abort();
      const pageCancel = (source: Electron.IpcMainEvent) => {
        if (source.sender === guest && source.senderFrame === frame) cancel();
      };
      guest.ipc.on('ghost-page:cancel-model-picker', pageCancel);
      const navigation = (
        _event: unknown,
        _url: string,
        sameDocument: boolean,
        mainFrame: boolean,
      ) => {
        if (mainFrame && !sameDocument) cancel();
      };
      for (const contents of [guest, host]) {
        contents.once('destroyed', cancel);
        contents.once('render-process-gone', cancel);
        contents.on('did-start-navigation', navigation);
      }
      try {
        return await deps.picker().request(
          deps.instanceId,
          {
            ...(options.initial !== undefined ? { initial: options.initial } : {}),
            allowRemote: options.allowRemote ?? true,
          },
          current,
          controller.signal,
          {
            id: host.id,
            supportsRemoteRoutes: true,
            isCurrent: current,
            send: (request) => {
              if (!current()) return false;
              const presentation: PluginModelPickerPresentation = {
                ...request,
                pageAnchor: {
                  guestId: guest.id,
                  rect: anchor,
                  zoomFactor: guest.getZoomFactor() / host.getZoomFactor(),
                },
              };
              deps.push('ghosts:model-picker:request', presentation);
              presented = true;
              return true;
            },
            dismiss: (requestId) => {
              if (!host.isDestroyed()) deps.push('ghosts:model-picker:dismissed', { requestId });
            },
          },
        );
      } finally {
        guest.ipc.removeListener('ghost-page:cancel-model-picker', pageCancel);
        for (const contents of [guest, host]) {
          contents.removeListener('destroyed', cancel);
          contents.removeListener('render-process-gone', cancel);
          contents.removeListener('did-start-navigation', navigation);
        }
        if (presented && current()) guest.focus();
      }
    },
  );
}
