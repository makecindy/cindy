import { and, eq, inArray, isNull, ne, or, type SQL } from 'drizzle-orm';
import { DESKTOP_TASK_LIST_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { botSessionLinks, sessions } from './schema.js';

/** A side chat appears alongside ordinary tasks once the user promotes it. */
export function ordinaryTaskSourceFilter(): SQL | undefined {
  return or(inArray(sessions.source, DESKTOP_TASK_LIST_SESSION_SOURCES),
    and(eq(sessions.source, 'side-chat'), eq(sessions.sideChatPromoted, true)));
}

/** Plugin task reads left-join the companion link on the session ID. */
export function pluginObservableSessionFilter(): SQL | undefined {
  return and(
    inArray(sessions.status, ['active', 'archived']),
    isNull(sessions.hiddenAt),
    isNull(botSessionLinks.sessionId),
    ne(sessions.source, 'bot'),
    ne(sessions.source, 'review'),
    or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
  );
}

/** Apply the same eligibility when reading a status and when a queued reply reaches the wire. */
export function pluginSessionStatusFilter(ids: string[]): SQL | undefined {
  return and(inArray(sessions.id, ids), pluginObservableSessionFilter(), ordinaryTaskSourceFilter());
}
