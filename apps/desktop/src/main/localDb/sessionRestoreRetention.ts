import type { DbClient } from './client/DbClient.js';

type RestoreObserver = (ids: readonly string[], db: DbClient['drizzle']) => Promise<void>;
let observer: RestoreObserver | null = null;
/** Installed by task management; database-only tools retain the ordinary lifecycle. */
export function setSessionRestoreObserver(next: RestoreObserver | null): void {
  observer = next;
}
export async function noteSessionsRestoring(
  ids: readonly string[],
  db: DbClient['drizzle'],
): Promise<void> {
  await observer?.(ids, db);
}
