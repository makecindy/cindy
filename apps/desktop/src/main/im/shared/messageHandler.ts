import { createMessageHandler as createSharedMessageHandler } from '@cindy/im-runtime/messageHandler';
import { createLogger } from '../../logger';
import { captureImAccountGeneration, runInImAccountGeneration, isImAccountScopeClosedError } from '../accountBoundary';
import { getControlScope, isInControl } from './controlState';
import { looksLikeSlashCommand, type ImSlashHandlers } from './slashCommands';
import type { ImTurnRunner } from './turnRunner';
import type { ImChannelAdapter } from './types';
export { isStopCommand } from '@cindy/im-runtime/controlCommands';
export function createMessageHandler(adapter:ImChannelAdapter,slash:ImSlashHandlers,turnRunner:ImTurnRunner){
  return createSharedMessageHandler(adapter,slash,turnRunner,{createLogger,captureImAccountGeneration,runInImAccountGeneration,isImAccountScopeClosedError,getControlScope,isInControl,looksLikeSlashCommand});
}
