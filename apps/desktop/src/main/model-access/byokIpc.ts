import type { IpcMain, IpcMainInvokeEvent } from 'electron';
import type { ByokStatus } from '../../shared/modelAccess.js';

interface ByokControl {
  getStatus(): ByokStatus;
  sync(): Promise<void>;
}
export function registerByokIpc(
  ipc: Pick<IpcMain, 'handle'>,
  control: ByokControl,
  assertSender: (event: IpcMainInvokeEvent) => void,
): void {
  ipc.handle('model-access:byok-status', (event) => {
    assertSender(event);
    return control.getStatus();
  });
  ipc.handle('model-access:byok-retry', async (event) => {
    assertSender(event);
    await control.sync();
    return control.getStatus();
  });
}
