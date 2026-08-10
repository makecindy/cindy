import { and, desc, eq, inArray, isNotNull, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { loadPinnedOrder } from '../sidebarSettingsStore.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { WORKLOUDER_CODEX_AGENT_SLOT_COUNT } from './protocol.js';

export interface WorkLouderCodexTaskSlotRow {
  id: string;
}

/** Applies the sidebar's persisted manual order to pinned session rows. */
export function orderWorkLouderCodexPinnedRows(
  rows: readonly WorkLouderCodexTaskSlotRow[],
  pinnedOrder: readonly string[],
): WorkLouderCodexTaskSlotRow[] {
  const rowsById = new Map(rows.map((row) => [row.id, row] as const));
  const ordered: WorkLouderCodexTaskSlotRow[] = [];
  const seen = new Set<string>();
  for (const id of pinnedOrder) {
    const row = rowsById.get(id);
    if (!row || seen.has(id)) continue;
    seen.add(id);
    ordered.push(row);
  }
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    ordered.push(row);
  }
  return ordered;
}

/** Pinned tasks lead, followed by the most recently used non-duplicate tasks. */
export function mergeWorkLouderCodexTaskSlots(
  pinnedRows: readonly WorkLouderCodexTaskSlotRow[],
  recentRows: readonly WorkLouderCodexTaskSlotRow[],
): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const row of [...pinnedRows, ...recentRows]) {
    if (!row.id || seen.has(row.id)) continue;
    seen.add(row.id);
    result.push(row.id);
    if (result.length === WORKLOUDER_CODEX_AGENT_SLOT_COUNT) break;
  }
  return result;
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
  const [pinnedRows, recentRows] = await Promise.all([
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(and(visibleActiveTask, isNotNull(sessions.pinnedAt)))
      .orderBy(desc(sessions.pinnedAt), desc(sessions.id)),
    db
      .select({ id: sessions.id })
      .from(sessions)
      .where(visibleActiveTask)
      .orderBy(
        desc(sql`COALESCE(${sessions.userSendAt}, ${sessions.updatedAt})`),
        desc(sessions.id),
      )
      .limit(WORKLOUDER_CODEX_AGENT_SLOT_COUNT),
  ]);
  return mergeWorkLouderCodexTaskSlots(
    orderWorkLouderCodexPinnedRows(pinnedRows, loadPinnedOrder()),
    recentRows,
  );
}
