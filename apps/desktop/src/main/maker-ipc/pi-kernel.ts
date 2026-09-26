import { ipcMain, type IpcMainInvokeEvent } from 'electron';
import type { PiKernelManager } from '../agent-binaries/pi-kernel-manager.js';
import { PiKernelError } from '../agent-binaries/pi-kernel-manager.js';
import { getPiKernelManager } from '../agent-binaries/index.js';
import { assertTrustedAppRendererEvent } from '../security/trustedAppRenderer.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';

export function createPiKernelIpc<Event>(deps: {
  assertSender: (event: Event) => void;
  manager: () => Pick<PiKernelManager, 'state' | 'check' | 'install'>;
}) {
  return {
    async state(event: Event, check: unknown = false) {
      deps.assertSender(event);
      if (typeof check !== 'boolean') throwIpcError('INVALID_PARAMS', 'check must be boolean');
      try { return await (check ? deps.manager().check() : deps.manager().state()); }
      catch { throwIpcError('INTERNAL', 'Pi kernel state unavailable'); }
    },
    async install(event: Event, input: unknown) {
      deps.assertSender(event);
      if (!input || typeof input !== 'object' || Array.isArray(input)) throwIpcError('INVALID_PARAMS', 'Invalid Pi install request');
      const body = input as Record<string, unknown>;
      if ((body.source !== 'official' && body.source !== 'upstream') || typeof body.version !== 'string'
        || !/^\d+\.\d+\.\d+$/.test(body.version) || Object.keys(body).some(key => !['source', 'version'].includes(key))) {
        throwIpcError('INVALID_PARAMS', 'Invalid Pi install target');
      }
      try {
        await deps.manager().install({ source: body.source, version: body.version });
        return await deps.manager().state();
      } catch (error) {
        const code = error instanceof PiKernelError && error.reason === 'version-changed' ? 'PRECONDITION_FAILED' : 'INTERNAL';
        throwIpcError(code, error instanceof PiKernelError ? error.reason : 'Pi kernel installation failed');
      }
    },
  };
}

export function registerPiKernelIpc(): void {
  const handlers = createPiKernelIpc<IpcMainInvokeEvent>({ assertSender: assertTrustedAppRendererEvent, manager: getPiKernelManager });
  // Local machine administration, deliberately not exposed through device-link.
  ipcMain.handle(MAKER_INVOKE.PI_KERNEL_STATE, (event, check) => handlers.state(event, check));
  ipcMain.handle(MAKER_INVOKE.PI_KERNEL_INSTALL, (event, body) => handlers.install(event, body));
}
