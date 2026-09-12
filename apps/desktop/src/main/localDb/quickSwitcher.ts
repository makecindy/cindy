import { and, asc, gt, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import { normalizeDbAgentKind } from '../../shared/agentKindConversion';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource';
import {
  QUICK_SWITCHER_PAGE_SIZE,
  type QuickSwitcherCatalogPage,
} from '../../shared/quickSwitcher';
import { getDbClient } from './client/current';
import { sessions } from './schema';

/** Keyset pages cover old/archived titles without FTS, vector search or message previews. */
export async function listQuickSwitcherCatalog(
  afterId: string | null,
): Promise<QuickSwitcherCatalogPage> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      remoteHostId: sessions.remoteHostId,
      agentKind: sessions.agentKind,
      status: sessions.status,
      source: sessions.source,
      orcaRole: sessions.orcaRole,
      parentSessionId: sessions.parentSessionId,
      pinnedAt: sessions.pinnedAt,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
      createdAt: sessions.createdAt,
      // Grouping uses all physical messages, including rewound rows, just like
      // sessions:list/get. This indexed probe neither reads content nor counts history.
      hasMessages: sql<number>`exists(select 1 from messages where session_id = ${sessions.id})`,
    })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        inArray(sessions.status, ['active', 'archived']),
        or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
        afterId === null ? undefined : gt(sessions.id, afterId),
      ),
    )
    .orderBy(asc(sessions.id))
    .limit(QUICK_SWITCHER_PAGE_SIZE + 1);
  const page = rows.slice(0, QUICK_SWITCHER_PAGE_SIZE);
  return {
    version: 1,
    sessions: page.map(({ hasMessages, ...row }) => ({
      ...row,
      agentKind: normalizeDbAgentKind(row.agentKind),
      pinnedAt: row.pinnedAt === null ? null : new Date(row.pinnedAt).toISOString(),
      userSendAt: row.userSendAt === null ? null : new Date(row.userSendAt).toISOString(),
      updatedAt: new Date(row.updatedAt).toISOString(),
      createdAt: new Date(row.createdAt).toISOString(),
      _count: { messages: Number(hasMessages) },
    })),
    nextCursor: rows.length > QUICK_SWITCHER_PAGE_SIZE ? page[page.length - 1].id : null,
  };
}
