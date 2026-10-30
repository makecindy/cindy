import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';

export interface NativeSessionScope {
  workspaceKind?: 'project' | 'dialogue';
  extraDirs?: string[];
  writableDirs?: string[];
}

/** CLI metadata has no knowledge of Cindy archive and project choices. Overlay
 * only local, non-deleted tasks from the currently bound database; never infer
 * extra-directory permissions from a transcript's cwd.
 */
export async function projectNativeSessionMetadata<T extends { id: string; cwd: string; archived: boolean }>(
  agentKind: 'cc' | 'codex', candidates: T[],
): Promise<Array<T & NativeSessionScope>> {
  const snapshot = getCurrentDbClientSnapshot();
  if (!snapshot || candidates.length === 0) return candidates;
  type Row = { sdkSessionId: string; status: string; workingDir: string | null;
    workspaceKind: 'project' | 'dialogue'; extraDirs: string; writableDirs: string };
  const byId = new Map<string, Row>();
  const ids = [...new Set(candidates.map(candidate => candidate.id))];
  for (let offset = 0; offset < ids.length; offset += 200) {
    const batch = ids.slice(offset, offset + 200);
    const rows = await snapshot.client.query<Row>(`SELECT sdk_session_id AS sdkSessionId,
      status, working_dir AS workingDir, workspace_kind AS workspaceKind,
      extra_dirs AS extraDirs, writable_dirs AS writableDirs FROM sessions
      WHERE agent_kind = ? AND remote_host_id IS NULL AND status IN ('active', 'archived')
      AND sdk_session_id IN (${batch.map(() => '?').join(',')})
      ORDER BY CASE status WHEN 'active' THEN 0 ELSE 1 END, updated_at DESC, id`, [agentKind, ...batch]);
    if (getCurrentDbClientSnapshot() !== snapshot) throw new Error('Native session metadata owner changed');
    for (const row of rows) if (!byId.has(row.sdkSessionId)) byId.set(row.sdkSessionId, row);
  }
  return candidates.map(candidate => {
    const row = byId.get(candidate.id);
    return row ? { ...candidate, archived: row.status === 'archived', cwd: row.workingDir ?? candidate.cwd,
      workspaceKind: row.workspaceKind, extraDirs: parseDirs(row.extraDirs), writableDirs: parseDirs(row.writableDirs) } : candidate;
  });
}

function parseDirs(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    return Array.isArray(value) && value.every(item => typeof item === 'string') ? value : [];
  } catch { return []; }
}
