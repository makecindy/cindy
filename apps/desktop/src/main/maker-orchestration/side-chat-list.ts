/**
 * Side-chat list read, shared by the desktop IPC handler and the Node Host.
 *
 * Kept apart from fork.ts so the Host can load it without the fork module's
 * Electron-bound imports. Body moved verbatim; no top-level side effects.
 */

import { and, asc, eq, or } from 'drizzle-orm';

import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';

export async function listSideChats(sourceSessionId: string): Promise<Array<{ id: string }>> {
  return getDbClient().drizzle.select({ id: sessions.id }).from(sessions).where(and(
    eq(sessions.parentSessionId, sourceSessionId), eq(sessions.source, 'side-chat'),
    or(eq(sessions.status, 'active'), eq(sessions.status, 'archived')),
  )).orderBy(asc(sessions.createdAt));
}
