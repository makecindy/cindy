/**
 * IPC handler 注册器抽象。
 *
 * handler body 只依赖这个最小接口，生产环境再由 Electron adapter 接到 ipcMain.handle。
 */

/** 单个 invoke handler body。 */
export type IpcHandler = (
  event: unknown,
  ...args: unknown[]
) => unknown | Promise<unknown>;

/** handler 注册表的最小能力。 */
export interface IpcHandlerRegistry {
  handle(channel: string, handler: IpcHandler): void;
}
