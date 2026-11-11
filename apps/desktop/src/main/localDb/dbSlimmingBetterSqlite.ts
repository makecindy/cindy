import { createRequire } from 'node:module';
import { workerData } from 'node:worker_threads';

type DatabaseConstructor = new (
  filename: string | Buffer,
  options?: Record<string, unknown>,
) => unknown;

const moduleRequire = createRequire(import.meta.url);
const modulePath = (workerData as { betterSqliteModulePath?: string } | undefined)
  ?.betterSqliteModulePath ?? process.env.CINDY_DB_SLIMMING_BETTER_SQLITE_MODULE;
const loaded = moduleRequire(modulePath || 'better-sqlite3') as
  | DatabaseConstructor
  | { default?: DatabaseConstructor };
const Database = typeof loaded === 'function' ? loaded : loaded.default;

if (typeof Database !== 'function') {
  throw new Error('database cleanup worker could not load better-sqlite3');
}

export default Database;
