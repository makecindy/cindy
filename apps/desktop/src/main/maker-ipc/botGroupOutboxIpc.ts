import type { IpcMainInvokeEvent } from 'electron';
import type { BotGroupSendInput, BotGroupSendResult } from '../../shared/botGroupChat';
import type { createBotGroupOutboxStorage } from './botGroupOutboxStorage';

type Storage = ReturnType<typeof createBotGroupOutboxStorage>;

/** Production IPC entries preserve Electron's actual sender object, never a renderer window id. */
export function createBotGroupOutboxIpc(deps: {
  assertCommandSender: (event: IpcMainInvokeEvent) => void;
  assertSendSender: (event: IpcMainInvokeEvent) => void;
  command: Storage['command'];
  send: Storage['send'];
  service: (input: BotGroupSendInput) => Promise<BotGroupSendResult>;
}) {
  return {
    command(event: IpcMainInvokeEvent, input: unknown) {
      deps.assertCommandSender(event);
      return deps.command(event.sender, input);
    },
    send(event: IpcMainInvokeEvent, input: unknown, execution: unknown) {
      deps.assertSendSender(event);
      return deps.send(event.sender, input, execution, deps.service);
    },
  };
}
