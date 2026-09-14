import { and, eq, sql } from 'drizzle-orm';

import { getDbClient } from './client/current.js';
import { sessions } from './schema.js';

export type CodexPlanLifecycle = 'active' | 'interrupted' | 'sealed';

export interface CodexPlanEntry {
  step: string;
  status: 'pending' | 'in_progress' | 'completed';
}

export interface CodexPlanStateSnapshot {
  turnId: string;
  plan: CodexPlanEntry[];
  state: CodexPlanLifecycle;
}

function snapshotJson(snapshot: CodexPlanStateSnapshot): string {
  return JSON.stringify(snapshot);
}

function samePlanTurn(turnId: string) {
  return sql`json_extract(${sessions.codexPlanJson}, '$.turnId') = ${turnId}`;
}

function normalizePlanStatus(value: unknown): CodexPlanEntry['status'] | null {
  return value === 'pending' || value === 'in_progress' || value === 'completed' ? value : null;
}

export function normalizeCodexPlanEntries(value: unknown): CodexPlanEntry[] | null {
  if (!Array.isArray(value)) return null;
  const plan: CodexPlanEntry[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    const status = normalizePlanStatus(row.status);
    if (typeof row.step !== 'string' || !status) return null;
    plan.push({ step: row.step, status });
  }
  return plan;
}

function planTurnId(toolUseId: unknown): string | null {
  if (typeof toolUseId !== 'string' || !toolUseId.startsWith('plan:')) return null;
  const turnId = toolUseId.slice('plan:'.length);
  return turnId.length > 0 ? turnId : null;
}

export interface CodexPlanUpdateData {
  toolUseId?: unknown;
  toolName?: unknown;
  input?: unknown;
}

export function parseCodexPlanUpdate(
  data: CodexPlanUpdateData | null | undefined,
): { turnId: string; plan: CodexPlanEntry[] } | null {
  if (data?.toolName !== 'update_plan') return null;
  const turnId = planTurnId(data.toolUseId);
  if (!turnId || !data.input || typeof data.input !== 'object' || Array.isArray(data.input)) {
    return null;
  }
  const plan = normalizeCodexPlanEntries((data.input as Record<string, unknown>).plan);
  return plan ? { turnId, plan } : null;
}

export async function writeCodexPlanUpdate(
  sessionId: string,
  update: { turnId: string; plan: CodexPlanEntry[] },
): Promise<void> {
  const db = getDbClient().drizzle;
  if (update.plan.length === 0) {
    await db
      .update(sessions)
      .set({ codexPlanJson: null })
      .where(eq(sessions.id, sessionId));
    return;
  }
  await db
    .update(sessions)
    .set({ codexPlanJson: snapshotJson({ turnId: update.turnId, plan: update.plan, state: 'active' }) })
    .where(eq(sessions.id, sessionId));
}

export interface CodexPlanTerminalData {
  cancelled?: unknown;
  plan?: unknown;
  raw?: { id?: unknown; status?: unknown };
}

export function parseCodexPlanTerminal(
  data: CodexPlanTerminalData | null | undefined,
): { turnId: string; plan: CodexPlanEntry[] | null; state: 'interrupted' | 'sealed' } | null {
  const turnId = typeof data?.raw?.id === 'string' && data.raw.id.length > 0 ? data.raw.id : null;
  if (!turnId) return null;
  const plan = data?.plan === undefined || data.plan === null
    ? null
    : normalizeCodexPlanEntries(data.plan);
  const planCompleted = plan !== null && plan.every((item) => item.status === 'completed');
  return {
    turnId,
    plan,
    state:
      data?.cancelled !== true && data?.raw?.status === 'completed' && planCompleted
        ? 'sealed'
        : 'interrupted',
  };
}

export async function writeCodexPlanTerminal(
  sessionId: string,
  terminal: { turnId: string; plan: CodexPlanEntry[] | null; state: 'interrupted' | 'sealed' },
): Promise<void> {
  const db = getDbClient().drizzle;
  if (terminal.plan?.length === 0) {
    await db
      .update(sessions)
      .set({ codexPlanJson: null })
      .where(and(eq(sessions.id, sessionId), samePlanTurn(terminal.turnId)));
    return;
  }
  if (terminal.plan === null) {
    await db
      .update(sessions)
      .set({ codexPlanJson: sql`json_set(${sessions.codexPlanJson}, '$.state', ${terminal.state})` })
      .where(and(eq(sessions.id, sessionId), samePlanTurn(terminal.turnId)));
    return;
  }
  await db
    .update(sessions)
    .set({
      codexPlanJson: snapshotJson({ turnId: terminal.turnId, plan: terminal.plan, state: terminal.state }),
    })
    .where(and(eq(sessions.id, sessionId), samePlanTurn(terminal.turnId)));
}

export async function markCodexPlanInterrupted(
  sessionId: string,
  turnId: string,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ codexPlanJson: sql`json_set(${sessions.codexPlanJson}, '$.state', 'interrupted')` })
    .where(and(eq(sessions.id, sessionId), samePlanTurn(turnId)));
}

export async function readCodexPlanState(
  sessionId: string,
): Promise<CodexPlanStateSnapshot | null> {
  const db = getDbClient().drizzle;
  const [row] = await db
    .select({
      agentKind: sessions.agentKind,
      planJson: sessions.codexPlanJson,
    })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (row?.agentKind !== 'codex' || typeof row.planJson !== 'string') {
    return null;
  }
  try {
    const snapshot = JSON.parse(row.planJson) as Partial<CodexPlanStateSnapshot>;
    const plan = normalizeCodexPlanEntries(snapshot.plan);
    if (
      typeof snapshot.turnId !== 'string' ||
      (snapshot.state !== 'active' && snapshot.state !== 'interrupted' && snapshot.state !== 'sealed')
    ) {
      return null;
    }
    return plan ? { turnId: snapshot.turnId, plan, state: snapshot.state } : null;
  } catch {
    return null;
  }
}

export async function clearSealedCodexPlanState(
  sessionId: string,
  turnId: string,
): Promise<void> {
  const db = getDbClient().drizzle;
  await db
    .update(sessions)
    .set({ codexPlanJson: null })
    .where(
      and(
        eq(sessions.id, sessionId),
        samePlanTurn(turnId),
        sql`json_extract(${sessions.codexPlanJson}, '$.state') = 'sealed'`,
      ),
    );
}
