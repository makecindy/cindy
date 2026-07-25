import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import type { SendOrigin } from '@cindy/maker-core';
import type { HeadlessSessionEvent, HeadlessSessionEventSource, HeadlessSessionEventStorage, HeadlessSessionMeta, HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';

type OrcaStorage = HeadlessSessionStorageContract & HeadlessSessionEventStorage & Partial<HeadlessSessionEventSource>;
export type HeadlessOrcaWorkerStatus = 'idle' | 'running' | 'done' | 'error' | 'archived';

export interface HeadlessOrcaWorker {
  id: string;
  teamId: string;
  sessionId: string;
  label: string;
  role: string;
  status: HeadlessOrcaWorkerStatus;
  focused: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface HeadlessOrcaTeam {
  id: string;
  leadSessionId: string;
  status: 'active' | 'ended';
  createdAt: number;
  updatedAt: number;
}

/**
 * Durable, Electron-free Orca coordinator.  It deliberately delegates every
 * worker turn to the normal headless runtime, preserving its per-session
 * serialization and host-wide four-turn budget.
 */
export class HeadlessOrcaService {
  private readonly db: Database.Database;
  private readonly stopEvents?: () => void;

  constructor(
    databaseFile: string,
    private readonly sessions: OrcaStorage,
    private readonly runtime: HeadlessSessionRuntime,
  ) {
    fs.mkdirSync(path.dirname(databaseFile), { recursive: true, mode: 0o700 });
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_orca_teams (
        id TEXT PRIMARY KEY,
        lead_session_id TEXT NOT NULL,
        status TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      );
      CREATE UNIQUE INDEX IF NOT EXISTS headless_orca_active_team_by_lead
        ON headless_orca_teams(lead_session_id) WHERE status = 'active';
      CREATE TABLE IF NOT EXISTS headless_orca_workers (
        id TEXT PRIMARY KEY,
        team_id TEXT NOT NULL,
        session_id TEXT NOT NULL UNIQUE,
        label TEXT NOT NULL,
        role TEXT NOT NULL,
        status TEXT NOT NULL,
        focused INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        UNIQUE(team_id, label COLLATE NOCASE)
      );
    `);
    if (sessions.onEvent) this.stopEvents = sessions.onEvent((event) => { void this.observeEvent(event); });
  }

  close(): void {
    this.stopEvents?.();
    this.db.close();
  }

  async startTeam(leadSessionId: string): Promise<HeadlessOrcaTeam> {
    const lead = await this.requireSession(leadSessionId);
    if (lead.orcaRole === 'worker') throw new Error('An Orca worker cannot start a team');
    const existing = this.activeTeam(leadSessionId);
    if (existing) return existing;
    const now = Date.now();
    const team: HeadlessOrcaTeam = { id: randomUUID(), leadSessionId, status: 'active', createdAt: now, updatedAt: now };
    this.db.prepare('INSERT INTO headless_orca_teams (id, lead_session_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(team.id, team.leadSessionId, team.status, now, now);
    await this.sessions.update(leadSessionId, { orcaRole: 'lead' });
    await this.runtime.setOrcaRole(leadSessionId, 'lead');
    await this.sessions.appendEvent(leadSessionId, 'orca_team_changed', { team });
    return team;
  }

  getTeam(leadSessionId: string): HeadlessOrcaTeam | null {
    return this.activeTeam(leadSessionId);
  }

  listWorkers(leadSessionId: string): HeadlessOrcaWorker[] {
    const team = this.activeTeam(leadSessionId);
    return team ? this.workersByTeam(team.id) : [];
  }

  async createWorker(input: {
    leadSessionId: string;
    label: string;
    role: string;
    agentKind?: HeadlessSessionMeta['agentKind'];
    providerId?: string;
    model?: string;
    effort?: HeadlessSessionMeta['effort'];
    initialTask?: string;
  }): Promise<HeadlessOrcaWorker> {
    const team = await this.startTeam(input.leadSessionId);
    const lead = await this.requireSession(input.leadSessionId);
    const label = requiredLabel(input.label);
    const role = requiredText(input.role, 'role');
    if (this.db.prepare('SELECT 1 FROM headless_orca_workers WHERE team_id = ? AND label = ? COLLATE NOCASE').get(team.id, label)) {
      throw new Error(`An Orca worker named '${label}' already exists in this team`);
    }
    const workerSessionId = randomUUID();
    const workerSession = await this.sessions.create({
      id: workerSessionId,
      agentKind: input.agentKind ?? lead.agentKind,
      providerId: input.providerId ?? lead.providerId,
      workDir: lead.workDir,
      workspaceKind: lead.workspaceKind,
      title: `[Orca:${label}] ${role}`,
      model: input.model ?? lead.model,
      effort: input.effort ?? lead.effort,
      permissionMode: lead.permissionMode ?? 'ask',
      fastMode: lead.fastMode === true,
      parentSessionId: lead.id,
      orcaRole: 'worker',
    });
    const now = Date.now();
    const worker: HeadlessOrcaWorker = {
      id: randomUUID(), teamId: team.id, sessionId: workerSessionId, label, role,
      status: 'idle', focused: this.workersByTeam(team.id).length === 0, createdAt: now, updatedAt: now,
    };
    if (worker.focused) this.db.prepare('UPDATE headless_orca_workers SET focused = 0 WHERE team_id = ?').run(team.id);
    this.db.prepare(`INSERT INTO headless_orca_workers
      (id, team_id, session_id, label, role, status, focused, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(worker.id, team.id, worker.sessionId, worker.label, worker.role, worker.status, worker.focused ? 1 : 0, now, now);
    await this.sessions.appendEvent(worker.sessionId, 'session_created', { session: workerSession, origin: { kind: 'orca', leadSessionId: lead.id } });
    await this.publishWorkerChange(team.leadSessionId, worker);
    if (input.initialTask?.trim()) await this.sendToWorker(input.leadSessionId, worker.id, input.initialTask);
    return this.getWorker(worker.id)!;
  }

  async sendToWorker(leadSessionId: string, workerRef: string, content: string): Promise<{ worker: HeadlessOrcaWorker; accepted: true }> {
    const worker = this.resolveWorker(leadSessionId, workerRef);
    if (worker.status === 'archived') throw new Error('Worker is archived');
    const meta = await this.requireSession(worker.sessionId);
    await this.runtime.send(meta, content, { kind: 'orca', leadSessionId } as unknown as SendOrigin);
    const updated = await this.setWorkerStatus(worker, 'running');
    return { worker: updated, accepted: true };
  }

  async idleWorker(leadSessionId: string, workerRef: string): Promise<HeadlessOrcaWorker> {
    const worker = this.resolveWorker(leadSessionId, workerRef);
    if (this.runtime.isSessionBusy(worker.sessionId)) await this.runtime.abort(worker.sessionId);
    return this.setWorkerStatus(worker, 'idle');
  }

  async archiveWorker(leadSessionId: string, workerRef: string): Promise<HeadlessOrcaWorker> {
    const worker = this.resolveWorker(leadSessionId, workerRef);
    if (this.runtime.isSessionBusy(worker.sessionId)) await this.runtime.abort(worker.sessionId);
    return this.setWorkerStatus(worker, 'archived');
  }

  async switchFocus(leadSessionId: string, workerRef: string): Promise<HeadlessOrcaWorker> {
    const worker = this.resolveWorker(leadSessionId, workerRef);
    const now = Date.now();
    const tx = this.db.transaction(() => {
      this.db.prepare('UPDATE headless_orca_workers SET focused = 0, updated_at = ? WHERE team_id = ?').run(now, worker.teamId);
      this.db.prepare('UPDATE headless_orca_workers SET focused = 1, updated_at = ? WHERE id = ?').run(now, worker.id);
    });
    tx();
    const next = this.getWorker(worker.id)!;
    await this.publishWorkerChange(leadSessionId, next);
    return next;
  }

  async endTeam(leadSessionId: string): Promise<{ ended: boolean }> {
    const team = this.activeTeam(leadSessionId);
    if (!team) return { ended: false };
    for (const worker of this.workersByTeam(team.id)) {
      if (this.runtime.isSessionBusy(worker.sessionId)) await this.runtime.abort(worker.sessionId).catch(() => undefined);
      await this.setWorkerStatus(worker, 'archived');
    }
    const now = Date.now();
    this.db.prepare("UPDATE headless_orca_teams SET status = 'ended', updated_at = ? WHERE id = ?").run(now, team.id);
    await this.sessions.update(leadSessionId, { orcaRole: undefined });
    await this.runtime.setOrcaRole(leadSessionId, null);
    await this.sessions.appendEvent(leadSessionId, 'orca_team_changed', { teamId: team.id, status: 'ended' });
    return { ended: true };
  }

  private async observeEvent(event: HeadlessSessionEvent): Promise<void> {
    if (event.type !== 'agent_event') return;
    const worker = this.workerBySession(event.sessionId);
    if (!worker || worker.status === 'archived') return;
    const agent = event.data && typeof event.data === 'object' ? event.data as { type?: unknown; data?: unknown } : null;
    if (agent?.type === 'done') await this.setWorkerStatus(worker, 'done');
    if (agent?.type === 'error') await this.setWorkerStatus(worker, 'error');
  }

  private async setWorkerStatus(worker: HeadlessOrcaWorker, status: HeadlessOrcaWorkerStatus): Promise<HeadlessOrcaWorker> {
    if (worker.status === status) return worker;
    const now = Date.now();
    this.db.prepare('UPDATE headless_orca_workers SET status = ?, updated_at = ? WHERE id = ?').run(status, now, worker.id);
    const next = this.getWorker(worker.id)!;
    const team = this.teamById(worker.teamId);
    if (team) await this.publishWorkerChange(team.leadSessionId, next);
    return next;
  }

  private async publishWorkerChange(leadSessionId: string, worker: HeadlessOrcaWorker): Promise<void> {
    await this.sessions.appendEvent(leadSessionId, 'orca_worker_changed', { leadSessionId, worker });
  }

  private resolveWorker(leadSessionId: string, workerRef: string): HeadlessOrcaWorker {
    const team = this.activeTeam(leadSessionId);
    if (!team) throw new Error('No active Orca team for this session');
    const worker = this.db.prepare(`SELECT * FROM headless_orca_workers
      WHERE team_id = ? AND (id = ? OR session_id = ? OR label = ? COLLATE NOCASE) LIMIT 1`).get(team.id, workerRef, workerRef, workerRef) as WorkerRow | undefined;
    if (!worker) throw new Error(`Unknown Orca worker: ${workerRef}`);
    return toWorker(worker);
  }

  private activeTeam(leadSessionId: string): HeadlessOrcaTeam | null {
    const row = this.db.prepare("SELECT * FROM headless_orca_teams WHERE lead_session_id = ? AND status = 'active' LIMIT 1").get(leadSessionId) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  private teamById(id: string): HeadlessOrcaTeam | null {
    const row = this.db.prepare('SELECT * FROM headless_orca_teams WHERE id = ?').get(id) as TeamRow | undefined;
    return row ? toTeam(row) : null;
  }

  private workersByTeam(teamId: string): HeadlessOrcaWorker[] {
    return (this.db.prepare('SELECT * FROM headless_orca_workers WHERE team_id = ? ORDER BY created_at').all(teamId) as WorkerRow[]).map(toWorker);
  }

  private workerBySession(sessionId: string): HeadlessOrcaWorker | null {
    const row = this.db.prepare('SELECT * FROM headless_orca_workers WHERE session_id = ? LIMIT 1').get(sessionId) as WorkerRow | undefined;
    return row ? toWorker(row) : null;
  }

  private getWorker(id: string): HeadlessOrcaWorker | null {
    const row = this.db.prepare('SELECT * FROM headless_orca_workers WHERE id = ?').get(id) as WorkerRow | undefined;
    return row ? toWorker(row) : null;
  }

  private async requireSession(id: string): Promise<HeadlessSessionMeta> {
    const session = await this.sessions.get(id);
    if (!session) throw new Error(`Unknown session: ${id}`);
    return session;
  }
}

type TeamRow = { id: string; lead_session_id: string; status: 'active' | 'ended'; created_at: number; updated_at: number };
type WorkerRow = { id: string; team_id: string; session_id: string; label: string; role: string; status: HeadlessOrcaWorkerStatus; focused: number; created_at: number; updated_at: number };
const toTeam = (row: TeamRow): HeadlessOrcaTeam => ({ id: row.id, leadSessionId: row.lead_session_id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at });
const toWorker = (row: WorkerRow): HeadlessOrcaWorker => ({ id: row.id, teamId: row.team_id, sessionId: row.session_id, label: row.label, role: row.role, status: row.status, focused: row.focused === 1, createdAt: row.created_at, updatedAt: row.updated_at });
function requiredText(value: string, name: string): string { if (!value?.trim()) throw new Error(`${name} must be non-empty`); return value.trim(); }
function requiredLabel(value: string): string { const label = requiredText(value, 'label'); if (label.length > 64) throw new Error('label must be at most 64 characters'); return label; }
