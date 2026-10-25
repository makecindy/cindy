import {MAKER_INVOKE} from '@cindy/maker-shared/maker-channels';
import {throwIpcError} from '@cindy/remote-agent/ipcValidate';
import {projectRemoteBotDelegations} from './remoteBotDelegations.js';
import type {BotDelegationService} from './botDelegationService.js';
export function registerBotDelegationHandlers<Event>(host:{
 ipcMain:{handle(channel:string,handler:(event:Event,...args:any[])=>unknown):void};
 isDeviceLinkInvoke():boolean;
 assertTrustedAppRendererEvent(event:Event):void;
 service:BotDelegationService;
}){
const {ipcMain,isDeviceLinkInvoke,assertTrustedAppRendererEvent,service:delegationForRestore}=host;
  ipcMain.handle(
    MAKER_INVOKE.BOT_DELEGATIONS_LIST,
    async (event, parentSessionId: unknown) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (typeof parentSessionId !== 'string' || (parentSessionId.length === 0 || parentSessionId.length > 128)) {
        throwIpcError('INVALID_PARAMS', 'parentSessionId required');
      }
      const result = await delegationForRestore.listDelegations(parentSessionId);
      return isDeviceLinkInvoke() ? projectRemoteBotDelegations(result) : result;
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.BOT_DELEGATION_CANCEL,
    async (event, parentSessionId: unknown, delegationId: unknown) => {
      if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
      if (
        typeof parentSessionId !== 'string'
        || (parentSessionId.length === 0 || parentSessionId.length > 128)
        || typeof delegationId !== 'string'
        || (delegationId.length === 0 || delegationId.length > 128)
      ) {
        throwIpcError('INVALID_PARAMS', 'parentSessionId + delegationId required');
      }
      // The owner's own stop button: not a group tool call, so no live group execution is needed.
      return delegationForRestore.cancelDelegationFromOwner(parentSessionId, delegationId);
    },
  );
  ipcMain.handle(
    MAKER_INVOKE.BOT_DELEGATION_NOTE_TRACE,
    async (event, parentSessionId: unknown, delegationId: unknown, text: unknown) => {
      // Local only: the card offers 补一句 for tasks on this computer and the channel
      // stays out of the device-link allowlist, so the sender is always the app renderer.
      assertTrustedAppRendererEvent(event);
      if (
        typeof parentSessionId !== 'string'
        || (parentSessionId.length === 0 || parentSessionId.length > 128)
        || typeof delegationId !== 'string'
        || (delegationId.length === 0 || delegationId.length > 128)
        || typeof text !== 'string'
        || (text.trim().length === 0 || text.length > 4_000)
      ) {
        throwIpcError('INVALID_PARAMS', 'parentSessionId + delegationId + text required');
      }
      return delegationForRestore.traceOwnerNote(parentSessionId, delegationId, text);
    },
  );
}
