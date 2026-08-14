import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';

import { DESKTOP_VISIBLE_SESSION_SOURCES } from '../../shared/sessionSource.js';
import { normalizeWorkingDirForGrouping } from '../../shared/workingDir.js';
import { getDbClient } from '../localDb/client/current';
import { sessions } from '../localDb/schema';

export function deriveAllowedSkillhubProjectRoots(
  workingDirs: readonly (string | null)[],
): string[] {
  return [...new Set(
    workingDirs
      .map((workingDir) => normalizeWorkingDirForGrouping(workingDir))
      .filter((workingDir): workingDir is string => workingDir !== null),
  )];
}

/**
 * Project roots that Main currently owns through active local project sessions.
 * Renderer-provided SkillHub scan requests must be a subset of this catalogue.
 */
export async function listAllowedSkillhubProjectRoots(): Promise<string[]> {
  const rows = await getDbClient().drizzle
    .select({ workingDir: sessions.workingDir })
    .from(sessions)
    .where(
      and(
        inArray(sessions.source, DESKTOP_VISIBLE_SESSION_SOURCES),
        eq(sessions.status, 'active'),
        eq(sessions.workspaceKind, 'project'),
        isNotNull(sessions.workingDir),
        isNull(sessions.remoteHostId),
      ),
    );

  return deriveAllowedSkillhubProjectRoots(rows.map((row) => row.workingDir));
}
