import type { WorktreeRecycleRecord } from '@cindy/worktree-core/recycleTypes';

import { app } from 'electron';

import { physicalWorktreeKey, worktreeResourceId } from './resourceLock';

import { createLogger } from '../logger';

import { notifyWorktreeRecycleRecordChanged } from './recycleEvents';

export type { WorktreeRecycleRecord } from '@cindy/worktree-core/recycleTypes';
import { createWorktreeRecycleJournal } from '@cindy/worktree-core/recycleJournal';
const service = createWorktreeRecycleJournal({
  physicalWorktreeKey: (...args) => physicalWorktreeKey(...args),
  log: createLogger('worktreeRecycleJournal'),
  worktreeResourceId: (...args) => worktreeResourceId(...args),
  notifyWorktreeRecycleRecordChanged: (...args) => notifyWorktreeRecycleRecordChanged(...args),
  userDataRoot: () => app.getPath('userData'),
  appDataRoot: () => app.getPath('appData'),
});
export const {
  recycleJournalRoot,
  worktreeGeneration,
  readRecycleRecord,
  writeRecycleRecord,
  watchRecycleJournal,
  newRecycleRecord,
  listRecycleRecords,
  listRecycleRecordsWithHistory,
} = service;
