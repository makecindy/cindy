import type Database from 'better-sqlite3';

export function closeDb(db: Database.Database): void {
  db.close();
}
