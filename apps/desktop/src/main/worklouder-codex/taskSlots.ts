import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { WORKLOUDER_CODEX_AGENT_SLOT_COUNT } from './protocol.js';

export interface WorkLouderCodexTaskSlotRow {
  id: string;
}

/** Keeps database recency order unchanged and caps the keyboard projection at six tasks. */
export function selectWorkLouderCodexRecentTaskSlots(
  rows: readonly WorkLouderCodexTaskSlotRow[],
): string[] {
  return rows.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT).map((row) => row.id);
}

/** Reads the six active tasks represented by AG00 through AG05. */
export async function listWorkLouderCodexTaskSlots(
  db: DbClient['drizzle'] = getDbClient().drizzle,
): Promise<string[]> {
  const visibleActiveTask = and(
    eq(sessions.status, 'active'),
    inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
    or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
  );
  const recentRows = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(visibleActiveTask)
    .orderBy(desc(sql`COALESCE(${sessions.userSendAt}, ${sessions.updatedAt})`), desc(sessions.id))
    .limit(WORKLOUDER_CODEX_AGENT_SLOT_COUNT);
  return selectWorkLouderCodexRecentTaskSlots(recentRows);
}
