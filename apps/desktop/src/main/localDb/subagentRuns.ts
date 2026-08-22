/** Host-owned durable projection of Subagent activity. */

import { createId } from '@paralleldrive/cuid2';
import {
  PI_DURABLE_SUBAGENT_CAPABILITIES,
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
import { and, desc, eq, gt, inArray, isNull, lt, ne, notInArray, or, sql, type SQL } from 'drizzle-orm';

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

function boundedCost(value: number | undefined): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function flagInt(value: number | null | undefined): number | null {
  return value === 1 ? 1 : value === 0 ? 0 : null;
}

/** A later terminal frame without full text must not erase the first return. */
function returnedResultValues(
  data: unknown,
  terminalStatus: boolean,
  existing?: SubagentRunRow,
  reset = false,
): {
  returnedResult: string | null;
  returnedResultEmpty: number | null;
  returnedResultTruncated: number | null;
} {
  const prior = reset ? undefined : existing;
  if (prior && (prior.returnedResult !== null || prior.returnedResultEmpty === 1)) {
    return {
      returnedResult: prior.returnedResult,
      returnedResultEmpty: flagInt(prior.returnedResultEmpty),
      returnedResultTruncated: flagInt(prior.returnedResultTruncated),
    };
  }
  const unchanged = {
    returnedResult: prior?.returnedResult ?? null,
    returnedResultEmpty: flagInt(prior?.returnedResultEmpty),
    returnedResultTruncated: flagInt(prior?.returnedResultTruncated),
  };
  if (!terminalStatus || !data || typeof data !== 'object' || Array.isArray(data)) {
    return unchanged;
  }
  const raw = data as Record<string, unknown>;
  const explicitEmpty = raw.returnedResultEmpty === true || raw.returnedResultEmpty === 1;
  if (typeof raw.returnedResult !== 'string' && !explicitEmpty) return unchanged;
  const source = typeof raw.returnedResult === 'string' ? raw.returnedResult : '';
  const bounded = truncateUtf8(source, MAX_RETURNED_RESULT_BYTES);
  const empty = explicitEmpty || bounded.value.trim().length === 0;
  return {
    returnedResult: bounded.value.length > 0 ? bounded.value : null,
    returnedResultEmpty: empty ? 1 : 0,
    returnedResultTruncated:
      bounded.truncated || raw.returnedResultTruncated === true || raw.returnedResultTruncated === 1
        ? 1
        : 0,
  };
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
    value.parentContext === 'none'
    || value.parentContext === 'snapshot'
    || value.parentContext === 'live'
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

/**
 * Union of `values` then `incoming`, deduped, capped to `max` by **rolling the
 * window** — the oldest entries are evicted, never the newest.
 *
 * Truncating the head instead (the previous `slice(0, max)`) silently dropped
 * every id seen after the cap was reached. For `providerRunIds` that broke two
 * things at once: the detail and transcript readers select durable generations
 * by membership — and the transcript reader walks this array in order, oldest
 * first (`ipc/subagentRuns.ts`) — so the panel pinned itself to an old
 * generation forever; and `persistSubagentTaskUpdate`
 * decides "this is a resume" by asking whether any incoming id is absent from
 * the persisted list, so a current id that could never land re-fired `resumed`
 * on every reconciliation tick, reopening the terminal row and discarding its
 * result each time.
 *
 * Newest therefore has to stay at the tail: eviction is from the front, and new
 * ids keep appending. Ids that age out remain resolvable through the
 * append-only `subagent_run_aliases` index, which is never pruned.
 */
function mergeUnique(
  values: readonly string[],
  incoming: readonly (string | undefined)[],
  max: number,
): string[] {
  const out = new Set(values);
  for (const raw of incoming) {
    const value = boundedText(raw, TEXT_LIMITS.id);
    if (value) out.add(value);
  }
  return out.size <= max ? [...out] : [...out].slice(-max);
}

const TERMINAL_SUBAGENT_STATUSES: readonly SubagentRunStatus[] = [
  'completed',
  'failed',
  'stopped',
];

function terminal(status: SubagentRunStatus): boolean {
  return TERMINAL_SUBAGENT_STATUSES.includes(status);
}

/**
 * Is this row a Cindy-owned detached runner that is still working?
 *
 * `stop` is the one capability only `PI_DURABLE_SUBAGENT_CAPABILITIES` carries,
 * so it reads exactly as "a process outside the parent's turn is running and
 * the user must be able to reach it". A synchronous PI child, a Claude `Agent`
 * or a Codex spawn dies with the turn that started it and never advertises it.
 */
function isActiveDurableRow(row: Pick<SubagentRunRow, 'status' | 'capabilities'>): boolean {
  return !terminal(row.status) && parseCapabilities(row.capabilities).stop;
}

/** SQL half of {@link isActiveDurableRow}; the two must stay in step. */
function activeDurableRun(): SQL {
  return and(
    notInArray(subagentRuns.status, [...TERMINAL_SUBAGENT_STATUSES]),
    // `capabilities` is only ever written here via JSON.stringify and defaults
    // to '{}', but json_extract *throws* on malformed JSON and that would take
    // the whole Subagents list down with it — so read it the same fail-closed
    // way `parseCapabilities` does.
    sql`(json_valid(${subagentRuns.capabilities}) = 1
      AND json_extract(${subagentRuns.capabilities}, '$.stop') IS 1)`,
  )!;
}

/**
 * ## Subagent row visibility: the whole boundary table
 *
 * Four boundaries can hide a run, and they do *not* all mean the same thing.
 * `/clear` and Rewind withdraw **conversation**; neither of them stops work.
 * Both leave a durable PI Subagent's detached runner deliberately running — it
 * keeps spending credentials, calling tools and writing the workspace — so
 * hiding its row takes away the Subagents tab and the only stop entry the user
 * has, over a process that PI Full Access runs with no OS sandbox underneath.
 *
 * | boundary                     | applies to        | live durable run | terminal run |
 * | ---------------------------- | ----------------- | ---------------- | ------------ |
 * | `/clear` (`sessions.clearedAt` vs `startedAt`) | row  | exempt | hidden |
 * | Rewind (`subagentRuns.rewindAt`)               | row  | exempt | hidden |
 * | parent `tool_use` rewound / absent             | parent msg | exempt | hidden |
 * | parent `tool_use` before `clearedAt`           | parent msg | exempt | hidden |
 * | deletion (`subagentRuns.deletedAt`)            | row  | **hidden** | hidden |
 *
 * The single rule behind the first four: *a run that is still doing work stays
 * reachable; once it reaches a terminal state it is archived behind whichever
 * boundary applies*, because at that point it is history and history is exactly
 * what the user withdrew. The durable transcript stays on disk either way.
 *
 * Deletion is deliberately not on the exemption list — that path is real
 * cleanup and owns stopping the child itself.
 */
function clearBoundary(clearedAt: number | null): SQL[] {
  if (clearedAt === null) return [];
  return [or(gt(subagentRuns.startedAt, clearedAt), activeDurableRun())!];
}

/**
 * Rewind's half of the table above; symmetric with {@link clearBoundary}.
 *
 * The rewind transaction stamps `rewind_at` on the run (by parent tool call, or
 * by `started_at` for a parentless tail) in the same commit that stamps the
 * messages. PI's rewind only re-cuts the parent session tree, so the detached
 * runner survives it exactly as it survives `/clear`.
 */
function rewindBoundary(): SQL[] {
  return [or(isNull(subagentRuns.rewindAt), activeDurableRun())!];
}

function initialCapabilities(update: AgentTaskUpdate): Readonly<SubagentCapabilities> {
  return update.provider === 'pi' && update.taskType === 'pi_subagent'
    ? PI_DURABLE_SUBAGENT_CAPABILITIES
    : SUBAGENT_PR1_CAPABILITIES;
}

/**
 * A PI durable run's own status record is the authority for that task.
 *
 * It is written by the runner and reconciled by generation, and it never walks
 * a terminal state backwards on its own — so when one of these arrives it
 * replaces whatever a *diagnostic* projection put on the row, rather than
 * merging with it. Without that, one transient unreadable status was permanent:
 * the diagnostic wrote `failed` plus the reduced PR1 capability set, and every
 * later healthy write was then absorbed by the failed state and inherited the
 * reduced capabilities, so the row never showed the finished result again and
 * lost its transcript and resume affordances.
 */
function isPiDurableAuthority(update: AgentTaskUpdate): boolean {
  return update.provider === 'pi' && update.taskType === 'pi_subagent';
}

function capabilitiesForUpdate(
  update: AgentTaskUpdate,
  data: unknown,
  existing?: SubagentRunRow,
): SubagentCapabilities {
  if (update.provider === 'pi' && update.taskType === 'pi_subagent_diagnostic') {
    return { ...SUBAGENT_PR1_CAPABILITIES };
  }
  // Rebuilt, not inherited: the row may be carrying the diagnostic's reduced
  // set, and this update is the authority for what the run can actually do.
  const current = existing && !isPiDurableAuthority(update)
    ? parseCapabilities(existing.capabilities)
    : { ...initialCapabilities(update) };
  if (!data || typeof data !== 'object' || Array.isArray(data)) return current;
  const context = (data as Record<string, unknown>).subagentParentContext;
  return context === 'none' || context === 'snapshot' || context === 'live'
    ? { ...current, parentContext: context }
    : current;
}

function mergeStatus(
  previous: SubagentRunStatus | undefined,
  next: SubagentRunStatus,
  provider: SubagentProvider,
  resume = false,
  authoritative = false,
): SubagentRunStatus {
  if (!previous || resume || authoritative) return next;
  if (previous === 'failed' || previous === 'stopped') return previous;
  // Codex can discover a running descendant after the direct child appeared
  // complete; that is aggregate expansion, not resurrection of a failed run.
  if (previous === 'completed' && next === 'running' && provider !== 'codex') return previous;
  return next;
}

function activityKind(
  status: SubagentRunStatus,
  created: boolean,
  resumed = false,
): SubagentActivityEntry['kind'] {
  if (resumed) return 'resumed';
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
  resumed = false,
): SubagentActivityEntry[] {
  const summary = boundedText(update.summary ?? update.description, TEXT_LIMITS.activitySummary);
  const lastToolName = boundedText(update.lastToolName, TEXT_LIMITS.lastToolName);
  const kind = activityKind(status, created, resumed);
  const previous = current.at(-1);
  if (
    previous
    && update.provider === 'pi'
    && previous.kind === kind
    && previous.status === status
  ) {
    const replacement: SubagentActivityEntry = {
      ...previous,
      ...(summary ? { summary } : {}),
      ...(lastToolName ? { lastToolName } : {}),
      occurredAt,
    };
    return [...current.slice(0, -1), replacement];
  }
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

function rowToRun(row: SubagentRunRow, localArtifacts = true): SubagentRun {
  const usage = {
    ...(row.totalTokens !== null ? { totalTokens: row.totalTokens } : {}),
    ...(row.toolUses !== null ? { toolUses: row.toolUses } : {}),
    ...(row.durationMs !== null ? { durationMs: row.durationMs } : {}),
    ...(row.provider === 'pi' && row.costUsd !== null ? { costUsd: row.costUsd } : {}),
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
    capabilities: localArtifacts
      ? parseCapabilities(row.capabilities)
      : {
          ...parseCapabilities(row.capabilities),
          viewFullTranscript: false,
          resume: false,
          steer: false,
          stop: false,
        },
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
    ...rewindBoundary(),
    isNull(subagentRuns.deletedAt),
    ...clearBoundary(clearedAt),
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
  // An observation older than the clear boundary belongs to history the user
  // just dismissed: it must not rebuild a cleared row, and must not reopen one
  // that already finished. Runs are the exception, not events — a durable
  // runner that survived the clear is still emitting, and *every* frame it
  // sends from here on is stamped with its original pre-clear `createdAt`. Left
  // unqualified this guard froze exactly the row the user needs to watch: the
  // reconciler could no longer advance its status, so it could never reach a
  // terminal state on screen either. Scoped to an already-existing, still-active
  // durable row, so it still refuses to *create* anything from stale history.
  if (
    session.clearedAt !== null
    && update.createdAt
    && finiteTime(update.createdAt, Number.MAX_SAFE_INTEGER) <= session.clearedAt
    && !(existing && isActiveDurableRow(existing))
  ) return null;
  // A progress/terminal event is never authority to invent a child or attach a
  // control call's receiver ids to an arbitrary existing run.
  if (!existing && observation.kind !== 'spawn') return null;
  // Durable reconciliation repeats after the parent handle is unloaded. Once a
  // launch message was rewound, never recreate a hidden PI row on every Fleet
  // read; the still-running child remains stoppable through deletion cleanup.
  if (
    !existing
    && update.provider === 'pi'
    && (update.taskType === 'pi_subagent' || update.taskType === 'pi_subagent_diagnostic')
    && update.createdAt
    && observation.parentToolUseId
  ) {
    const visibleParents = await visibleParentToolUseIds(
      sessionId,
      [observation.parentToolUseId],
      session.clearedAt,
    );
    if (!visibleParents.has(observation.parentToolUseId)) return null;
  }
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
  const existingProviderRunIds = existing ? parseStringArray(existing.providerRunIds) : [];
  const isPiDurable = update.provider === 'pi' && update.taskType === 'pi_subagent';
  const resumed = Boolean(
    isPiDurable
    && existing
    && terminal(existing.status)
    && observation.kind === 'spawn'
    && incomingProviderRunIds.some((id) => !existingProviderRunIds.includes(id)),
  );
  const startedAt = existing?.startedAt ?? finiteTime(update.createdAt, updatedAt);
  const status = mergeStatus(
    existing?.status,
    update.status,
    update.provider,
    resumed,
    isPiDurableAuthority(update),
  );
  const aliases = mergeUnique(
    existing ? parseStringArray(existing.aliases) : [],
    incomingIdentityAliases,
    MAX_ALIAS_COUNT,
  );
  const providerRunIds = mergeUnique(
    existingProviderRunIds,
    incomingProviderRunIds,
    MAX_PROVIDER_RUN_IDS,
  );
  let activity = appendActivity(
    existing ? parseActivity(existing.activity) : [],
    update,
    status,
    updatedAt,
    !existing,
    resumed,
  );
  if (resumed && terminal(status)) {
    activity = appendActivity(activity, update, status, updatedAt, false);
  }
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
    summary:
      boundedText(update.summary, TEXT_LIMITS.summary) ?? (resumed ? null : existing?.summary ?? null),
    model:
      update.model === null
        ? null
        : (boundedText(update.model, TEXT_LIMITS.model) ?? existing?.model ?? null),
    reasoningEffort:
      boundedText(update.reasoningEffort, TEXT_LIMITS.reasoningEffort) ??
      existing?.reasoningEffort ??
      null,
    totalTokens:
      boundedNumber(update.usage?.totalTokens) ?? (resumed ? null : existing?.totalTokens ?? null),
    toolUses: boundedNumber(update.usage?.toolUses) ?? (resumed ? null : existing?.toolUses ?? null),
    durationMs:
      boundedNumber(update.usage?.durationMs) ?? (resumed ? null : existing?.durationMs ?? null),
    costUsd: isPiDurable
      ? boundedCost(update.usage?.costUsd) ?? (resumed ? null : existing?.costUsd ?? null)
      : existing?.costUsd ?? null,
    capabilities: JSON.stringify(capabilitiesForUpdate(update, data, existing)),
    activity: JSON.stringify(activity),
    ...(isPiDurable
      ? returnedResultValues(data, terminal(status), existing, resumed)
      : returnedResultValues(undefined, false, existing)),
    startedAt,
    updatedAt: Math.max(existing?.updatedAt ?? 0, updatedAt),
    endedAt: terminal(status) ? (resumed ? updatedAt : existing?.endedAt ?? updatedAt) : null,
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
        ...rewindBoundary(),
        isNull(subagentRuns.deletedAt),
        ...clearBoundary(session.clearedAt),
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

async function readableSession(sessionId: string): Promise<{
  clearedAt: number | null;
  remoteHostId: string | null;
} | null> {
  const [session] = await getDbClient()
    .drizzle.select({ clearedAt: sessions.clearedAt, remoteHostId: sessions.remoteHostId })
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
        ...rewindBoundary(),
        isNull(subagentRuns.deletedAt),
        ...clearBoundary(session.clearedAt),
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

/**
 * Newest non-rewound `tool_use` row per candidate id.
 *
 * The `/clear` bound used to sit in this query next to the rewind bound. It is
 * lifted out so callers can apply the two halves separately: a rewound launch
 * message hides its run unconditionally, while the clear boundary is waived for
 * a still-running durable runner (see {@link clearBoundary}). Without that
 * split, exempting the run's `startedAt` achieved nothing — its launch tool call
 * is by definition older than the clear it survived, so this filter dropped the
 * row again one step later.
 *
 * Keeping only the newest occurrence is equivalent to the old set membership:
 * an id was visible iff *any* of its rows cleared the bound, which is exactly
 * the maximum clearing it.
 */
async function parentToolUseCreatedAt(
  sessionId: string,
  candidates: string[],
): Promise<Map<string, number>> {
  if (candidates.length === 0) return new Map();
  const rows = await getDbClient()
    .drizzle.select({ toolUseId: messages.toolUseId, createdAt: messages.createdAt })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.role, 'tool_use'),
        inArray(messages.toolUseId, candidates),
        isNull(messages.rewindAt),
      ),
    );
  const newest = new Map<string, number>();
  for (const row of rows) {
    if (!row.toolUseId) continue;
    const current = newest.get(row.toolUseId);
    if (current === undefined || row.createdAt > current) newest.set(row.toolUseId, row.createdAt);
  }
  return newest;
}

/** Both halves applied — the visibility a row without a live runner gets. */
async function visibleParentToolUseIds(
  sessionId: string,
  candidates: string[],
  clearedAt: number | null,
): Promise<Set<string>> {
  const newest = await parentToolUseCreatedAt(sessionId, candidates);
  const visible = new Set<string>();
  for (const [toolUseId, createdAt] of newest) {
    if (clearedAt === null || createdAt > clearedAt) visible.add(toolUseId);
  }
  return visible;
}

/** Is this row's launch tool call still visible to the reader? */
function parentVisible(
  row: SubagentRunRow,
  parentCreatedAt: ReadonlyMap<string, number>,
  clearedAt: number | null,
): boolean {
  if (!row.parentToolUseId) return true;
  // A live durable runner clears both halves of this check at once — see the
  // boundary table on `clearBoundary`. Its launch tool call is by definition
  // inside the range a rewind withdraws or a clear archives, so leaving either
  // half in force here would hide the row again one step after the row-level
  // exemption let it through.
  if (isActiveDurableRow(row)) return true;
  const createdAt = parentCreatedAt.get(row.parentToolUseId);
  // Rewound or absent: hidden regardless of which boundary got there first.
  if (createdAt === undefined) return false;
  return clearedAt === null || createdAt > clearedAt;
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
  options: { cursor?: string; limit?: number; provider?: SubagentProvider } = {},
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
    ...rewindBoundary(),
    isNull(subagentRuns.deletedAt),
    ...(options.provider ? [eq(subagentRuns.provider, options.provider)] : []),
  ];
  baseConditions.push(...clearBoundary(session.clearedAt));
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
    const parentCreatedAt = await parentToolUseCreatedAt(sessionId, parentIds);
    visibleRows.push(
      ...batch.filter((row) => parentVisible(row, parentCreatedAt, session.clearedAt)),
    );
    const lastScanned = batch[batch.length - 1];
    scanCursor = { startedAt: lastScanned.startedAt, id: lastScanned.id };
    exhausted = batch.length < pageSize + 1;
  }
  const page = visibleRows.slice(0, pageSize);
  const runs = page.map((row) => rowToRun(row, session.remoteHostId === null));
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
    ...rewindBoundary(),
    isNull(subagentRuns.deletedAt),
    ...clearBoundary(clearedAt),
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
    const parentCreatedAt = await parentToolUseCreatedAt(sessionId, [row.parentToolUseId]);
    if (!parentVisible(row, parentCreatedAt, session.clearedAt)) return null;
  }

  const run = rowToRun(row, session.remoteHostId === null);
  let returnedResult: string | undefined;
  let returnedResultTruncated = false;
  if (
    row.provider === 'pi' &&
    run.capabilities.viewReturnedResult &&
    terminal(row.status) &&
    (row.returnedResult !== null || row.returnedResultEmpty === 1)
  ) {
    if (row.returnedResult) {
      const bounded = truncateUtf8(row.returnedResult, MAX_RETURNED_RESULT_BYTES);
      returnedResult = bounded.value;
      returnedResultTruncated = row.returnedResultTruncated === 1 || bounded.truncated;
    }
  } else if (
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
    // Claude and PI background tool results are only launch receipts. Once the
    // durable task reaches terminal state, expose the terminal observation
    // summary instead of presenting the stale receipt as the returned result.
    const receiptToolName = row.provider === 'pi' ? 'subagent' : 'Agent';
    const returnedText = subagentSpawnResultIndicatesRunning(receiptToolName, text)
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
