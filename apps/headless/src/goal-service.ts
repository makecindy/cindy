import Database from 'better-sqlite3';
import type { AgentEvent, SendOrigin } from '@cindy/maker-core';
import type { HeadlessSessionEventStorage, HeadlessSessionMeta, HeadlessSessionStorageContract } from './session-types.js';
import type { HeadlessSessionRuntime } from './session-runtime.js';

export type HeadlessGoalStatus = 'active' | 'paused' | 'blocked' | 'complete' | 'budgetLimited' | 'usageLimited';

export interface HeadlessGoalState {
  sessionId: string;
  objective: string;
  status: HeadlessGoalStatus;
  budgetTokens: number | null;
  maxTurns: number | null;
  noProgressLimit: number | null;
  turnsUsed: number;
  tokensUsed: number;
  noProgressStreak: number;
  usageResetAt: number | null;
  lastReason: string | null;
  agentKind: HeadlessSessionMeta['agentKind'];
  startedAt: number;
  updatedAt: number;
}

export type HeadlessGoalStatusPayload = Omit<HeadlessGoalState, 'agentKind' | 'updatedAt'>;

type GoalLimits = Pick<HeadlessGoalState, 'budgetTokens' | 'maxTurns' | 'noProgressLimit'>;
type GoalUpdate = Partial<Pick<HeadlessGoalState, 'objective' | 'budgetTokens' | 'maxTurns' | 'noProgressLimit'>>;

/** Durable, process-independent goal state for the Linux daemon. */
export class HeadlessGoalStorage {
  private readonly db: Database.Database;

