import { createMediaRefCompensationJournal } from '@cindy/app-runtime/mediaRefCompensationJournal';
import { app } from 'electron';
import { activeOwnerScopeKey, dataOwnerStorageKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { withCrossProcessLock } from '../device-link/crossProcessLock.js';
import { createLogger } from '../logger.js';
import * as ledger from './ledger.js';
export type * from '@cindy/app-runtime/mediaRefCompensationJournal';
export const { captureMediaRefCompensationScope, withMediaRefCompensation, reconcileMediaRefCompensationsForOwner } = createMediaRefCompensationJournal({ userDataDirectory: () => app.getPath('userData'), activeOwnerScopeKey: (...args) => activeOwnerScopeKey(...args), dataOwnerStorageKey: (...args) => dataOwnerStorageKey(...args), getActiveAppSession: (...args) => getActiveAppSession(...args), isAppSessionBoundaryPending: (...args) => isAppSessionBoundaryPending(...args), withCrossProcessLock: (...args) => withCrossProcessLock(...args), ledger, logger: createLogger('cindy-media-ref-compensation') });
