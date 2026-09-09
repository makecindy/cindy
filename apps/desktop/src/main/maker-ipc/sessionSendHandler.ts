import { throwIpcError } from '../utils/ipcValidate.js';
import { MAKER_INVOKE } from './channels.js';
import type { IpcHandlerRegistry } from './ipcHandlerRegistry.js';
import {
  attachMainOwnedInputBoundary,
  type MainOwnedInputBoundaryStamp,
} from './mobileClientPromptNote.js';

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
  /**
   * Legacy direct maker:send callers still exist on older controllers.  Give
   * them the same clear-generation fence as the modern input coordinator
   * before delegating to the send transaction.
   */
  assertRemoteInputControlBoundary?(
    sessionId: string,
    opts: unknown,
  ): MainOwnedInputBoundaryStamp | void | Promise<MainOwnedInputBoundaryStamp | void>;
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
      const boundaryStamp = await deps.assertRemoteInputControlBoundary?.(sessionId, sendOpts);
      const mainOwnedBoundaryStamp =
        boundaryStamp && typeof boundaryStamp === 'object' ? boundaryStamp : undefined;
      // sendOpts 来自 wire:剥掉只允许 main 写的字段(fromMobileClient/fromDeviceLinkClient 由 coordinator
      // 从队列项透传；turnPermissionPolicy 只由 Main 的 IM dispatcher 构造),然后由
      // main 覆盖 clear token + generation。旧控制端不带 token 也因此获得同样的 clear
      // 竞态保护,而不是在最终 fence 缺 precondition 时放行。
      return await deps.sendToAgentAccepted(
        sessionId,
        message,
        createOpts,
        attachMainOwnedInputBoundary(sendOpts, mainOwnedBoundaryStamp),
      );
    },
  );
}
