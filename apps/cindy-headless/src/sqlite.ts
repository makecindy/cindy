import { DatabaseSync } from 'node:sqlite';
import type Database from 'better-sqlite3';

/** Adapter for Maker Core's small better-sqlite3-compatible surface. */
export function openHeadlessSqlite(filePath: string): Database.Database {
  const database = new DatabaseSync(filePath);
  const compatible = {
    exec(sql: string) { database.exec(sql); },
    pragma(sql: string) { database.exec(`PRAGMA ${sql}`); },
    prepare(sql: string) {
      const statement = database.prepare(sql);
      return {
        run(...params: unknown[]) { return statement.run(...params as never[]); },
        get(...params: unknown[]) { return statement.get(...params as never[]); },
        all(...params: unknown[]) { return statement.all(...params as never[]); },
      };
    },
    transaction<T>(fn: (...args: never[]) => T) {
      return (...args: never[]) => {
        database.exec('BEGIN');
        try {
          const result = fn(...args);
          database.exec('COMMIT');
          return result;
        } catch (error) {
          database.exec('ROLLBACK');
          throw error;
        }
      };
    },
    close() { database.close(); },
  } as unknown as Database.Database;
  return compatible;
}
