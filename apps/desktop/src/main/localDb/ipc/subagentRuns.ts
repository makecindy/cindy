/** Read-only renderer IPC for Cindy-owned durable Subagent records. */

import { createHash } from 'node:crypto';
import path from 'node:path';

import { app, BrowserWindow, ipcMain } from 'electron';
import {
  isPiSubagentTerminal,
  listPiSubagentRunDiagnostics,
  listPiSubagentRuns,
  piSubagentRunRoot,
  readPiSubagentTranscriptPage,
} from '@cindy/maker-core/pi-subagent-runs';
import {
  SUBAGENT_RUNS_CHANGED_CHANNEL,
  type SubagentCapabilities,
  type SubagentProvider,
  type SubagentRunDetailResponse,
  type SubagentRunStatus,
  type SubagentRunsChangedPayload,
  type SubagentTranscriptPageResponse,
  type SubagentRunsListResponse,
} from '@cindy/maker-shared/subagent-workspace';

import { activeOwnerScopeKey, getActiveDataOwnerPushStamp } from '../../appSessionState.js';
import { isDeviceLinkInvoke } from '../../device-link/invoke-context.js';
import {
  isDataOwnerBroadcastScopeCurrent,
  type DataOwnerBroadcastScope,
} from '../../device-link/broadcast-tap.js';
import {
  assertTrustedAppRendererEvent,
  isTrustedAppRendererWindow,
} from '../../security/trustedAppRenderer.js';
import {
  requireEnum,
  requireNonNegativeInt,
  requireObject,
  requireString,
} from '../../utils/ipcValidate.js';
import {
  getSubagentRunDetail,
  listSubagentRuns,
  persistSubagentTaskUpdate,
} from '../subagentRuns.js';

const RUN_DIRECTORY_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Write-skip cache for reconciliation.
 *
 * Both the list and the detail IPC reconcile, and the remote detail view polls
 * both once a second, so a session with N historical runs produced ~2N SQLite
 * writes per second with nothing changing — every readable run re-wrote its
 * alias rows and main row on each poll, and several controllers multiplied that
 * into write-lock contention.
 *
 * The fingerprint is taken over the *exact payload* that would be persisted
 * rather than a hand-picked field list, so it cannot drift from what the UI
 * renders: a terminal run whose truncated output is later backfilled changes
 * the payload, therefore changes the fingerprint, therefore still writes.
 *
 * Scoped by owner key so a stale entry can never suppress the first write into
 * a replaced database, and bounded so a long-lived process cannot grow it
 * without limit.
 */
const RECONCILE_FINGERPRINT_SESSION_LIMIT = 64;
let reconcileFingerprintOwnerKey: string | null = null;
const reconcileFingerprints = new Map<string, Map<string, string>>();

/** The two projections of one task; a write under either invalidates the other. */
const RUN_FINGERPRINT_PREFIX = 'run:';
const DIAGNOSTIC_FINGERPRINT_PREFIX = 'diagnostic:';

function reconcileFingerprintsFor(sessionId: string, ownerKey: string): Map<string, string> {
  if (reconcileFingerprintOwnerKey !== ownerKey) {
    reconcileFingerprintOwnerKey = ownerKey;
    reconcileFingerprints.clear();
  }
  let perSession = reconcileFingerprints.get(sessionId);
  if (!perSession) {
    if (reconcileFingerprints.size >= RECONCILE_FINGERPRINT_SESSION_LIMIT) {
      const oldest = reconcileFingerprints.keys().next();
      if (!oldest.done) reconcileFingerprints.delete(oldest.value);
    }
    perSession = new Map();
    reconcileFingerprints.set(sessionId, perSession);
  }
  return perSession;
}

function reconcileFingerprint(update: unknown, observedAt: number): string {
  return createHash('sha1').update(JSON.stringify([update, observedAt])).digest('base64');
}

