import { afterEach } from 'vitest';
import { TerminalModelConfig as Original } from '../models/config.js';
import { openStandaloneNodeDatabase, type NodeDatabase } from '../database.js';
import type { Logger } from '@cindy/maker-core';
export * from '../models/config.js';
const databases = new Map<string, Promise<NodeDatabase>>();
const logger: Logger = {trace() {}, debug() {}, info() {}, warn() {}, error() {}, fatal() {}, child: () => logger};
// File-local teardown hooks run before this imported hook. Call this explicitly
// after stopping consumers and before removing their directories on Windows.
export async function closeModelFixtureDatabases() {
  const active = [...databases.values()];
  databases.clear();
  await Promise.all(active.map(async db => (await db).close()));
}
afterEach(closeModelFixtureDatabases);
export function modelFixtureDatabase(root: string): Promise<NodeDatabase> {
  let db = databases.get(root);
  if (!db) {db = openStandaloneNodeDatabase(root, logger); databases.set(root, db);}
  return db;
}
export class TerminalModelConfig extends Original {
  readonly fixtureDatabase: NonNullable<ConstructorParameters<typeof Original>[7]>;
  constructor(...args: ConstructorParameters<typeof Original>) {
    args[7] ??= modelFixtureDatabase(args[0]);
    super(...args);
    this.fixtureDatabase = args[7]!;
  }
}
