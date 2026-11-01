
import { isQuietScheduledOutput } from '../scheduler-host/silent-output.js';
import { captureTurnUsageContext, type TurnUsageContext } from './turnUsageContext.js';
import { noteSubagentObservationTurnStarted } from '../subagentObservationRewindFence.js';

import { t } from '../i18n.js';
import { markSessionTurnStarted } from '../localDb/sessionActiveTurn.js';
import {
  backgroundTurnPredatesSessionClear,
  noteAgentMeta,
  noteTurnStarted,
  onStandaloneTextEvent,
} from '../messagePersistBroadcaster.js';
import { isCcMgrUpgradeInFlight } from '../remote-ssh/index.js';
import { clearPromptPredictionSessionStopped } from './promptPredictionStopLedger.js';
import { MAKER_PUSH } from './channels.js';
import { finalizeTurnChangeSet } from '../turn-change-set/store.js';
import { noteClaudeSessionTurnState } from '../maker-host/claude-session-background-activity.js';
import { consumeClaudeOpusPlanMismatch } from '../maker-host/claude-gateway-error-observer.js';
import {createSessionEventPreparation} from '@cindy/app-runtime/sessionEventPreparation';
export type * from '@cindy/app-runtime/sessionEventPreparation';
export const {prepareSessionEvent}=createSessionEventPreparation({
isQuietScheduledOutput: (...args) => isQuietScheduledOutput(...args),
captureTurnUsageContext: (...args) => captureTurnUsageContext(...args),
noteSubagentObservationTurnStarted: (...args) => noteSubagentObservationTurnStarted(...args),
t: key => t(key),
markSessionTurnStarted: (...args) => markSessionTurnStarted(...args),
backgroundTurnPredatesSessionClear: (...args) => backgroundTurnPredatesSessionClear(...args),
noteAgentMeta: (...args) => noteAgentMeta(...args),
noteTurnStarted: (...args) => noteTurnStarted(...args),
onStandaloneTextEvent: (...args) => onStandaloneTextEvent(...args),
isCcMgrUpgradeInFlight: (...args) => isCcMgrUpgradeInFlight(...args),
clearPromptPredictionSessionStopped: (...args) => clearPromptPredictionSessionStopped(...args),
get MAKER_PUSH() { return MAKER_PUSH; },
finalizeTurnChangeSet: (...args) => finalizeTurnChangeSet(...args),
noteClaudeSessionTurnState: (...args) => noteClaudeSessionTurnState(...args),
consumeClaudeOpusPlanMismatch: (...args) => consumeClaudeOpusPlanMismatch(...args)
});
