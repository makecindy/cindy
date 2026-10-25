import {createSessionActiveTurn} from '@cindy/app-runtime/sessionActiveTurn';
export type * from '@cindy/app-runtime/sessionActiveTurn';
import {getDbClient} from './client/current';
import {listCindyMakePendingFailureSessionIds} from './cindyMakeAttention';
import * as boot from './sessionInterruptionBoot';
import {createLogger} from '../logger';
export const {freezeSessionActiveTurnMarkers, beginSessionTurnEndedSuppression, setOnSessionTurnEndedPersisted, getSessionNotificationTurnSignal, drainSessionActiveTurnWrites, markSessionTurnStarted, markSessionTurnEnded, markSessionTurnEndedOnClose, markSessionTurnEndedAfterBarrier, ackSessionTurnEndedDurable, ackSessionTurnEndedIfUnchanged, _setBootAtMsForTests, listInterruptedPendingRows, listInterruptedPendingSessionIds, listErrorTailPendingRows, listErrorTailPendingSessionIds, hasAssistantProgressAfterMessage, getRecoveryContextSnapshot, _resetSessionActiveTurnStateForTests}=createSessionActiveTurn({getDbClient: () => getDbClient(),listCindyMakePendingFailureSessionIds: (...args) => listCindyMakePendingFailureSessionIds(...args),boot,logger:createLogger('session-active-turn')});
