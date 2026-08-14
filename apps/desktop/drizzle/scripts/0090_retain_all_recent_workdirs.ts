import type Database from 'better-sqlite3';

function canonicalize(raw: string, platform: NodeJS.Platform): string | null {
  void platform;
  let path = raw.trim().replace(/\\/g, '/');
  while (path.length > 1 && path.endsWith('/')) {
    if (/^[A-Za-z]:\/$/.test(path)) break;
    path = path.slice(0, -1);
  }
  if (path.includes('/.cindy-worktrees/') || path.includes('/.xdt-worktrees/')) {
    return null;
  }
  return path || null;
}

function comparisonIdentity(path: string, platform: NodeJS.Platform): string {
  if (platform === 'win32' && (/^[A-Za-z]:\//.test(path) || path.startsWith('//'))) {
    return path.toLowerCase();
  }
  return path;
}

function runForPlatform(db: Database.Database, platform: NodeJS.Platform): void {
  const recentColumns = db.prepare('PRAGMA table_info(recent_workdirs)').all() as Array<{
    name: string;
  }>;
  if (recentColumns.length === 0) return;

  const merged = new Map<string, { path: string; timestamp: number }>();
  const merge = (rawPath: string, timestamp: number): void => {
    const path = canonicalize(rawPath, platform);
    if (!path) return;
    const identity = comparisonIdentity(path, platform);
    const previous = merged.get(identity);
    if (previous === undefined || timestamp > previous.timestamp) {
      merged.set(identity, { path, timestamp });
    }
  };
  const existingRows = db
    .prepare('SELECT path, last_used_at AS ts FROM recent_workdirs')
    .all() as Array<{ path: string; ts: number }>;
  for (const row of existingRows) merge(row.path, row.ts);

  const sessionColumns = new Set(
    (db.prepare('PRAGMA table_info(sessions)').all() as Array<{ name: string }>).map(
      (column) => column.name,
    ),
  );
  // Missing/unknown provenance must not turn automation workdirs into durable user projects.
  // `source` predates every supported runtime schema, but sparse replay fixtures may omit it.
  if (sessionColumns.has('working_dir') && sessionColumns.has('source')) {
    const timestampColumns = ['user_send_at', 'updated_at', 'created_at'].filter((column) =>
      sessionColumns.has(column),
    );
    const timestampExpression =
      timestampColumns.length > 0 ? `COALESCE(${timestampColumns.join(', ')}, 0)` : '0';
    const predicates = ['working_dir IS NOT NULL', "TRIM(working_dir) != ''"];
    predicates.push("source IN ('desktop', 'plugin')");
    if (sessionColumns.has('workspace_kind')) predicates.push("workspace_kind = 'project'");
    if (sessionColumns.has('remote_host_id')) predicates.push('remote_host_id IS NULL');

    const rows = db
      .prepare(
        `SELECT working_dir AS path,
                ${timestampExpression} AS ts
         FROM sessions
         WHERE ${predicates.join('\n           AND ')}`,
      )
      .all() as Array<{ path: string; ts: number }>;
    for (const row of rows) {
      merge(row.path, typeof row.ts === 'number' && row.ts > 0 ? row.ts : 0);
    }
  }

  db.prepare('DELETE FROM recent_workdirs').run();
  const insert = db.prepare(
    `INSERT INTO recent_workdirs (path, last_used_at) VALUES (?, ?)
     ON CONFLICT(path) DO UPDATE SET
       last_used_at = MAX(recent_workdirs.last_used_at, excluded.last_used_at)`,
  );
  for (const { path, timestamp } of merged.values()) insert.run(path, timestamp);
}

function run(db: Database.Database): void {
  runForPlatform(db, process.platform);
}

module.exports = { run, runForPlatform };
