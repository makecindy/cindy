import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';

import type { DbClient } from '../localDb/client/DbClient.js';
import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import {
  WORKLOUDER_CODEX_AGENT_SLOT_COUNT,
  WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS,
  type WorkLouderCodexTaskOption,
} from '../../shared/workLouderCodex.js';

const KEYBOARD_TASK_SLOT_LIMIT = WORKLOUDER_CREATOR_PROGRAMMABLE_KEYS.length;

export const WORKLOUDER_CODEX_TASK_OPTION_LIMIT = 100;
const TASK_OPTION_LIMIT = WORKLOUDER_CODEX_TASK_OPTION_LIMIT;

export interface WorkLouderCodexTaskSlotRow {
  id: string;
}

interface WorkLouderCodexTaskCatalogRow extends WorkLouderCodexTaskOption {
  pinnedAt: number | null;
  userSendAt: number | null;
}

export interface WorkLouderCodexTaskCatalog {
  sidebar: WorkLouderCodexTaskOption[];
  lastSent: WorkLouderCodexTaskOption[];
  options: WorkLouderCodexTaskOption[];
}

/** Keeps database recency order unchanged and caps the keyboard projection at the board size. */
export function selectWorkLouderCodexRecentTaskSlots(
  rows: readonly WorkLouderCodexTaskSlotRow[],
): string[] {
  return rows.slice(0, KEYBOARD_TASK_SLOT_LIMIT).map((row) => row.id);
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
      userSendAt: sessions.userSendAt,
    })
    .from(sessions)
    .where(visibleActiveTask)
    .orderBy(desc(sql`COALESCE(${sessions.userSendAt}, ${sessions.updatedAt})`), desc(sessions.id))
    .limit(TASK_OPTION_LIMIT);

  return buildWorkLouderCodexTaskCatalog(
    rows.map((row) => ({
      id: row.id,
      title: row.title,
      pinnedAt: row.pinnedAt,
      userSendAt: row.userSendAt,
    })),
  );
}

/** One task as the keyboard needs to see it, already in display order. */
export interface WorkLouderCodexTaskCatalogInput {
  id: string;
  title: string | null;
  pinnedAt: number | null;
  userSendAt: number | null;
  sidebarOrder?: number;
  catalogEligible?: boolean;
}

/**
 * Shape an ordered task list into the catalog the keyboard projects from.
 *
 * Split out from the database query because the rows can also come from the
 * renderer: tasks on a linked machine live only in its store, so reading the
 * local table alone leaves the agent keys empty on a machine that is driving
 * someone else's sessions.
 */
export function buildWorkLouderCodexTaskCatalog(
  rows: readonly WorkLouderCodexTaskCatalogInput[],
  options: { publishedVisibleOrder?: boolean } = {},
): WorkLouderCodexTaskCatalog {
  const publishedRows: WorkLouderCodexTaskCatalogRow[] = rows.slice(0, TASK_OPTION_LIMIT).map((row) => ({
    id: row.id,
    // An untitled task still gets a key; the UI supplies its own placeholder.
    title: row.title,
    pinned: row.pinnedAt !== null,
    pinnedAt: row.pinnedAt,
    userSendAt: row.userSendAt,
  }));
  const catalogRows = publishedRows.filter((_, index) => rows[index]?.catalogEligible !== false);
  const byPublishedId = new Map(publishedRows.map((row) => [row.id, row] as const));
  const visibleOrder = rows
    .filter((row) => row.sidebarOrder !== undefined)
    .toSorted((left, right) => (left.sidebarOrder ?? 0) - (right.sidebarOrder ?? 0));
  // Local database rows have no sidebarOrder. A renderer publication does:
  // even an empty visible list must stay empty, otherwise a machine filter
  // or sidebar search would light keys for tasks the user cannot see.
  const publishedVisibleRows = visibleOrder.flatMap((item) => {
    const row = byPublishedId.get(item.id);
    return row ? [row] : [];
  });
  const sidebarSource =
    options.publishedVisibleOrder || visibleOrder.length > 0 ? publishedVisibleRows : catalogRows;
  const sidebar = sidebarSource.slice(0, KEYBOARD_TASK_SLOT_LIMIT).map(toTaskOption);
  const lastSent = sortLastSentRows(catalogRows)
    .slice(0, KEYBOARD_TASK_SLOT_LIMIT)
    .map(toTaskOption);
  return {
    sidebar,
    lastSent,
    options: catalogRows.map(toTaskOption),
  };
}

/** Backward-compatible recent-slot reader used by older controller tests. */
export async function listWorkLouderCodexTaskSlots(
  db: DbClient['drizzle'] = getDbClient().drizzle,
): Promise<string[]> {
  const catalog = await listWorkLouderCodexTaskCatalog(db);
  return catalog.sidebar.map((task) => task.id);
}

function sortLastSentRows(rows: WorkLouderCodexTaskCatalogRow[]): WorkLouderCodexTaskCatalogRow[] {
  return rows.toSorted((left, right) => {
    const leftSent = left.userSendAt ?? 0;
    const rightSent = right.userSendAt ?? 0;
    if (rightSent !== leftSent) return rightSent - leftSent;
    return right.id.localeCompare(left.id);
  });
}

function toTaskOption(row: WorkLouderCodexTaskCatalogRow): WorkLouderCodexTaskOption {
  return { id: row.id, title: row.title, pinned: row.pinned };
}