/** Test-only: forget every cached fingerprint. */
export function __resetSubagentReconcileFingerprintsForTests(): void {
  reconcileFingerprintOwnerKey = null;
  reconcileFingerprints.clear();
}

/**
 * Serialiser for durable Subagent projection writes.
 *
 * The agent event path writes this projection through the main-process durable
 * FIFO (`enqueueDurableWrite`). Reconciliation used to call
 * `persistSubagentTaskUpdate` directly, so the first sighting of a run could be
 * projected twice: both writers read "no matching row" and both inserted, and
 * no unique constraint stops a duplicate at that visible generation — the
 * sidebar then shows the same Subagent twice and later updates land on only one
 * of the rows.
 *
 * Injected rather than imported: `messagePersistBroadcaster` (which owns the
 * FIFO) already imports `localDb/client` and `localDb/schema`, so importing it
 * back from here would close a module cycle and invert the storage layering.
 * The composition root (`localDb/ipc/registerAll.ts`) already depends upward on
 * main-level modules, so it is the clean place to supply it.
 *
 * An atomic select-then-insert inside one SQLite transaction was the other
 * candidate. It is not reachable cheaply: `DbClient.drizzle` is a
 * `createDrizzleProxy` over a worker transport, so better-sqlite3's synchronous
 * transaction is not available in this process and a transactional op would
 * have to be added to the worker protocol first.
 */
type DurableWriteEnqueue = <T>(label: string, fn: () => Promise<T> | T) => Promise<T>;

/** No queue injected (unit tests): run inline, preserving the previous shape. */
const runProjectionWriteDirectly: DurableWriteEnqueue = (_label, fn) =>
  Promise.resolve().then(fn);

let enqueueProjectionWrite: DurableWriteEnqueue = runProjectionWriteDirectly;

/**
 * Is this durable status still the newest generation of its logical task?
 *
 * One logical task can have several durable generations after a resume, and a
 * generation whose state file is stale or corrupt is missing from
 * `listPiSubagentRuns` altogether — it only surfaces as a diagnostic. So the
 * newest generation is the truth whether it is a healthy status or a
 * diagnostic, and any healthy status a strictly newer diagnostic supersedes is
 * the *previous* run's answer, not this one's.
 *
 * Shared by reconciliation (which decides what the projected row says) and by
 * the detail projection (which decides whether that generation's children and
 * result may be laid over the row). A second copy of this comparison would
 * drift, and the two disagreeing is exactly the failure this guards: the row
 * read "failed" while the detail view still rendered the superseded
 * generation's completed output.
 */
function isNewestPiGeneration(
  status: { taskId: string; updatedAt: number },
  newestDiagnosticUpdatedAt: ReadonlyMap<string, number>,
): boolean {
  const newerDiagnostic = newestDiagnosticUpdatedAt.get(status.taskId);
  return newerDiagnostic === undefined || newerDiagnostic <= status.updatedAt;
}

/**
 * Reconcile the durable PI records into the projection, and report the newest
 * diagnostic generation per task so the caller can judge generation recency on
 * the same snapshot the row was just written from.
 */
