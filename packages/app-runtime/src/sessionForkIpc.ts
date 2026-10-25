
import { requireString, throwIpcError } from '@cindy/remote-agent/ipcValidate';

import { MAKER_INVOKE } from '@cindy/maker-shared/maker-channels';
import type {Logger} from '@cindy/maker-core';
import type {createSessionFork} from './sessionFork.js';
export interface SessionForkIpcHost<Event> extends Pick<ReturnType<typeof createSessionFork>,'createSideChat'|'listSideChats'|'forkSessionAtMessage'|'forkSessionStripEncrypted'> {
 ipcMain:{handle(channel:string,callback:(event:Event,...args:any[])=>unknown):void};
 logger:Pick<Logger,'warn'>;
 emitSessionCreated(id:string):void;
 assertTrustedAppRendererEvent(event:Event):void;
 getDeviceLinkInvokeContext():{channel:string;controllerDeviceId?:string;sharedTask?:unknown}|null|undefined;
}

export function createSessionForkIpc<Event>(host: SessionForkIpcHost<Event>) {
const {ipcMain,logger:log,createSideChat,listSideChats,forkSessionAtMessage,forkSessionStripEncrypted,emitSessionCreated,assertTrustedAppRendererEvent,getDeviceLinkInvokeContext} = host;


/**
 * 广播「新会话已建」给所有窗口 + device-link tap(转发给订阅 `sessions` topic 的控制端)。
 * 统一走 emitSessionCreated，避免 fork 会话在被控端 / 其它控制端侧边栏凭空消失。
 */
function broadcastSessionCreated(sessionId: string): void {
  emitSessionCreated(sessionId);
}

function assertSideChatCaller(event: Event, channel: string): void {
  const context = getDeviceLinkInvokeContext();
  if (context) {
    // Main creates this context only after device-link authorization. A remote
    // invoke has no Electron frame; never accept a caller-supplied substitute.
    if (context.channel !== channel || !context.controllerDeviceId || context.sharedTask) {
      throwIpcError('PERMISSION_DENIED', 'Side chats require the task owner');
    }
  } else {
    assertTrustedAppRendererEvent(event);
  }
}

function registerMakerForkIpc(): void {
  ipcMain.handle(MAKER_INVOKE.SIDE_CHAT_LIST, (event, sourceSessionId: unknown) => {
    assertSideChatCaller(event, MAKER_INVOKE.SIDE_CHAT_LIST);
    return listSideChats(requireString(sourceSessionId, 'sourceSessionId'));
  });
  ipcMain.handle(MAKER_INVOKE.SIDE_CHAT, async (event, sourceSessionId: unknown) => {
    assertSideChatCaller(event, MAKER_INVOKE.SIDE_CHAT);
    const sid = requireString(sourceSessionId, 'sourceSessionId');
    try {
      const session = await createSideChat(sid);
      broadcastSessionCreated(session.id);
      return session;
    } catch (error) {
      const code = (error as { code?: string }).code;
      log.warn('side chat creation failed', { sourceSessionId: sid, code });
      if (code === 'SOURCE_NOT_FOUND') throwIpcError('NOT_FOUND', 'Source task is unavailable');
      if (code === 'REMOTE_NOT_SUPPORTED') throwIpcError('UNSUPPORTED_CAPABILITY', 'Native history is on another execution host');
      if (code === 'NO_PRIOR_ASSISTANT' || code === 'SOURCE_NEVER_RAN') {
        throwIpcError('NO_PRIOR_ASSISTANT', 'Wait for the first completed reply');
      }
      throwIpcError('PRECONDITION_FAILED', 'Could not create a side chat from this history');
    }
  });
  ipcMain.handle(
    MAKER_INVOKE.FORK,
    async (
      _event: Event,
      sourceSessionId: unknown,
      messageClientId: unknown,
    ) => {
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      const mid = requireString(messageClientId, 'messageClientId');
      try {
        const session = await forkSessionAtMessage(sid, mid);
        broadcastSessionCreated(session.id);
        return session;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork failed', { sourceSessionId: sid, messageClientId: mid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
          case 'MESSAGE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_USER_MESSAGE':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'NO_PRIOR_ASSISTANT':
            throwIpcError('NO_PRIOR_ASSISTANT', '请在 AI 回复之后的提问上 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );

  ipcMain.handle(
    MAKER_INVOKE.FORK_STRIP_ENCRYPTED,
    async (_event: Event, sourceSessionId: unknown) => {
      const sid = requireString(sourceSessionId, 'sourceSessionId');
      try {
        const session = await forkSessionStripEncrypted(sid);
        broadcastSessionCreated(session.id);
        return session;
      } catch (err) {
        const code = (err as { code?: string }).code;
        const msg = err instanceof Error ? err.message : String(err);
        log.warn('fork strip encrypted failed', { sourceSessionId: sid, code, error: msg });
        switch (code) {
          case 'SOURCE_NOT_FOUND':
            throwIpcError('NOT_FOUND', msg);
            break;
          case 'NOT_CODEX_SESSION':
          case 'REMOTE_NOT_SUPPORTED':
            throwIpcError('INVALID_PARAMS', msg);
            break;
          case 'SOURCE_NEVER_RAN':
            throwIpcError('SOURCE_NEVER_RAN', '原会话尚未运行，无法 fork');
            break;
          case 'CODEX_FORK_STATE_UNAVAILABLE':
            throwIpcError('CODEX_FORK_STATE_UNAVAILABLE', msg);
            break;
          case 'UNSUPPORTED_HISTORY':
            throwIpcError('FORK_UNSUPPORTED_HISTORY', msg);
            break;
          default:
            throw err;
        }
      }
    },
  );
}
return {
  registerMakerForkIpc
};
}
