/**
 * Fallback copy for database startup failures.
 *
 * The Desktop installs its main-process i18n through `localDbHostUi().translate`,
 * so these strings only appear in a headless host (or a misconfigured Desktop),
 * where the locale is the operator's, not the user's.
 */

import { uiText } from '../uiText.js';

const FALLBACKS: Record<string, string> = {
  'localDbFatal.schemaLease.title': 'Local database is in use',
  'localDbFatal.databaseCleanup.interruptedTitle': 'Local database maintenance was interrupted',
  'localDbFatal.databaseCleanup.interruptedDescription':
    'Database maintenance did not finish. Restart after closing other Cindy instances.',
  'localDbFatal.databaseCleanup.recoveryFailedTitle': 'Local database recovery failed',
  'localDbFatal.databaseCleanup.recoveryFailedDescription':
    'The database could not be recovered from its backup.',
  'localDbFatal.passiveCorrupt.title': 'Local database is busy',
  'localDbFatal.corrupt.title': 'Local database can’t be opened',
  'localDbFatal.initFailed.title': 'Local database failed to start',
  'localDbFatal.schemaLease.writer-active': 'Another Cindy instance is writing this database',
  'localDbFatal.schemaLease.readers-active': 'Other Cindy instances still read this database',
  'localDbFatal.schemaLease.lock-corrupt': 'The database lock record is unreadable',
  'localDbFatal.schemaLease.lock-unreadable': 'The database lock record cannot be read',
  'localDbFatal.schemaLease.recovery-busy': 'The database lock recovery is in progress',
  'localDbFatal.passiveCorrupt.description':
    'Another Cindy instance is using this database. Close it and retry.',
};

export function localDbText(key: string): string {
  return uiText(key, FALLBACKS[key] ?? key);
}