async function reconcilePiDurableRuns(sessionId: string): Promise<ReadonlyMap<string, number>> {
  const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
  const statuses = await listPiSubagentRuns(piSubagentRunRoot(agentHome, sessionId));
  const fingerprints = reconcileFingerprintsFor(sessionId, activeOwnerScopeKey());
  const persistIfChanged = async (
    key: string,
    update: Record<string, unknown>,
    observedAt: number,
  ): Promise<void> => {
    const fingerprint = reconcileFingerprint(update, observedAt);
    if (fingerprints.get(key) === fingerprint) return;
    const written = await enqueueProjectionWrite(`subagent_reconcile:${sessionId}:${key}`, () =>
      persistSubagentTaskUpdate(sessionId, update, 'pi', observedAt));
    // Only a write earns a memo. `persistSubagentTaskUpdate` returns null from
    // every guard that runs *before* it touches the database — most importantly
    // "the parent tool_use is not visible yet", which a fast run hits routinely:
    // the child reaches a terminal state before the parent's own durable write
    // has left the FIFO. Memoising that refusal was permanent for exactly the
    // records it hurt most: a terminal status never changes again, so its
    // fingerprint never changes either, and every later reconciliation skipped
    // the write. The Subagent stayed invisible in the sidebar until the
    // process-level cache was evicted. Leaving both the memo and the
    // counterpart untouched makes the next read retry, and the ordering window
    // closes itself.
    //
    // A throw is already handled by the await above sitting before this line —
    // an enqueued write that fails never records a fingerprint either.
    if (written === null) return;
    fingerprints.set(key, fingerprint);
    // Both keys project the *same row*, so whichever one just wrote has to
    // clear the other's memo. Without that, one transient unreadable status —
    // a Windows sharing conflict on an already reconciled terminal record is
    // enough — writes the row as failed under the diagnostic key, and when the
    // file becomes readable again the healthy key's fingerprint is unchanged,
    // so its write is skipped and the row stays failed forever. Reached only
    // after a real write, so a refused projection cannot invalidate the other
    // key's memo either — nothing changed on the row for it to disagree with.
    const counterpart = key.startsWith(RUN_FINGERPRINT_PREFIX)
      ? `${DIAGNOSTIC_FINGERPRINT_PREFIX}${key.slice(RUN_FINGERPRINT_PREFIX.length)}`
      : key.startsWith(DIAGNOSTIC_FINGERPRINT_PREFIX)
        ? `${RUN_FINGERPRINT_PREFIX}${key.slice(DIAGNOSTIC_FINGERPRINT_PREFIX.length)}`
        : null;
    if (counterpart !== null) fingerprints.delete(counterpart);
  };
  // One logical task can have several durable generations after resume, and the
  // healthy and unreadable sets are walked separately. Pick per task by
  // generation recency across *both* sets: the newest generation is the truth,
  // whether it is a healthy status or a stale/corrupt diagnostic. Walking health
  // first and dropping any diagnostic for a task already seen showed last run's
  // completed result while this run's crash stayed hidden.
  const diagnostics = (await listPiSubagentRunDiagnostics(piSubagentRunRoot(agentHome, sessionId)))
    .filter((diagnostic) => Boolean(diagnostic.taskId))
    .filter((diagnostic) => !diagnostic.parentSessionId || diagnostic.parentSessionId === sessionId);
  const newestDiagnosticUpdatedAt = new Map<string, number>();
  for (const diagnostic of diagnostics) {
    const taskId = diagnostic.taskId!;
    const current = newestDiagnosticUpdatedAt.get(taskId);
    if (current === undefined || diagnostic.updatedAt > current) {
      newestDiagnosticUpdatedAt.set(taskId, diagnostic.updatedAt);
    }
  }
  const seenTaskIds = new Set<string>();
  for (const status of statuses) {
    if (seenTaskIds.has(status.taskId)) continue;
    // A strictly newer unreadable generation wins: this run crashed, and the
    // previous generation's result must not stand in for it.
    if (!isNewestPiGeneration(status, newestDiagnosticUpdatedAt)) continue;
    seenTaskIds.add(status.taskId);
    const terminal = isPiSubagentTerminal(status.state);
    const projectedStatus = status.state === 'queued' ? 'running' : status.state;
    const bodies = terminal
      ? status.tasks.map((task) => [
          task.output,
          task.error ? `Error: ${task.error}` : undefined,
        ].filter((part): part is string => Boolean(part)).join('\n\n'))
      : [];
    const hasResult = bodies.some(Boolean);
    const returnedResult = hasResult
      ? status.tasks.map((task, index) => status.tasks.length === 1
          ? bodies[index]
          : `## ${task.title ?? task.agent}\n\n${bodies[index] || '(no output)'}`,
        ).join('\n\n')
      : undefined;
    const models = new Set(status.tasks.map((task) => task.model).filter(Boolean));
    const thinking = new Set(status.tasks.map((task) => task.thinking).filter(Boolean));
    await persistIfChanged(`${RUN_FINGERPRINT_PREFIX}${status.taskId}`, {
      provider: 'pi',
      taskId: status.taskId,
      parentToolUseId: status.taskId,
      status: projectedStatus,
      taskType: 'pi_subagent',
      subagentParentContext: status.context === 'fork' ? 'snapshot' : 'none',
      title: status.title,
      description: status.description,
      ...(returnedResult ? {
        summary: returnedResult.slice(0, 2_000),
        returnedResult,
      } : terminal ? { returnedResultEmpty: true } : {}),
      ...(status.tasks.some((task) => task.outputTruncated) ? { returnedResultTruncated: true } : {}),
      ...(models.size === 1 ? { model: [...models][0] } : {}),
      ...(thinking.size === 1 ? { reasoningEffort: [...thinking][0] } : {}),
      usage: {
        totalTokens: status.totalTokens,
        toolUses: status.toolUses,
        durationMs: Math.max(0, (status.endedAt ?? status.updatedAt) - status.startedAt),
        costUsd: status.usage?.cost,
      },
      createdAt: new Date(status.startedAt).toISOString(),
      subagentObservation: {
        kind: 'spawn',
        logicalSubagentId: status.runId,
        parentToolUseId: status.taskId,
        providerRunIds: [status.runId, ...status.tasks.map((task) => task.childId)],
      },
      updatedAt: new Date(status.updatedAt).toISOString(),
    }, status.updatedAt);
  }
  // A durable diagnostic without the original parent tool-use id cannot be
  // placed in the current message generation safely; it was filtered out above.
  // Keeping it on disk lets doctor/cleanup inspect it, while omitting it here
  // prevents a corrupt run from reappearing after its branch was rewound.
  const seenDiagnosticTaskIds = new Set<string>();
  for (const diagnostic of diagnostics.sort((left, right) => right.updatedAt - left.updatedAt)) {
    // `seenTaskIds` now only holds tasks whose healthy generation was the
    // newest, so an older diagnostic still loses to it — and a newer one no
    // longer gets dropped just because health was walked first.
    if (seenTaskIds.has(diagnostic.taskId!) || seenDiagnosticTaskIds.has(diagnostic.taskId!)) continue;
    // Unreadable status.json (`corrupt`) is not proof of death — Windows sharing
    // conflicts hit live runners too. Projecting `failed` strips the active-run
    // visibility exemption, after which matchingRow cannot find the row behind
    // a /clear or rewind boundary and refuses to recreate it. Stale (parsed,
    // runner gone) remains the only diagnostic allowed to close the row.
    if (diagnostic.kind === 'corrupt') continue;
    seenDiagnosticTaskIds.add(diagnostic.taskId!);
    await persistIfChanged(`${DIAGNOSTIC_FINGERPRINT_PREFIX}${diagnostic.taskId}`, {
      provider: 'pi',
      taskId: diagnostic.taskId,
      parentToolUseId: diagnostic.taskId,
      status: 'failed',
      taskType: 'pi_subagent_diagnostic',
      title: diagnostic.title ?? 'Unavailable PI Subagent run',
      description: diagnostic.description,
      summary: diagnostic.message,
      createdAt: new Date(diagnostic.startedAt).toISOString(),
      subagentObservation: {
        kind: 'spawn',
        logicalSubagentId: diagnostic.runId,
        parentToolUseId: diagnostic.taskId,
        providerRunIds: [diagnostic.runId],
      },
      updatedAt: new Date(diagnostic.updatedAt).toISOString(),
    }, diagnostic.updatedAt);
  }
  return newestDiagnosticUpdatedAt;
}

