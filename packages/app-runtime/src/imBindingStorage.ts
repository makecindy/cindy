import { eq } from 'drizzle-orm';
import { imBindings } from '@cindy/runtime-db/schema';
import type { DbClient } from '@cindy/runtime-db/client/DbClient';
import type { ImBindingStorage } from '@cindy/im-runtime/binding';

/** Original binding transactions, captured against one owner's database. */
export function createImBindingStorage(db: DbClient): ImBindingStorage {
  return {
    list: () => db.drizzle.select().from(imBindings),
    deleteIdentities: async identities => {
      await db.tx('im.deleteBindings', {
        identities: identities.map(identity => ({ ...identity, scopeKey: identity.scopeKey ?? '' })),
      });
    },
    replace: async row => { await db.tx('im.replaceBinding', row); },
    deleteTarget: async id => { await db.drizzle.delete(imBindings).where(eq(imBindings.targetSessionId, id)); },
  };
}
