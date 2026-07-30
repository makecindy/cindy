/** Privacy-minimised recent-session source for session-picker-v1. */

import path from 'node:path';

import { and, desc, eq, inArray, isNull, ne, or, sql } from 'drizzle-orm';
import type { QuerySessionEntry } from '@cindy/slack-hook-protocol';

import { getDbClient } from '../localDb/client/current.js';
import { sessions } from '../localDb/schema.js';
import { HOOK_CHAT_WORKSPACE_ALIAS } from '../../shared/hookControlIpc.js';
import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { isPathWithin } from './paths.js';

const VISIBLE_SESSION_SOURCES = new Set<string>(DESKTOP_VISIBLE_SESSION_SOURCES);
const MAX_SESSION_TITLE_CHARS = 200;

interface RecentSessionRow {
  id: string;
  title: string;
  workingDir: string | null;
  workspaceKind: 'project' | 'dialogue';
  /** Kept as string so legacy/internal database values fail the allowlist closed. */
  source: string;
  userSendAt: number | null;
  updatedAt: number;
}

/** Convert rows without ever returning a local path or conversation content. */
export function minimiseRecentSessions(
  rows: readonly RecentSessionRow[],
  workspaces: Readonly<Record<string, string>>,
): QuerySessionEntry[] {
  const aliases = Object.entries(workspaces).sort((a, b) => b[1].length - a[1].length);
  const result: QuerySessionEntry[] = [];
  for (const row of rows) {
    if (!VISIBLE_SESSION_SOURCES.has(row.source)) continue;
    let workspace: string | null = null;
    if (row.workspaceKind === 'dialogue') {
      workspace = HOOK_CHAT_WORKSPACE_ALIAS;
    } else if (row.workingDir) {
      workspace =
        aliases.find(([, base]) => isPathWithin(path.resolve(base), row.workingDir!))?.[0] ?? null;
    }
    if (!workspace) continue;
    const title = (row.title.trim() || 'Untitled session').slice(0, MAX_SESSION_TITLE_CHARS);
    const lastActiveAt = Math.max(1, Math.trunc(row.userSendAt ?? row.updatedAt));
    result.push({
      id: row.id,
      title,
      workspace,
      lastActiveAt,
    });
    if (result.length === 20) break;
  }
  return result;
}

/** Current account DB is selected by the lifecycle manager before hook ingress opens. */
export async function listRecentHookSessions(
  workspaces: Readonly<Record<string, string>>,
): Promise<QuerySessionEntry[]> {
  const db = getDbClient().drizzle;
  const rows = await db
    .select({
      id: sessions.id,
      title: sessions.title,
      workingDir: sessions.workingDir,
      workspaceKind: sessions.workspaceKind,
      source: sessions.source,
      userSendAt: sessions.userSendAt,
      updatedAt: sessions.updatedAt,
    })
    .from(sessions)
    .where(
      and(
        eq(sessions.status, 'active'),
        isNull(sessions.remoteHostId),
        or(isNull(sessions.orcaRole), ne(sessions.orcaRole, 'worker')),
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
      ),
    )
    .orderBy(desc(sql`COALESCE(${sessions.userSendAt}, ${sessions.updatedAt})`))
    // Fetch extra rows because sessions outside the configured workspace allowlist are removed.
    .limit(100);
  return minimiseRecentSessions(rows, workspaces);
}