  constructor(databaseFile: string) {
    this.db = new Database(databaseFile);
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('busy_timeout = 5000');
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS headless_session_goals (
        session_id TEXT PRIMARY KEY,
        payload_json TEXT NOT NULL
      );
    `);
  }

  async get(sessionId: string): Promise<HeadlessGoalState | null> {
    const row = this.db.prepare('SELECT payload_json FROM headless_session_goals WHERE session_id = ?').get(sessionId) as { payload_json: string } | undefined;
    return row ? goalFromJson(row.payload_json) : null;
  }

  async upsert(goal: HeadlessGoalState): Promise<void> {
    this.db.prepare(`INSERT INTO headless_session_goals (session_id, payload_json) VALUES (?, ?)
      ON CONFLICT(session_id) DO UPDATE SET payload_json = excluded.payload_json`)
      .run(goal.sessionId, JSON.stringify(goal));
  }

  async update(sessionId: string, patch: Partial<HeadlessGoalState>): Promise<HeadlessGoalState | null> {
    const current = await this.get(sessionId);
    if (!current) return null;
    const next = { ...current, ...patch, updatedAt: Date.now() };
    await this.upsert(next);
    return next;
  }

  async clear(sessionId: string): Promise<void> {
    this.db.prepare('DELETE FROM headless_session_goals WHERE session_id = ?').run(sessionId);
  }

  async listActive(): Promise<HeadlessGoalState[]> {
    const rows = this.db.prepare('SELECT payload_json FROM headless_session_goals').all() as Array<{ payload_json: string }>;
    return rows.map((row) => goalFromJson(row.payload_json)).filter((goal) => goal.status === 'active');
  }

  close(): void { this.db.close(); }
}

/**
 * Linux equivalent of Desktop Goal Host.  It derives continuation decisions
 * from durable Agent events and only sends a next goal turn after a terminal
 * event, so a daemon restart cannot create overlapping autonomous turns.
 */
export class HeadlessGoalService {
  private readonly storage: HeadlessGoalStorage;
  private readonly activeTurns = new Map<string, GoalTurn>();
  private unsubscribeEvents: (() => void) | null = null;
  private unsubscribeStarts: (() => void) | null = null;
  private disposed = false;

  constructor(
    databaseFile: string,
    private readonly sessions: HeadlessSessionStorageContract & HeadlessSessionEventStorage,
    private readonly runtime: HeadlessSessionRuntime,
  ) {
    this.storage = new HeadlessGoalStorage(databaseFile);
  }

  async start(): Promise<void> {
    if (this.unsubscribeEvents || this.disposed) return;
    this.unsubscribeEvents = this.runtime.subscribeAgentEvents?.((sessionId, event) => {
      void this.onAgentEvent(sessionId, event);
    }) ?? null;
    this.unsubscribeStarts = this.runtime.subscribeTurnStarts?.((sessionId, origin) => {
      if (origin?.kind !== 'goal') void this.pauseForUserTurn(sessionId);
    }) ?? null;
    // A process restart abandons in-memory vendor work. Active goals resume
    // from their durable objective only after the new daemon is ready.
    for (const goal of await this.storage.listActive()) void this.dispatch(goal.sessionId, 'continuation');
  }

  async stop(): Promise<void> {
    this.disposed = true;
    this.unsubscribeEvents?.();
    this.unsubscribeStarts?.();
    this.unsubscribeEvents = null;
    this.unsubscribeStarts = null;
    this.activeTurns.clear();
    this.storage.close();
  }

  async set(input: { sessionId: string; objective: string; limits?: GoalLimits }): Promise<{ ok: true }> {
    const session = await this.requireSession(input.sessionId);
    const objective = requiredObjective(input.objective);
    const limits = normalizeLimits(input.limits);
    const now = Date.now();
    await this.storage.upsert({
      sessionId: session.id,
      objective,
      status: 'active',
      ...limits,
      turnsUsed: 0,
      tokensUsed: 0,
      noProgressStreak: 0,
      usageResetAt: null,
      lastReason: null,
      agentKind: session.agentKind,
      startedAt: now,
      updatedAt: now,
    });
    await this.publish(session.id);
    void this.dispatch(session.id, 'first');
    return { ok: true };
  }

  async clear(sessionId: string): Promise<{ ok: true }> {
    this.activeTurns.delete(sessionId);
    await this.storage.clear(sessionId);
    await this.sessions.appendEvent(sessionId, 'goal_status', { goal: null });
    return { ok: true };
  }

  async getStatus(sessionId: string): Promise<HeadlessGoalStatusPayload | null> {
    const goal = await this.storage.get(sessionId);
    return goal ? toPayload(goal) : null;
  }

  async pause(sessionId: string, reason = 'paused by user'): Promise<{ ok: true }> {
    this.activeTurns.delete(sessionId);
    const goal = await this.storage.update(sessionId, { status: 'paused', lastReason: reason, usageResetAt: null });
    if (goal) await this.publish(sessionId, goal);
    return { ok: true };
  }

  async resume(sessionId: string): Promise<{ ok: true }> {
    const goal = await this.storage.get(sessionId);
    if (!goal || goal.status === 'complete' || goal.status === 'budgetLimited') return { ok: true };
    const active = await this.storage.update(sessionId, { status: 'active', lastReason: null, usageResetAt: null });
    if (active) {
      await this.publish(sessionId, active);
      void this.dispatch(sessionId, 'continuation');
    }
    return { ok: true };
  }

  async update(sessionId: string, patch: GoalUpdate): Promise<{ ok: true }> {
    const normalized = normalizeUpdate(patch);
    const goal = await this.storage.update(sessionId, normalized);
    if (!goal) throw new Error('goal not found');
    await this.publish(sessionId, goal);
    if (goal.status === 'active') void this.dispatch(sessionId, 'continuation');
    return { ok: true };
  }

  private async pauseForUserTurn(sessionId: string): Promise<void> {
    const goal = await this.storage.get(sessionId);
    if (!goal || goal.status !== 'active') return;
    await this.pause(sessionId, 'paused: user sent a message during the goal');
  }

  private async dispatch(sessionId: string, kind: 'first' | 'continuation'): Promise<void> {
    if (this.disposed || this.activeTurns.has(sessionId)) return;
    const goal = await this.storage.get(sessionId);
    if (!goal || goal.status !== 'active') return;
    if (goal.maxTurns !== null && goal.turnsUsed >= goal.maxTurns) {
      const limited = await this.storage.update(sessionId, { status: 'budgetLimited', lastReason: `max turns reached (${goal.turnsUsed}/${goal.maxTurns})` });
      if (limited) await this.publish(sessionId, limited);
      return;
    }
    if (goal.budgetTokens !== null && goal.tokensUsed >= goal.budgetTokens) {
      const limited = await this.storage.update(sessionId, { status: 'budgetLimited', lastReason: `token budget reached (${goal.tokensUsed}/${goal.budgetTokens})` });
      if (limited) await this.publish(sessionId, limited);
      return;
    }
    const session = await this.requireSession(sessionId);
    if (this.runtime.isSessionBusy(sessionId)) return;
    this.activeTurns.set(sessionId, { finalText: null, sawToolUse: false, tokens: 0, errored: false });
    try {
      const directive = kind === 'first'
        ? firstDirective(goal.objective, goal.maxTurns)
        : continuationDirective(goal.objective, goal.lastReason);
      if (this.runtime.sendGoal) await this.runtime.sendGoal(session, directive, kind === 'first' ? goal.objective : undefined);
      else await this.runtime.send(session, directive, { kind: 'goal' });
    } catch (error) {
      this.activeTurns.delete(sessionId);
      await this.finishTurn(sessionId, { finalText: null, sawToolUse: false, tokens: 0, errored: true, errorMessage: errorMessage(error) });
    }
  }

  private async onAgentEvent(sessionId: string, event: AgentEvent): Promise<void> {
    const turn = this.activeTurns.get(sessionId);
    if (!turn) {
      if (event.type === 'done' && (await this.storage.get(sessionId))?.status === 'active') {
        setTimeout(() => { void this.dispatch(sessionId, 'continuation'); }, 0);
      }
      return;
    }
    if (event.type === 'text') {
      const data = asRecord(event.data);
      if (data?.isFinal === true && typeof data.text === 'string') turn.finalText = data.text;
    }
    if (event.type === 'tool_use') turn.sawToolUse = true;
    if (event.type === 'status' || event.type === 'done') turn.tokens = Math.max(turn.tokens, tokenUsage(event.data));
    if (event.type === 'error') {
      turn.errored = true;
      turn.errorMessage = errorMessage(asRecord(event.data)?.message);
      if (asRecord(event.data)?.isTerminal === true) {
        this.activeTurns.delete(sessionId);
        await this.finishTurn(sessionId, turn);
      }
      return;
    }
    if (event.type === 'done') {
      this.activeTurns.delete(sessionId);
      await this.finishTurn(sessionId, turn);
    }
  }

  private async finishTurn(sessionId: string, turn: GoalTurn): Promise<void> {
    const goal = await this.storage.get(sessionId);
    if (!goal || goal.status !== 'active') return;
    const verdict = parseVerdict(turn.finalText);
    const turnsUsed = goal.turnsUsed + 1;
    const tokensUsed = goal.tokensUsed + turn.tokens;
    let status: HeadlessGoalStatus = 'active';
    let lastReason: string | null = verdict?.reason || null;
    let noProgressStreak = turn.sawToolUse ? 0 : goal.noProgressStreak + 1;
    if (turn.errored) {
      status = usageLimited(turn.errorMessage) ? 'usageLimited' : 'blocked';
      lastReason = turn.errorMessage || (status === 'usageLimited' ? 'usage limit reached' : 'goal turn failed');
    } else if (verdict?.status === 'complete') {
      status = 'complete';
    } else if (verdict?.status === 'blocked') {
      status = 'blocked';
    } else if (goal.budgetTokens !== null && tokensUsed >= goal.budgetTokens) {
      status = 'budgetLimited';
      lastReason = `token budget reached (${tokensUsed}/${goal.budgetTokens})`;
    } else if (goal.maxTurns !== null && turnsUsed >= goal.maxTurns) {
      status = 'budgetLimited';
      lastReason = `max turns reached (${turnsUsed}/${goal.maxTurns})`;
    } else if (goal.noProgressLimit !== null && noProgressStreak >= goal.noProgressLimit) {
      status = 'paused';
      lastReason = `paused: ${noProgressStreak} turns with no tool use`;
    }
    const next = await this.storage.update(sessionId, { status, turnsUsed, tokensUsed, noProgressStreak, lastReason });
    if (!next) return;
    await this.publish(sessionId, next);
    if (next.status === 'active') setTimeout(() => { void this.dispatch(sessionId, 'continuation'); }, 100);
  }

  private async requireSession(sessionId: string): Promise<HeadlessSessionMeta> {
    const session = await this.sessions.get(sessionId);
    if (!session) throw new Error(`Unknown session: ${sessionId}`);
    return session;
  }

  private async publish(sessionId: string, goal?: HeadlessGoalState): Promise<void> {
    const state = goal ?? await this.storage.get(sessionId);
    await this.sessions.appendEvent(sessionId, 'goal_status', { goal: state ? toPayload(state) : null });
  }
}

type GoalTurn = { finalText: string | null; sawToolUse: boolean; tokens: number; errored: boolean; errorMessage?: string };

function goalFromJson(value: string): HeadlessGoalState { return JSON.parse(value) as HeadlessGoalState; }
function asRecord(value: unknown): Record<string, unknown> | null { return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null; }
function errorMessage(value: unknown): string { return value instanceof Error ? value.message : typeof value === 'string' ? value : String(value ?? ''); }
function tokenUsage(value: unknown): number {
  const data = asRecord(value);
  const usage = asRecord(data?.usage) ?? data;
  return ['promptTokens', 'completionTokens', 'reasoningTokens', 'cachedTokens', 'inputTokens', 'outputTokens']
    .reduce((sum, key) => sum + (typeof usage?.[key] === 'number' && Number.isFinite(usage[key]) ? usage[key] as number : 0), 0);
}
function usageLimited(message: string | undefined): boolean { return /rate.?limit|usage.?limit|quota|too\s*many\s*requests/i.test(message ?? ''); }
function toPayload(goal: HeadlessGoalState): HeadlessGoalStatusPayload {
  const { agentKind: _agentKind, updatedAt: _updatedAt, ...payload } = goal;
  return payload;
}
function requiredObjective(value: string): string {
  const objective = value.trim();
  if (!objective) throw new Error('objective must not be empty');
  return objective;
}
function limit(value: number | null | undefined, name: string): number | null {
  if (value === undefined || value === null) return null;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be a positive number or null`);
  return Math.floor(value);
}
function normalizeLimits(limits: GoalLimits | undefined): GoalLimits {
  return { maxTurns: limit(limits?.maxTurns, 'maxTurns'), budgetTokens: limit(limits?.budgetTokens, 'budgetTokens'), noProgressLimit: limit(limits?.noProgressLimit, 'noProgressLimit') };
}
function normalizeUpdate(patch: GoalUpdate): GoalUpdate {
  const next: GoalUpdate = {};
  if ('objective' in patch) next.objective = requiredObjective(patch.objective ?? '');
  if ('maxTurns' in patch) next.maxTurns = limit(patch.maxTurns, 'maxTurns');
  if ('budgetTokens' in patch) next.budgetTokens = limit(patch.budgetTokens, 'budgetTokens');
  if ('noProgressLimit' in patch) next.noProgressLimit = limit(patch.noProgressLimit, 'noProgressLimit');
  return next;
}
function firstDirective(objective: string, maxTurns: number | null): string {
  return `[Goal] Work autonomously toward this goal across multiple turns until it is met:\n\n${objective}\n\nWhen this turn ends, end your reply with a fenced JSON block exactly like:\n\n\`\`\`json\n{"goal_status":"complete|continue|blocked","reason":"one short sentence"}\n\`\`\`\n\nOnly mark complete after verifying the result with tools.${maxTurns === null ? '' : ` The goal has a maximum of ${maxTurns} turns.`}`;
}
function continuationDirective(objective: string, lastReason: string | null): string {
  return `[Goal] Continue working autonomously toward this goal:\n\n${objective}${lastReason ? `\n\nLast status note: ${lastReason}` : ''}\n\nEnd your reply with a fenced JSON verdict: {"goal_status":"complete|continue|blocked","reason":"one short sentence"}.`;
}
function parseVerdict(text: string | null): { status: 'complete' | 'continue' | 'blocked'; reason: string } | null {
  if (!text) return null;
  const matches = [...text.matchAll(/```(?:json|jsonc)?\s*([\s\S]*?)```/gi)];
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    try {
      const value = JSON.parse(matches[i][1].trim()) as Record<string, unknown>;
      if (value.goal_status === 'complete' || value.goal_status === 'continue' || value.goal_status === 'blocked') {
        return { status: value.goal_status, reason: typeof value.reason === 'string' ? value.reason.trim() : '' };
      }
    } catch { /* try the preceding block */ }
  }
  return null;
}
