import { app } from 'electron';
import { activeOwnerScopeKey, getActiveAppSession, isAppSessionBoundaryPending } from '../appSessionState.js';
import { createMediaRefCompensationJournal } from './refCompensationJournal';
export type { MediaRefCompensationScope, MediaRefCompensationReconcileResult } from './refCompensationJournal';

export const {
  captureMediaRefCompensationScope,
  withMediaRefCompensation,
  reconcileMediaRefCompensationsForOwner,
} = createMediaRefCompensationJournal({
  getUserDataDir: () => app.getPath('userData'),
  activeOwnerScopeKey: () => activeOwnerScopeKey(),
  getActiveAppSession: () => getActiveAppSession(),
  isAppSessionBoundaryPending: () => isAppSessionBoundaryPending(),
});
