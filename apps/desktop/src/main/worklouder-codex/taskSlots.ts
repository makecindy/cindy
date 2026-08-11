import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { loadSidebarSettingsSnapshot } from '../sidebarSettingsStore.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  type WorkLouderCodexTaskOption,
} from '../../shared/workLouderCodex.js';

const TASK_OPTION_LIMIT = 100;

export interface WorkLouderCodexTaskSlotRow {
  id: string;
}

interface WorkLouderCodexTaskCatalogRow extends WorkLouderCodexTaskOption {
  pinnedAt: number | null;
}

export interface WorkLouderCodexTaskCatalog {
  recent: WorkLouderCodexTaskOption[];
  pinned: WorkLouderCodexTaskOption[];
  options: WorkLouderCodexTaskOption[];
}

/** Keeps database recency order unchanged and caps the keyboard projection at six tasks. */
export function selectWorkLouderCodexRecentTaskSlots(
  rows: readonly WorkLouderCodexTaskSlotRow[],
): string[] {
  return rows.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT).map((row) => row.id);
}

/** Reads the active task catalog used by recent, pinned, priority, and custom modes. */
export async function listWorkLouderCodexTaskCatalog(
  db: DbClient['drizzle'] = getDbClient().drizzle,
): Promise<WorkLouderCodexTaskCatalog> {
  const visibleActiveTask = and(
    eq(sessions.status, 'active'),
    inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
    or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
  );
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      pinnedAt: sessions.pinnedAt,
    })
    .from(sessions)
    .where(visibleActiveTask)
    .orderBy(desc(sql`COALESCE(${sessions.userSendAt}, ${sessions.updatedAt})`), desc(sessions.id))
    .limit(TASK_OPTION_LIMIT);

  const catalogRows: WorkLouderCodexTaskCatalogRow[] = rows.map((row) => ({
    id: row.id,
    title: row.title,
    pinned: row.pinnedAt !== null,
    pinnedAt: row.pinnedAt,
  }));
  const recent = catalogRows.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT).map(stripPinnedAt);
  const pinned = sortPinnedRows(catalogRows.filter((row) => row.pinned)).map(stripPinnedAt);
  return {
    recent,
    pinned: pinned.slice(0, WORKLOUDER_CODEX_AGENT_SLOT_COUNT),
    options: catalogRows.map(stripPinnedAt),
  };
}

/** Backward-compatible recent-slot reader used by older controller tests. */
export async function listWorkLouderCodexTaskSlots(
  db: DbClient['drizzle'] = getDbClient().drizzle,
): Promise<string[]> {
  const catalog = await listWorkLouderCodexTaskCatalog(db);
  return catalog.recent.map((task) => task.id);
}

function sortPinnedRows(rows: WorkLouderCodexTaskCatalogRow[]): WorkLouderCodexTaskCatalogRow[] {
  let manualOrder: readonly string[] = [];
  try {
    const snapshot = loadSidebarSettingsSnapshot();
    if (snapshot.pinnedOrderIsAuthoritative) manualOrder = snapshot.pinnedOrder;
  } catch {
    // Account startup may briefly make the owner-scoped sidebar store unavailable.
  }
  const rank = new Map(manualOrder.map((id, index) => [id, index] as const));
  return rows.toSorted((left, right) => {
    const leftRank = rank.get(left.id);
    const rightRank = rank.get(right.id);
    if (leftRank !== undefined || rightRank !== undefined) {
      if (leftRank === undefined) return 1;
      if (rightRank === undefined) return -1;
      return leftRank - rightRank;
    }
    return (right.pinnedAt ?? 0) - (left.pinnedAt ?? 0);
  });
}

function stripPinnedAt(row: WorkLouderCodexTaskCatalogRow): WorkLouderCodexTaskOption {
  return { id: row.id, title: row.title, pinned: row.pinned };
}
