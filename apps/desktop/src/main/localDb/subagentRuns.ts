/** Host-owned durable projection of Subagent activity. */

import { createId } from '@paralleldrive/cuid2';
import {
  SUBAGENT_PR1_CAPABILITIES,
  type SubagentActivityEntry,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRun,
  type SubagentRunDetail,
  type SubagentRunStatus,
} from '@cindy/maker-shared/subagent-workspace';
import { normalizeSubagentObservation } from '@cindy/maker-shared/subagent-observation';
import {
  normalizeAgentTaskUpdate,
  subagentSpawnResultIndicatesRunning,
  type AgentTaskUpdate,
} from '@cindy/maker-shared/agent-task';
import { and, desc, eq, gt, inArray, isNull, lt, ne, or } from 'drizzle-orm';

import { getDbClient } from './client/current.js';
import { messages, sessions, subagentRunAliases, subagentRuns } from './schema.js';

const MAX_ALIAS_COUNT = 128;
const MAX_PROVIDER_RUN_IDS = 64;
const MAX_INDEXED_ALIAS_COUNT = MAX_ALIAS_COUNT + MAX_PROVIDER_RUN_IDS;
const MAX_ACTIVITY_ENTRIES = 200;
const MAX_RETURNED_RESULT_BYTES = 256 * 1024;
const DEFAULT_LIST_PAGE_SIZE = 50;
const MAX_LIST_PAGE_SIZE = 100;

const TEXT_LIMITS = {
  id: 512,
  title: 240,
  description: 8 * 1024,
  summary: 8 * 1024,
  model: 240,
  reasoningEffort: 80,
  activitySummary: 2 * 1024,
  lastToolName: 240,
} as const;

type SubagentRunRow = typeof subagentRuns.$inferSelect;

export interface PersistSubagentTaskUpdateResult {
  runId: string;
  created: boolean;
  firstForSession: boolean;
}

export interface VisibleSubagentObservationIdentity {
  provider: SubagentProvider;
  identities: string[];
}

function sliceWithoutDanglingSurrogate(value: string, end: number): string {
  let boundedEnd = end;
  if (boundedEnd > 0) {
    const last = value.charCodeAt(boundedEnd - 1);
    if (last >= 0xd800 && last <= 0xdbff) boundedEnd -= 1;
  }
  return value.slice(0, boundedEnd);
}

function boundedText(value: string | null | undefined, max: number): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  return trimmed.length <= max ? trimmed : `${sliceWithoutDanglingSurrogate(trimmed, max - 1)}…`;
}

function boundedNumber(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Number.MAX_SAFE_INTEGER, Math.floor(value))
    : undefined;
}

function parseStringArray(raw: string): string[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  } catch {
    return [];
  }
}

function parseActivity(raw: string): SubagentActivityEntry[] {
  try {
    const value: unknown = JSON.parse(raw);
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is SubagentActivityEntry => {
      if (!item || typeof item !== 'object') return false;
      const entry = item as Partial<SubagentActivityEntry>;
      return (
        typeof entry.sequence === 'number' &&
        typeof entry.occurredAt === 'number' &&
        (entry.status === 'running' ||
          entry.status === 'completed' ||
          entry.status === 'failed' ||
          entry.status === 'stopped') &&
        (entry.kind === 'started' ||
          entry.kind === 'progress' ||
          entry.kind === 'message' ||
          entry.kind === 'question' ||
          entry.kind === 'decision' ||
          entry.kind === 'resumed' ||
          entry.kind === 'steered' ||
          entry.kind === 'completed' ||
          entry.kind === 'failed' ||
          entry.kind === 'stopped')
      );
    });
  } catch {
    return [];
  }
}

function parseCapabilities(raw: string): SubagentCapabilities {
  let value: Record<string, unknown> = {};
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      value = parsed as Record<string, unknown>;
    }
  } catch {
    // Fail closed below.
  }
  const parentContext =
    value.parentContext === 'snapshot' || value.parentContext === 'live'
      ? value.parentContext
      : 'unknown';
  return {
    viewActivity: value.viewActivity === true,
    viewReturnedResult: value.viewReturnedResult === true,
    viewFullTranscript: value.viewFullTranscript === true,
    resume: value.resume === true,
    steer: value.steer === true,
    stop: value.stop === true,
    parentContext,
  };
}