const SUBAGENT_PROVIDERS = [
  'claude-code',
  'codex',
  'pi',
] as const satisfies readonly SubagentProvider[];

export function broadcastSubagentRunsChanged(
  payload: SubagentRunsChangedPayload,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  if (ownerScope && !isDataOwnerBroadcastScopeCurrent(ownerScope)) return;
  const hasCapturedScope = ownerScope !== undefined && ownerScope !== null;
  const ownerStamp = hasCapturedScope
    ? ownerScope.ownerStamp
    : getActiveDataOwnerPushStamp();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed() && isTrustedAppRendererWindow(window)) {
      try {
        window.webContents.send(SUBAGENT_RUNS_CHANGED_CHANNEL, payload, ownerStamp);
      } catch {
        // One closing renderer must not prevent invalidation of the others.
      }
    }
  }
}

export function broadcastSubagentRunsInvalidated(
  sessionId: string,
  ownerScope?: DataOwnerBroadcastScope | null,
): void {
  broadcastSubagentRunsChanged(
    {
      sessionId,
      runId: null,
      created: false,
      firstForSession: false,
    },
    ownerScope,
  );
}

/**
 * Is the parent task loaded as a live PI session right now?
 *
 * Injected from the composition root rather than imported, because the storage
 * layer must not reach back into the Maker (see the durable-write note below).
 * Absent means "assume it is" — the pre-existing behaviour, so a caller that
 * does not wire this up is unchanged.
 */
