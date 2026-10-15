import type { DbClient } from './DbClient.js';

const pending = new WeakMap<DbClient, Set<Promise<void>>>();

/** Keep the outgoing account database alive until an already-paid request is accounted for. */
export function retainDbClient(client: DbClient): () => void {
  const operations = pending.get(client) ?? new Set<Promise<void>>();
  pending.set(client, operations);
  let resolve!: () => void;
  const done = new Promise<void>((complete) => { resolve = complete; });
  operations.add(done);
  return () => {
    operations.delete(done);
    resolve();
  };
}

export async function waitForRetainedDbClient(client: DbClient): Promise<void> {
  while (pending.get(client)?.size) await Promise.all(pending.get(client)!);
}
