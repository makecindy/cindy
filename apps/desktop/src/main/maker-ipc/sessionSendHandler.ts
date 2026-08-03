import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import { stripMainOnlySendOpts } from './mobileClientPromptNote.js';

/**
 * SEND adapter 只校验 IPC 入口并委托事务；lazy-create / rehydrate / accepted
 * 契约留在 makerSendTransaction，避免拆散一个业务事务。
 */
export interface MakerSessionSendHandlerDeps<TResult = unknown> {
  sendToAgentAccepted(
    sessionId: string,
    message: unknown,
    createOpts?: unknown,
    sendOpts?: unknown,
  ): TResult | Promise<TResult>;
}

export function registerMakerSessionSendHandler<TResult>(
  registry: IpcHandlerRegistry,
  deps: MakerSessionSendHandlerDeps<TResult>,
): void {
  registry.handle(
    MAKER_INVOKE.SEND,
    async (
      _e,
      sessionId: unknown,
      message: unknown,
      createOpts?: unknown,
      sendOpts?: unknown,
    ): Promise<TResult> => {
      if (typeof sessionId !== 'string') {
        throwIpcError('INVALID_PARAMS', 'sessionId required');
      }
      // sendOpts 来自 wire:剥掉只允许 main 写的字段(fromMobileClient 由 coordinator
      // 从队列项透传,客户端不得自报 —— 直连路径的来源判据只能是 async context)。
      return await deps.sendToAgentAccepted(
        sessionId,
        message,
        createOpts,
        stripMainOnlySendOpts(sendOpts),
      );
    },
  );
}
