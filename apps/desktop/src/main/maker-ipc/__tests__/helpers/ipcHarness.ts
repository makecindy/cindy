import { EventEmitter } from 'node:events';

import type { IpcHandler, IpcHandlerRegistry } from '../../ipcHandlerRegistry';

class IpcHarnessSender extends EventEmitter {
  constructor(readonly id: number) {
    super();
  }
}

/** 内存版 IPC registry，用于直接 invoke handler body。 */
export class IpcHarness implements IpcHandlerRegistry {
  private readonly handlers = new Map<string, IpcHandler>();
  private readonly senders = new Map<number, IpcHarnessSender>();

  handle(channel: string, handler: IpcHandler): void {
    if (this.handlers.has(channel)) {
      throw new Error(`duplicate IPC handler: ${channel}`);
    }
    this.handlers.set(channel, handler);
  }

  async invoke(channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing IPC handler: ${channel}`);
    return await handler({}, ...args);
  }

  async invokeFrom(senderId: number, channel: string, ...args: unknown[]): Promise<unknown> {
    const handler = this.handlers.get(channel);
    if (!handler) throw new Error(`missing IPC handler: ${channel}`);
    return await handler({ sender: this.sender(senderId) }, ...args);
  }

  destroySender(senderId: number): void {
    this.sender(senderId).emit('destroyed');
  }

  private sender(senderId: number): IpcHarnessSender {
    let sender = this.senders.get(senderId);
    if (!sender) {
      sender = new IpcHarnessSender(senderId);
      this.senders.set(senderId, sender);
    }
    return sender;
  }
}
