import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import { isGhostInstanceId } from '../../shared/pluginIdentity.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import type { PluginUsageIdentity } from '../../shared/pluginUsage.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import type { PluginUsageService } from './service.js';
import { withGhostInstallLock } from '../cindy-brain/ghostInstallLock.js';

export function registerPluginUsageIpc(deps: {
  ipcMain: Pick<IpcMain, 'handle'>;
  assertTrusted(event: IpcMainInvokeEvent): void;
  service(): PluginUsageService | null;
  /** Checks current-owner plugin visibility and derives verified install identity. */
  identity(ghostId: string): PluginUsageIdentity | null;
  /** The existing package lock is keyed by logical id, including instance-key queries. */
  lockId?(instanceId: string): string;
  warn(): void;
}): void {
  const historyId = (value: unknown): string => {
    if (
      typeof value !== 'string' ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value)
    )
      throwIpcError('INVALID_PARAMS', 'Invalid history id');
    return value;
  };
  const service = (): PluginUsageService => {
    const current = deps.service();
    if (!current) throwIpcError('PRECONDITION_FAILED', 'Plugin usage unavailable');
    return current;
  };
  const invoke = async <T>(event: IpcMainInvokeEvent, operation: () => Promise<T>): Promise<T> => {
    deps.assertTrusted(event);
    try {
      return await operation();
    } catch (error) {
      if (isIpcError(error)) throw error;
      deps.warn();
      throwIpcError('PRECONDITION_FAILED', 'Plugin usage unavailable');
    }
  };
  deps.ipcMain.handle('ghosts:usage-summary', (event, id: unknown) =>
    invoke(event, async () => {
      if (typeof id !== 'string' || !isGhostInstanceId(id))
        throwIpcError('INVALID_PARAMS', 'Invalid plugin id');
      const current = service();
      return withGhostInstallLock(deps.lockId?.(id) ?? id, async () => {
        if (service() !== current)
          throwIpcError('PRECONDITION_FAILED', 'Plugin usage owner changed');
        const identity = deps.identity(id);
        if (!identity) throwIpcError('NOT_FOUND', 'Plugin usage identity unavailable');
        await current.bind(identity);
        const handle = current.capture(identity);
        if (!handle) throwIpcError('PRECONDITION_FAILED', 'Plugin usage unavailable');
        return current.summary(handle.subjectId);
      });
    }),
  );
  deps.ipcMain.handle('ghosts:usage-history', (event) => invoke(event, () => service().history()));
  deps.ipcMain.handle('ghosts:usage-history-summary', (event, id: unknown) =>
    invoke(event, () => service().summary(historyId(id))),
  );
  deps.ipcMain.handle('ghosts:usage-clear', (event, id: unknown) =>
    invoke(event, () => service().clear(id === null ? null : historyId(id))),
  );
}
