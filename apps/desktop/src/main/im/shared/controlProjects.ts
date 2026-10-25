import { and, desc, eq, inArray, isNotNull, isNull, ne, or } from 'drizzle-orm';
import { getDbClient } from '../../localDb/client/current';
import { sessions } from '../../localDb/schema';
import { isProvisionalSession } from '../../localDb/provisionalSessions';
import { DESKTOP_TASK_LIST_SESSION_SOURCES } from '../../../shared/sessionSource.js';
import { createControlProjectReader } from '@cindy/im-runtime/controlProjects';
export * from '@cindy/im-runtime/controlProjects';

export const { listProjectsForControl, listRecentSessionsForPicker, listSessionsForWorkspace, readSessionTitle } = createControlProjectReader({
  isProvisional: isProvisionalSession,
  listRows: async (options) => {
    const query = getDbClient().drizzle.select({ id: sessions.id, title: sessions.title, workingDir: sessions.workingDir,
      userSendAt: sessions.userSendAt, updatedAt: sessions.updatedAt }).from(sessions).where(and(
      inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES), eq(sessions.status, 'active'), isNotNull(sessions.workingDir),
      or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
    ));
    const ordered = options?.ordered ? query.orderBy(desc(sessions.userSendAt), desc(sessions.updatedAt)) : query;
    return options?.limit === undefined ? ordered : ordered.limit(options.limit);
  },
  readTitle: async (id) => {
    const [row] = await getDbClient().drizzle.select({ title: sessions.title }).from(sessions).where(eq(sessions.id, id)).limit(1);
    return row?.title ?? null;
  },
});
