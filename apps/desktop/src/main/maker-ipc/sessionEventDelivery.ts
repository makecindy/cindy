
import { reserveTurnErrorPersistId } from '../messagePersistBroadcaster.js';
import { MAKER_PUSH } from './channels.js';
import { noteClaudeSessionTurnState } from '../maker-host/claude-session-background-activity.js';
import {createSessionEventDelivery} from '@cindy/app-runtime/sessionEventDelivery';
export type * from '@cindy/app-runtime/sessionEventDelivery';
export const {deliverSessionEvent}=createSessionEventDelivery({
reserveTurnErrorPersistId: (...args) => reserveTurnErrorPersistId(...args),
get MAKER_PUSH() { return MAKER_PUSH; },
noteClaudeSessionTurnState: (...args) => noteClaudeSessionTurnState(...args)
});