function finiteTime(value: string | undefined, fallback: number): number {
  if (!value) return fallback;
  const parsed = Date.parse(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function mergeUnique(
  values: readonly string[],
  incoming: readonly (string | undefined)[],
  max: number,
): string[] {
  const out = new Set(values);
  for (const raw of incoming) {
    const value = boundedText(raw, TEXT_LIMITS.id);
    if (value) out.add(value);
    if (out.size >= max) break;
  }
  return [...out].slice(0, max);
}

function terminal(status: SubagentRunStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'stopped';
}

function mergeStatus(
  previous: SubagentRunStatus | undefined,
  next: SubagentRunStatus,
  provider: SubagentProvider,
): SubagentRunStatus {
  if (!previous) return next;
  if (previous === 'failed' || previous === 'stopped') return previous;
  // Codex can discover a running descendant after the direct child appeared
  // complete; that is aggregate expansion, not resurrection of a failed run.
  if (previous === 'completed' && next === 'running' && provider !== 'codex') return previous;
  return next;
}

function activityKind(status: SubagentRunStatus, created: boolean): SubagentActivityEntry['kind'] {
  if (created && status === 'running') return 'started';
  if (status === 'completed') return 'completed';
  if (status === 'failed') return 'failed';
  if (status === 'stopped') return 'stopped';
  return 'progress';
}

function appendActivity(
  current: SubagentActivityEntry[],
  update: AgentTaskUpdate,
  status: SubagentRunStatus,
  occurredAt: number,
  created: boolean,
): SubagentActivityEntry[] {
  const summary = boundedText(update.summary ?? update.description, TEXT_LIMITS.activitySummary);
  const lastToolName = boundedText(update.lastToolName, TEXT_LIMITS.lastToolName);
  const kind = activityKind(status, created);
  const previous = current.at(-1);
  if (
    previous &&
    previous.kind === kind &&
    previous.status === status &&
    previous.summary === summary &&
    previous.lastToolName === lastToolName
  ) {
    return current;
  }
  const next: SubagentActivityEntry = {
    sequence: (previous?.sequence ?? 0) + 1,
    kind,
    status,
    ...(summary ? { summary } : {}),
    ...(lastToolName ? { lastToolName } : {}),
    occurredAt,
  };
  return [...current, next].slice(-MAX_ACTIVITY_ENTRIES);
}

function rowToRun(row: SubagentRunRow): SubagentRun {
  const usage = {
    ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
    ...(row.toolUses !== null ? { toolUses: row.toolUses } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
  };
  return {
    id: row.id,
    parentSessionId: row.sessionId,
    provider: row.provider,
    logicalAgentId: row.logicalAgentId,
    ...(row.parentToolUseId ? { parentToolUseId: row.parentToolUseId } : {}),
    identityAliases: parseStringArray(row.aliases),
    providerRunIds: parseStringArray(row.providerRunIds),
    status: row.status,
    ...(row.title ? { title: row.title } : {}),
    ...(row.description ? { description: row.description } : {}),
    ...(row.summary ? { summary: row.summary } : {}),
    ...(row.model ? { model: row.model } : {}),
    ...(row.reasoningEffort ? { reasoningEffort: row.reasoningEffort } : {}),
    ...(Object.keys(usage).length > 0 ? { usage } : {}),
    capabilities: parseCapabilities(row.capabilities),
    startedAt: row.startedAt,
    updatedAt: row.updatedAt,
    ...(row.endedAt !== null ? { endedAt: row.endedAt } : {}),
  };
}

async function matchingRow(
  sessionId: string,
  provider: SubagentProvider,
  incomingAliases: string[],
  clearedAt: number | null,
): Promise<SubagentRunRow | undefined> {
  if (incomingAliases.length === 0) return undefined;
  const db = getDbClient().drizzle;
  const visibility = [
    eq(subagentRuns.sessionId, sessionId),
    eq(subagentRuns.provider, provider),
    isNull(subagentRuns.rewindAt),
    isNull(subagentRuns.deletedAt),
    ...(clearedAt !== null ? [gt(subagentRuns.startedAt, clearedAt)] : []),
  ];
  const [indexed] = await db
    .select({ run: subagentRuns })
    .from(subagentRunAliases)
    .innerJoin(subagentRuns, eq(subagentRunAliases.runId, subagentRuns.id))
    .where(
      and(
        eq(subagentRunAliases.sessionId, sessionId),
        eq(subagentRunAliases.provider, provider),
        inArray(subagentRunAliases.alias, incomingAliases),
        ...visibility,
      ),
    )
    .orderBy(desc(subagentRuns.startedAt), desc(subagentRuns.id))
    .limit(1);
  if (indexed) return indexed.run;

  // Recovery fallback for a process crash between the run write and alias
  // projection. Normal updates use the indexed join above.
  const [direct] = await db
    .select()
    .from(subagentRuns)
    .where(
      and(
        ...visibility,
        or(
          inArray(subagentRuns.logicalAgentId, incomingAliases),
          inArray(subagentRuns.parentToolUseId, incomingAliases),
        ),
      ),
    )
    .orderBy(desc(subagentRuns.startedAt), desc(subagentRuns.id))
    .limit(1);
  return direct;
}

async function persistAliasProjection(
  row: SubagentRunRow | { id: string; sessionId: string; provider: SubagentProvider },
  aliases: string[],
  now: number,
): Promise<void> {
  if (aliases.length === 0) return;
  await getDbClient()
    .drizzle.insert(subagentRunAliases)
    .values(
      aliases.map((alias) => ({
        sessionId: row.sessionId,
        provider: row.provider,
        alias,
        runId: row.id,
        createdAt: now,
      })),
    )
    .onConflictDoNothing();
}

/**
 * Persist one existing `agent_task_update` observation. This function does not
 * launch, stop or otherwise control a harness; callers place it on the shared
 * durable-write FIFO so message and Subagent projections retain event order.
 */
export async function persistSubagentTaskUpdate(
  sessionId: string,
  data: unknown,
  source?: SubagentProvider,
  observedAt = Date.now(),
): Promise<PersistSubagentTaskUpdateResult | null> {
  const update = normalizeAgentTaskUpdate(data, source);
  const markedObservation =
    data && typeof data === 'object' && !Array.isArray(data)
      ? normalizeSubagentObservation((data as Record<string, unknown>).subagentObservation)
      : null;
  // Codex's completed spawn item carries the result summary but deliberately
  // leaves lifecycle authority to descendant tracking. It may enrich an
  // already-marked run, but can never create one or close it by itself.
  const codexSummaryEnrichment =
    !markedObservation &&
    source === 'codex' &&
    update?.provider === 'codex' &&
    update.status === 'completed' &&
    Boolean(update.summary);
  const observation =
    markedObservation ??
    (codexSummaryEnrichment && update
      ? {
          kind: 'progress' as const,
          logicalSubagentId: update.taskId,
          ...(update.parentToolUseId ? { parentToolUseId: update.parentToolUseId } : {}),
        }
      : null);
  if (
    !update ||
    !observation ||
    update.taskType === 'local_bash' ||
    update.taskType === 'local_workflow' ||
    (observation.kind === 'terminal' && !terminal(update.status)) ||
    (observation.kind === 'progress' && terminal(update.status) && !codexSummaryEnrichment)
  ) {
    return null;
  }

  const db = getDbClient().drizzle;
  const [session] = await db
    .select({ id: sessions.id, status: sessions.status, clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  // Remote/device-link sessions are not owned by this database. PR1 fails
  // closed instead of accidentally attaching their events to the controller.
  if (!session || session.status === 'deleted') return null;

  const incomingIdentityAliases = mergeUnique(
    [],
    [
      observation.logicalSubagentId,
      observation.parentToolUseId,
      ...(observation.identityAliases ?? []),
    ],
    MAX_ALIAS_COUNT,
  );
  const incomingProviderRunIds = observation.kind === 'spawn'
    ? mergeUnique([], observation.providerRunIds ?? [], MAX_PROVIDER_RUN_IDS)
    : [];
  const lookupAliases = mergeUnique(
    incomingIdentityAliases,
    incomingProviderRunIds,
    MAX_INDEXED_ALIAS_COUNT,
  );
  const existing = await matchingRow(sessionId, update.provider, lookupAliases, session.clearedAt);
  // A progress/terminal event is never authority to invent a child or attach a
  // control call's receiver ids to an arbitrary existing run.
  if (!existing && observation.kind !== 'spawn') return null;
  const now = Number.isSafeInteger(observedAt) && observedAt >= 0 ? observedAt : Date.now();
  const updatedAt = finiteTime(update.updatedAt, now);
  if (codexSummaryEnrichment) {
    const summary = boundedText(update.summary, TEXT_LIMITS.summary);
    if (!existing || !summary) return null;
    const activity = appendActivity(
      parseActivity(existing.activity),
      { ...update, status: existing.status },
      existing.status,
      updatedAt,
      false,
    );
    await db
      .update(subagentRuns)
      .set({
        summary,
        activity: JSON.stringify(activity),
        updatedAt: Math.max(existing.updatedAt, updatedAt),
      })
      .where(eq(subagentRuns.id, existing.id));
    return { runId: existing.id, created: false, firstForSession: false };
  }
  const startedAt = existing?.startedAt ?? finiteTime(update.createdAt, updatedAt);
  const status = mergeStatus(existing?.status, update.status, update.provider);
  const aliases = mergeUnique(
    existing ? parseStringArray(existing.aliases) : [],
    incomingIdentityAliases,
    MAX_ALIAS_COUNT,
  );
  const providerRunIds = mergeUnique(
    existing ? parseStringArray(existing.providerRunIds) : [],
    incomingProviderRunIds,
    MAX_PROVIDER_RUN_IDS,
  );
  const activity = appendActivity(
    existing ? parseActivity(existing.activity) : [],
    update,
    status,
    updatedAt,
    !existing,
  );
  const parentToolUseId =
    boundedText(observation.parentToolUseId, TEXT_LIMITS.id) ??
    existing?.parentToolUseId ??
    null;
  const values = {
    parentToolUseId,
    aliases: JSON.stringify(aliases),
    providerRunIds: JSON.stringify(providerRunIds),
    status,
    title: boundedText(update.title, TEXT_LIMITS.title) ?? existing?.title ?? null,
    description:
      boundedText(update.description, TEXT_LIMITS.description) ?? existing?.description ?? null,
    summary: boundedText(update.summary, TEXT_LIMITS.summary) ?? existing?.summary ?? null,
    model:
      update.model === null
        ? null
        : (boundedText(update.model, TEXT_LIMITS.model) ?? existing?.model ?? null),
    reasoningEffort:
      boundedText(update.reasoningEffort, TEXT_LIMITS.reasoningEffort) ??
      existing?.reasoningEffort ??
      null,
    totalTokens: boundedNumber(update.usage?.totalTokens) ?? existing?.totalTokens ?? null,
    toolUses: boundedNumber(update.usage?.toolUses) ?? existing?.toolUses ?? null,
    durationMs: boundedNumber(update.usage?.durationMs) ?? existing?.durationMs ?? null,
    capabilities: existing?.capabilities ?? JSON.stringify(SUBAGENT_PR1_CAPABILITIES),
    activity: JSON.stringify(activity),
    startedAt,
    updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
    endedAt: terminal(status) ? (existing?.endedAt ?? updatedAt) : null,
  };

  if (existing) {
    // Index first: if the following denormalized row update fails, the alias
    // still points at a valid pre-existing run and a retry remains idempotent.
    await persistAliasProjection(
      existing,
      mergeUnique(aliases, providerRunIds, MAX_INDEXED_ALIAS_COUNT),
      now,
    );
    await db.update(subagentRuns).set(values).where(eq(subagentRuns.id, existing.id));
    return { runId: existing.id, created: false, firstForSession: false };
  }

  const [visibleBefore] = await db
    .select({ id: subagentRuns.id })
    .from(subagentRuns)
    .where(
      and(
        eq(subagentRuns.sessionId, sessionId),
        isNull(subagentRuns.rewindAt),
        isNull(subagentRuns.deletedAt),
        ...(session.clearedAt !== null ? [gt(subagentRuns.startedAt, session.clearedAt)] : []),
      ),
    )
    .limit(1);
  const id = createId();
  await db.insert(subagentRuns).values({
    id,
    sessionId,
    provider: update.provider,
    logicalAgentId: observation.logicalSubagentId,
    ...values,
  });
  await persistAliasProjection(
    { id, sessionId, provider: update.provider },
    mergeUnique(aliases, providerRunIds, MAX_INDEXED_ALIAS_COUNT),
    now,
  );
  return { runId: id, created: true, firstForSession: !visibleBefore };
}

async function readableSession(sessionId: string): Promise<{ clearedAt: number | null } | null> {
  const [session] = await getDbClient()
    .drizzle.select({ clearedAt: sessions.clearedAt })
    .from(sessions)
    .where(and(eq(sessions.id, sessionId), ne(sessions.status, 'deleted')))
    .limit(1);
  return session ?? null;
}

export async function listVisibleSubagentObservationIdentities(
  sessionId: string,
): Promise<VisibleSubagentObservationIdentity[]> {
  const session = await readableSession(sessionId);
  if (!session) return [];
  const rows = await getDbClient()
    .drizzle.select({
      provider: subagentRuns.provider,
      logicalAgentId: subagentRuns.logicalAgentId,
      parentToolUseId: subagentRuns.parentToolUseId,
      aliases: subagentRuns.aliases,
      providerRunIds: subagentRuns.providerRunIds,
    })
    .from(subagentRuns)
    .where(
      and(
        eq(subagentRuns.sessionId, sessionId),
        isNull(subagentRuns.rewindAt),
        isNull(subagentRuns.deletedAt),
        ...(session.clearedAt !== null ? [gt(subagentRuns.startedAt, session.clearedAt)] : []),
      ),
    );
  return rows.map((row) => ({
    provider: row.provider,
    identities: mergeUnique(
      parseStringArray(row.aliases),
      [
        row.logicalAgentId,
        row.parentToolUseId ?? undefined,
        ...parseStringArray(row.providerRunIds),
      ],
      MAX_INDEXED_ALIAS_COUNT,
    ),
  }));
}

async function visibleParentToolUseIds(
  sessionId: string,
  candidates: string[],
  clearedAt: number | null,
): Promise<Set<string>> {
  if (candidates.length === 0) return new Set();
  const rows = await getDbClient()
    .drizzle.select({ toolUseId: messages.toolUseId })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'tool_use'),
        inArray(messages.toolUseId, candidates),
        isNull(messages.rewindAt),
        ...(clearedAt !== null ? [gt(messages.createdAt, clearedAt)] : []),
      ),
    );
  return new Set(rows.flatMap((row) => (row.toolUseId ? [row.toolUseId] : [])));
}

interface SubagentListCursor {
  startedAt: number;
  id: string;
}

function encodeCursor(row: Pick<SubagentRunRow, 'startedAt' | 'id'>): string {
  return Buffer.from(JSON.stringify({ startedAt: row.startedAt, id: row.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(raw: string | undefined): SubagentListCursor | null {
  if (!raw) return null;
  if (raw.length > 512) throw new Error('invalid Subagent list cursor');
  try {
    const value: unknown = JSON.parse(Buffer.from(raw, 'base64url').toString('utf8'));
    if (!value || typeof value !== 'object') throw new Error('invalid');
    const cursor = value as Partial<SubagentListCursor>;
    if (
      typeof cursor.startedAt !== 'number' ||
      !Number.isSafeInteger(cursor.startedAt) ||
      cursor.startedAt < 0 ||
      typeof cursor.id !== 'string' ||
      cursor.id.length === 0 ||
      cursor.id.length > TEXT_LIMITS.id
    ) {
      throw new Error('invalid');
    }
    return { startedAt: cursor.startedAt, id: cursor.id };
  } catch {
    throw new Error('invalid Subagent list cursor');
  }
}

export async function listSubagentRuns(
  sessionId: string,
  options: { cursor?: string; limit?: number } = {},
): Promise<{ runs: SubagentRun[]; nextCursor?: string } | null> {
  const session = await readableSession(sessionId);
  if (!session) return null;
  const db = getDbClient().drizzle;
  const cursor = decodeCursor(options.cursor);
  const requestedLimit =
    typeof options.limit === 'number' && Number.isFinite(options.limit)
      ? Math.floor(options.limit)
      : DEFAULT_LIST_PAGE_SIZE;
  const pageSize = Math.min(MAX_LIST_PAGE_SIZE, Math.max(1, requestedLimit));
  const baseConditions = [
    eq(subagentRuns.sessionId, sessionId),
    isNull(subagentRuns.rewindAt),
    isNull(subagentRuns.deletedAt),
  ];
  if (session.clearedAt !== null) {
    baseConditions.push(gt(subagentRuns.startedAt, session.clearedAt));
  }
  const visibleRows: SubagentRunRow[] = [];
  let scanCursor = cursor;
  let exhausted = false;
  // Parent visibility is defensive and can hide an entire raw batch. Keep
  // scanning bounded DB pages so those rows never strand older visible runs.
  while (visibleRows.length <= pageSize && !exhausted) {
    const conditions = [...baseConditions];
    if (scanCursor) {
      conditions.push(
        or(
          lt(subagentRuns.startedAt, scanCursor.startedAt),
          and(
            eq(subagentRuns.startedAt, scanCursor.startedAt),
            lt(subagentRuns.id, scanCursor.id),
          ),
        )!,
      );
    }
    const batch = await db
      .select()
      .from(subagentRuns)
      .where(and(...conditions))
      .orderBy(desc(subagentRuns.startedAt), desc(subagentRuns.id))
      .limit(pageSize + 1);
    if (batch.length === 0) break;
    const parentIds = batch.flatMap((row) => (row.parentToolUseId ? [row.parentToolUseId] : []));
    const visibleToolUseIds = await visibleParentToolUseIds(
      sessionId,
      parentIds,
      session.clearedAt,
    );
    visibleRows.push(
      ...batch.filter(
        (row) => !row.parentToolUseId || visibleToolUseIds.has(row.parentToolUseId),
      ),
    );
    const lastScanned = batch[batch.length - 1];
    scanCursor = { startedAt: lastScanned.startedAt, id: lastScanned.id };
    exhausted = batch.length < pageSize + 1;
  }
  const page = visibleRows.slice(0, pageSize);
  const runs = page.map(rowToRun);
  return {
    runs,
    ...(visibleRows.length > pageSize && page.length > 0
      ? { nextCursor: encodeCursor(page[page.length - 1]) }
      : {}),
  };
}

function parseMessageText(raw: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'string' && parsed.trim() ? parsed : undefined;
  } catch {
    return raw.trim() ? raw : undefined;
  }
}

function truncateUtf8(value: string, maxBytes: number): { value: string; truncated: boolean } {
  if (Buffer.byteLength(value, 'utf8') <= maxBytes) return { value, truncated: false };
  let low = 0;
  let high = value.length;
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (Buffer.byteLength(value.slice(0, middle), 'utf8') <= maxBytes) low = middle;
    else high = middle - 1;
  }
  return { value: sliceWithoutDanglingSurrogate(value, low), truncated: true };
}

async function resolveDetailRow(
  sessionId: string,
  provider: SubagentProvider,
  identifier: string,
  clearedAt: number | null,
): Promise<SubagentRunRow | undefined> {
  const db = getDbClient().drizzle;
  const visibility = [
    eq(subagentRuns.sessionId, sessionId),
    eq(subagentRuns.provider, provider),
    isNull(subagentRuns.rewindAt),
    isNull(subagentRuns.deletedAt),
    ...(clearedAt !== null ? [gt(subagentRuns.startedAt, clearedAt)] : []),
  ];
  const [direct] = await db
    .select()
    .from(subagentRuns)
    .where(and(eq(subagentRuns.id, identifier), ...visibility))
    .limit(1);
  if (direct) return direct;

  const [aliased] = await db
    .select({ run: subagentRuns })
    .from(subagentRunAliases)
    .innerJoin(subagentRuns, eq(subagentRunAliases.runId, subagentRuns.id))
    .where(
      and(
        eq(subagentRunAliases.sessionId, sessionId),
        eq(subagentRunAliases.provider, provider),
        eq(subagentRunAliases.alias, identifier),
        ...visibility,
      ),
    )
    .orderBy(desc(subagentRuns.updatedAt), desc(subagentRuns.id))
    .limit(1);
  return aliased?.run;
}

export async function getSubagentRunDetail(
  sessionId: string,
  provider: SubagentProvider,
  runIdOrAlias: string,
): Promise<SubagentRunDetail | null | undefined> {
  const session = await readableSession(sessionId);
  if (!session) return undefined;
  const normalizedIdentifier = boundedText(runIdOrAlias, TEXT_LIMITS.id);
  if (!normalizedIdentifier) return null;
  const row = await resolveDetailRow(sessionId, provider, normalizedIdentifier, session.clearedAt);
  if (!row) return null;
  if (row.parentToolUseId) {
    const visibleToolUseIds = await visibleParentToolUseIds(
      sessionId,
      [row.parentToolUseId],
      session.clearedAt,
    );
    if (!visibleToolUseIds.has(row.parentToolUseId)) return null;
  }

  const run = rowToRun(row);
  let returnedResult: string | undefined;
  let returnedResultTruncated = false;
  if (
    run.capabilities.viewReturnedResult &&
    row.provider === 'codex' &&
    row.status === 'completed' &&
    row.summary
  ) {
    const bounded = truncateUtf8(row.summary, MAX_RETURNED_RESULT_BYTES);
    returnedResult = bounded.value;
    returnedResultTruncated = bounded.truncated;
  } else if (
    run.capabilities.viewReturnedResult &&
    (row.provider === 'pi' || row.provider === 'claude-code') &&
    row.parentToolUseId &&
    terminal(row.status)
  ) {
    const [result] = await getDbClient()
      .drizzle.select({ content: messages.content })
      .from(messages)
      .where(
        and(
          eq(messages.sessionId, sessionId),
          eq(messages.role, 'tool_result'),
          eq(messages.toolUseId, row.parentToolUseId),
          isNull(messages.rewindAt),
          ...(session.clearedAt !== null ? [gt(messages.createdAt, session.clearedAt)] : []),
        ),
      )
      .orderBy(desc(messages.createdAt))
      .limit(1);
    const text = result ? parseMessageText(result.content) : undefined;
    // Claude's background Agent tool result is only a launch receipt. Once the
    // task reaches terminal state, expose the task_notification summary instead.
    const returnedText = row.provider === 'claude-code'
      && subagentSpawnResultIndicatesRunning('Agent', text)
      ? row.summary ?? undefined
      : text;
    if (returnedText) {
      const bounded = truncateUtf8(returnedText, MAX_RETURNED_RESULT_BYTES);
      returnedResult = bounded.value;
      returnedResultTruncated = bounded.truncated;
    }
  }

  return {
    ...run,
    activity: run.capabilities.viewActivity ? parseActivity(row.activity) : [],
    ...(returnedResult ? { returnedResult } : {}),
    ...(returnedResultTruncated ? { returnedResultTruncated: true } : {}),
  };
}
