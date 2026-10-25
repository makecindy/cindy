import type Database from 'better-sqlite3';

import { exec, type RunResult } from './exec.js';

export function run(db: Database.Database, args: unknown): RunResult {
  return exec(db, args);
}