type ParentPiSessionLivePredicate = (sessionId: string) => boolean;

let isParentPiSessionLive: ParentPiSessionLivePredicate = () => true;

/**
 * `resume` is only actually available while the parent task is a loaded PI
 * session: the handler resolves `maker.getSession(sessionId)` and refuses
 * otherwise. After a Desktop restart a user can browse a finished run's detail
 * without that session ever being loaded, and the stored projection still
 * advertised `resume: true` — so the sidebar offered a follow-up composer whose
 * every send was guaranteed to fail with UNSUPPORTED_CAPABILITY.
 *
 * Masked on the way out, never in the row: the capability is a property of the
 * current runtime, not of the run, and it comes back by itself on the next
 * detail poll once the task is opened.
 */
function maskUnavailableResume<T extends { status: SubagentRunStatus; capabilities: SubagentCapabilities }>(
  run: T,
  sessionId: string,
): T {
  if (!run.capabilities.resume) return run;
  if (isParentPiSessionLive(sessionId)) return run;
  return { ...run, capabilities: { ...run.capabilities, resume: false } };
}

export function registerSubagentRunsIpc(
  options: {
    enqueueDurableWrite?: DurableWriteEnqueue;
    isParentPiSessionLive?: ParentPiSessionLivePredicate;
  } = {},
): void {
  enqueueProjectionWrite = options.enqueueDurableWrite ?? runProjectionWriteDirectly;
  isParentPiSessionLive = options.isParentPiSessionLive ?? (() => true);
  const assertTrustedCaller = (event: Electron.IpcMainInvokeEvent): void => {
    if (!isDeviceLinkInvoke()) assertTrustedAppRendererEvent(event);
  };
  ipcMain.handle('local-db:subagent-runs:list', async (event, input: unknown) => {
    assertTrustedCaller(event);
    const body = requireObject(input, 'subagent runs list input');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const cursor = body.cursor === undefined ? undefined : requireString(body.cursor, 'cursor');
    const limit = body.limit === undefined ? undefined : requireNonNegativeInt(body.limit, 'limit');
    await reconcilePiDurableRuns(sessionId);
    const page = await listSubagentRuns(sessionId, {
      cursor,
      limit,
      ...(isDeviceLinkInvoke() ? { provider: 'pi' as const } : {}),
    });
    return {
      supported: page !== null,
      runs: (page?.runs ?? []).map((run) => maskUnavailableResume(run, sessionId)),
      ...(page?.nextCursor ? { nextCursor: page.nextCursor } : {}),
    } satisfies SubagentRunsListResponse;
  });

  ipcMain.handle('local-db:subagent-runs:detail', async (event, input: unknown) => {
    assertTrustedCaller(event);
    const body = requireObject(input, 'subagent run detail input');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const provider = requireEnum(body.provider, SUBAGENT_PROVIDERS, 'provider');
    if (isDeviceLinkInvoke() && provider !== 'pi') {
      return { supported: false, run: null } satisfies SubagentRunDetailResponse;
    }
    const runIdOrAlias = requireString(body.runIdOrAlias, 'runIdOrAlias');
    // Reused by the projection below: generation recency has to be judged on
    // the same snapshot reconciliation just wrote the row from, not on a second
    // scan that could disagree with it.
    const newestDiagnosticUpdatedAt = provider === 'pi'
      ? await reconcilePiDurableRuns(sessionId)
      : new Map<string, number>();
    const run = await getSubagentRunDetail(sessionId, provider, runIdOrAlias);
    let projectedRun = run;
    if (run && provider === 'pi') {
      const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
      const statuses = await listPiSubagentRuns(piSubagentRunRoot(agentHome, sessionId));
      const belongsToRun = (candidate: { runId: string; taskId: string }): boolean => (
        candidate.runId === run.id
        || candidate.taskId === run.logicalAgentId
        || run.providerRunIds.includes(candidate.runId)
      );
      const status = statuses.find(belongsToRun);
      if (status && !isNewestPiGeneration(status, newestDiagnosticUpdatedAt)) {
        // A newer generation exists but its durable state is stale or corrupt,
        // so `listPiSubagentRuns` omits it and `find` lands on the previous,
        // still readable generation. Reconciliation has already written the row
        // as failed with the diagnostic message; laying this generation's
        // children and output over it republished last run's answer as the
        // crashed run's own result — completed children, a filled result body,
        // and the diagnostic nowhere on screen.
        //
        // The row keeps the earlier `returnedResult` on purpose (a durable
        // record of what was once returned survives a later failure), but the
        // detail view has no field that says "from an earlier generation": it
        // renders `returnedResult` as this run's result, and only falls back to
        // showing `summary` — the diagnostic message — when there is none. So
        // the projection drops both halves and lets the failed status and the
        // diagnostic summary stand alone. The earlier answer is still reachable
        // through the transcript, which is addressed per generation.
        const {
          returnedResult: _supersededResult,
          returnedResultTruncated: _supersededTruncated,
          ...withoutSupersededResult
        } = run;
        projectedRun = withoutSupersededResult;
      } else if (status) {
        // One logical child, one id per generation: a resume mints
        // `<newRunId>-<n>` for every task it carries over. What it does *not*
        // change is the PI session the task is resumed on — `sessionDir` and
        // `sessionId` are deliberately left pointing at the previous
        // generation — so the session is the stable identity, and grouping by
        // it recovers the whole chain. Position cannot: resuming a single child
        // of a parallel run re-indexes it to 1.
        const idsBySession = new Map<string, string[]>();
        for (const candidate of statuses) {
          if (!belongsToRun(candidate)) continue;
          for (const task of candidate.tasks) {
            if (!task.sessionId) continue;
            const ids = idsBySession.get(task.sessionId) ?? [];
            if (!ids.includes(task.childId)) ids.push(task.childId);
            idsBySession.set(task.sessionId, ids);
          }
        }
        projectedRun = {
          ...run,
          children: status.tasks.map((task) => ({
            id: task.childId,
            ...(() => {
              const aliases = (idsBySession.get(task.sessionId) ?? [])
                .filter((id) => id !== task.childId);
              return aliases.length > 0 ? { identityAliases: aliases } : {};
            })(),
            role: task.agent,
            title: task.title,
            task: task.task,
            status: task.status,
            model: task.model,
            reasoningEffort: task.thinking,
            usage: {
              ...(typeof task.toolUses === 'number' ? { toolUses: task.toolUses } : {}),
              ...(task.usage ? {
                totalTokens: (task.usage.input ?? 0)
                  + (task.usage.output ?? 0)
                  + (task.usage.cacheRead ?? 0)
                  + (task.usage.cacheWrite ?? 0),
              } : {}),
              ...(typeof task.usage?.cost === 'number' ? { costUsd: task.usage.cost } : {}),
              ...(typeof task.startedAt === 'number' ? {
                durationMs: Math.max(0, (task.endedAt ?? status.updatedAt) - task.startedAt),
              } : {}),
            },
            ...(task.pendingApproval ? { awaitingApproval: true } : {}),
            output: task.output,
            outputTruncated: task.outputTruncated,
            error: task.error,
          })),
        };
      }
    }
    return {
      supported: projectedRun !== undefined,
      run: projectedRun ? maskUnavailableResume(projectedRun, sessionId) : null,
    } satisfies SubagentRunDetailResponse;
  });

  ipcMain.handle('local-db:subagent-runs:transcript', async (event, input: unknown) => {
    assertTrustedCaller(event);
    const body = requireObject(input, 'subagent transcript input');
    const sessionId = requireString(body.sessionId, 'sessionId');
    const provider = requireEnum(body.provider, SUBAGENT_PROVIDERS, 'provider');
    if (isDeviceLinkInvoke() && provider !== 'pi') {
      return { supported: false, entries: [] } satisfies SubagentTranscriptPageResponse;
    }
    const runIdOrAlias = requireString(body.runIdOrAlias, 'runIdOrAlias');
    const cursor = body.cursor === undefined ? undefined : requireString(body.cursor, 'cursor');
    const requestedLimit = body.limit === undefined ? undefined : requireNonNegativeInt(body.limit, 'limit');
    const limit = isDeviceLinkInvoke()
      ? Math.min(requestedLimit ?? 25, 25)
      : requestedLimit;
    const run = await getSubagentRunDetail(sessionId, provider, runIdOrAlias);
    if (!run || provider !== 'pi' || !run.capabilities.viewFullTranscript) {
      return { supported: false, entries: [] } satisfies SubagentTranscriptPageResponse;
    }
    // `providerRunIds` is oldest-first (the rolling window in
    // `localDb/subagentRuns.ts` evicts from the front), so this is the run's
    // generations in the order they happened. Taking only the last one — what
    // this did — meant a follow-up that started a new generation erased the
    // original task, its replies and its tool cards from the panel, and made
    // every cursor held against the previous generation invalid. Generations
    // pushed out of that window are gone from here too; the conversation then
    // begins at the oldest one still listed.
    const generations = run.providerRunIds.filter((id) => RUN_DIRECTORY_ID.test(id));
    const nativeRunId = generations.at(-1);
    if (!nativeRunId) {
      return { supported: false, entries: [] } satisfies SubagentTranscriptPageResponse;
    }
    const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
    const root = piSubagentRunRoot(agentHome, sessionId);
    const response = await readPiSubagentTranscriptPage(
      root,
      generations,
      { cursor, limit },
    );
    // Child titles come from the newest generation: that is the status the
    // detail view shows, and a resumed child keeps its id across generations.
    const status = (await listPiSubagentRuns(root)).find((candidate) => candidate.runId === nativeRunId);
    if (!status) return response;
    const childTitles = new Map(status.tasks.map((task) => [task.childId, task.title ?? task.agent]));
    return {
      ...response,
      entries: response.entries.map((entry) => ({
        ...entry,
        ...(entry.childId && childTitles.has(entry.childId)
          ? { childTitle: childTitles.get(entry.childId) }
          : {}),
      })),
    };
  });
}
