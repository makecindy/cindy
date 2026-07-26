import Database from 'better-sqlite3';
import type { ListFilter, Schedule, ScheduleRun, ScheduleStorage } from '@cindy/maker-scheduler';

/**
 * Small SQLite adapter for the shared Scheduler engine. JSON keeps this new
 * Linux-only store forward-compatible with Scheduler fields while indexed
 * state columns preserve atomic due-fire claiming and stale-run recovery.
 */
export class HeadlessScheduleStorage implements ScheduleStorage {
  private readonly db: Database.Database;

  constructor(databaseFile: string) {
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_schedules (
        id TEXT PRIMARY KEY,
        status TEXT NOT NULL,
        next_fire_at INTEGER,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS headless_schedules_due ON headless_schedules(status, next_fire_at);
      CREATE TABLE IF NOT EXISTS headless_schedule_runs (
        id TEXT PRIMARY KEY,
        schedule_id TEXT NOT NULL,
        status TEXT NOT NULL,
        fired_at INTEGER NOT NULL,
        heartbeat_at INTEGER,
        payload_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS headless_schedule_runs_by_schedule ON headless_schedule_runs(schedule_id, fired_at DESC);
      CREATE INDEX IF NOT EXISTS headless_schedule_runs_running ON headless_schedule_runs(status, heartbeat_at, fired_at);
    `);
  }

  async list(filter?: ListFilter): Promise<Schedule[]> {
    const rows = filter?.status
      ? this.db.prepare('SELECT payload_json FROM headless_schedules WHERE status = ? ORDER BY json_extract(payload_json, \'$.updatedAt\') DESC').all(filter.status)
      : this.db.prepare('SELECT payload_json FROM headless_schedules ORDER BY json_extract(payload_json, \'$.updatedAt\') DESC').all();
    return rows.map((row) => scheduleFromJson((row as { payload_json: string }).payload_json));
  }

  async listActive(): Promise<Schedule[]> { return this.list({ status: 'active' }); }

  async get(id: string): Promise<Schedule | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_schedules WHERE id = ?').get(id) as { payload_json: string } | undefined;
    return row ? scheduleFromJson(row.payload_json) : null;
  }

  async insert(schedule: Schedule): Promise<Schedule> {
    this.db.prepare('INSERT INTO headless_schedules (id, status, next_fire_at, payload_json) VALUES (?, ?, ?, ?)')
      .run(schedule.id, schedule.status, schedule.nextFireAt ?? null, JSON.stringify(schedule));
    return schedule;
  }

  async update(id: string, patch: Partial<Schedule>): Promise<Schedule | null> {
    const current = await this.get(id);
    if (!current) return null;
    const next = { ...current, ...patch } as Schedule;
    this.db.prepare('UPDATE headless_schedules SET status = ?, next_fire_at = ?, payload_json = ? WHERE id = ?')
      .run(next.status, next.nextFireAt ?? null, JSON.stringify(next), id);
    return next;
  }

  async delete(id: string): Promise<void> {
    const transaction = this.db.transaction((scheduleId: string) => {
      this.db.prepare('DELETE FROM headless_schedule_runs WHERE schedule_id = ?').run(scheduleId);
      this.db.prepare('DELETE FROM headless_schedules WHERE id = ?').run(scheduleId);
    });
    transaction(id);
  }

  async claimDueFire(id: string, expectedNextFireAt: number): Promise<Schedule | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_schedules WHERE id = ? AND status = ? AND next_fire_at = ?')
      .get(id, 'active', expectedNextFireAt) as { payload_json: string } | undefined;
    if (!row) return null;
    const next = { ...scheduleFromJson(row.payload_json), nextFireAt: undefined };
    const result = this.db.prepare(`
      UPDATE headless_schedules SET next_fire_at = NULL, payload_json = ?
      WHERE id = ? AND status = ? AND next_fire_at = ?
    `).run(JSON.stringify(next), id, 'active', expectedNextFireAt);
    return result.changes === 1 ? next : null;
  }

  async insertRun(run: ScheduleRun): Promise<ScheduleRun> {
    this.db.prepare('INSERT INTO headless_schedule_runs (id, schedule_id, status, fired_at, heartbeat_at, payload_json) VALUES (?, ?, ?, ?, ?, ?)')
      .run(run.id, run.scheduleId, run.status, run.firedAt, run.heartbeatAt ?? null, JSON.stringify(run));
    return run;
  }

  async updateRun(id: string, patch: Partial<ScheduleRun>): Promise<ScheduleRun | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_schedule_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    const next = { ...runFromJson(row.payload_json), ...patch } as ScheduleRun;
    this.db.prepare('UPDATE headless_schedule_runs SET status = ?, heartbeat_at = ?, payload_json = ? WHERE id = ?')
      .run(next.status, next.heartbeatAt ?? null, JSON.stringify(next), id);
    return next;
  }

  async listRuns(scheduleId: string, limit = 100): Promise<ScheduleRun[]> {
    const safeLimit = Math.max(1, Math.min(1_000, Math.floor(limit)));
    const rows = this.db.prepare('SELECT payload_json FROM headless_schedule_runs WHERE schedule_id = ? ORDER BY fired_at DESC LIMIT ?')
      .all(scheduleId, safeLimit) as Array<{ payload_json: string }>;
    return rows.map((row) => runFromJson(row.payload_json));
  }

  async deleteRun(id: string): Promise<ScheduleRun | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_schedule_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    this.db.prepare('DELETE FROM headless_schedule_runs WHERE id = ?').run(id);
    return runFromJson(row.payload_json);
  }

  /**
   * Keep the read marker with the durable run record so the mobile badge does
   * not reappear after the daemon restarts.  Running work is deliberately not
   * marked read: it has not produced a result for the user to acknowledge.
   */
  async markRunRead(id: string): Promise<string | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_schedule_runs WHERE id = ?').get(id) as { payload_json: string } | undefined;
    if (!row) return null;
    const current = runFromJson(row.payload_json);
    if (current.status === 'running' || current.readAt !== undefined) return null;
    const next: ScheduleRun = { ...current, readAt: Date.now() };
    this.db.prepare('UPDATE headless_schedule_runs SET payload_json = ? WHERE id = ?')
      .run(JSON.stringify(next), id);
    return next.scheduleId;
  }

  /** Mark all completed history entries for one automation as read. */
  async markScheduleRunsRead(scheduleId: string): Promise<number> {
    const rows = this.db.prepare('SELECT id, payload_json FROM headless_schedule_runs WHERE schedule_id = ?')
      .all(scheduleId) as Array<{ id: string; payload_json: string }>;
    const now = Date.now();
    let updated = 0;
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        const current = runFromJson(row.payload_json);
        if (current.status === 'running' || current.readAt !== undefined) continue;
        const next: ScheduleRun = { ...current, readAt: now };
        this.db.prepare('UPDATE headless_schedule_runs SET payload_json = ? WHERE id = ?')
          .run(JSON.stringify(next), row.id);
        updated += 1;
      }
    });
    transaction();
    return updated;
  }

  async markRunningAsInterrupted(staleBefore: number, excludeRunIds: readonly string[] = [], opts?: { legacyStaleBefore?: number }): Promise<string[]> {
    const rows = this.db.prepare('SELECT id, payload_json FROM headless_schedule_runs WHERE status = ?').all('running') as Array<{ id: string; payload_json: string }>;
    const excluded = new Set(excludeRunIds);
    const affected = new Set<string>();
    const transaction = this.db.transaction(() => {
      for (const row of rows) {
        if (excluded.has(row.id)) continue;
        const current = runFromJson(row.payload_json);
        const threshold = current.heartbeatAt === undefined ? (opts?.legacyStaleBefore ?? staleBefore) : staleBefore;
        const observed = current.heartbeatAt ?? current.firedAt;
        if (observed >= threshold) continue;
        const next: ScheduleRun = { ...current, status: 'interrupted', finishedAt: Date.now(), errorMsg: 'interrupted by daemon restart' };
        const result = this.db.prepare('UPDATE headless_schedule_runs SET status = ?, heartbeat_at = ?, payload_json = ? WHERE id = ? AND status = ?')
          .run(next.status, next.heartbeatAt ?? null, JSON.stringify(next), row.id, 'running');
        if (result.changes) affected.add(next.scheduleId);
      }
    });
    transaction();
    return [...affected];
  }

  async touchRunHeartbeats(runIds: readonly string[], heartbeatAt: number): Promise<void> {
    for (const id of runIds) {
      const row = this.db.prepare('SELECT payload_json FROM headless_schedule_runs WHERE id = ? AND status = ?').get(id, 'running') as { payload_json: string } | undefined;
      if (!row) continue;
      const next = { ...runFromJson(row.payload_json), heartbeatAt };
      this.db.prepare('UPDATE headless_schedule_runs SET heartbeat_at = ?, payload_json = ? WHERE id = ? AND status = ?')
        .run(heartbeatAt, JSON.stringify(next), id, 'running');
    }
  }

  async hasRunningRuns(scheduleId?: string): Promise<boolean> {
    const row = scheduleId
      ? this.db.prepare('SELECT 1 FROM headless_schedule_runs WHERE status = ? AND schedule_id = ? LIMIT 1').get('running', scheduleId)
      : this.db.prepare('SELECT 1 FROM headless_schedule_runs WHERE status = ? LIMIT 1').get('running');
    return !!row;
  }

  close(): void { this.db.close(); }
}

function scheduleFromJson(value: string): Schedule { return JSON.parse(value) as Schedule; }
function runFromJson(value: string): ScheduleRun { return JSON.parse(value) as ScheduleRun; }
