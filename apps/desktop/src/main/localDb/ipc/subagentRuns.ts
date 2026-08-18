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
  type SubagentProvider,
  type SubagentRunDetailResponse,
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

async function reconcilePiDurableRuns(sessionId: string): Promise<void> {
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
    await enqueueProjectionWrite(`subagent_reconcile:${sessionId}:${key}`, () =>
      persistSubagentTaskUpdate(sessionId, update, 'pi', observedAt));
    fingerprints.set(key, fingerprint);
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
    const newerDiagnostic = newestDiagnosticUpdatedAt.get(status.taskId);
    if (newerDiagnostic !== undefined && newerDiagnostic > status.updatedAt) continue;
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
    await persistIfChanged(`run:${status.taskId}`, {
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
    seenDiagnosticTaskIds.add(diagnostic.taskId!);
    await persistIfChanged(`diagnostic:${diagnostic.taskId}`, {
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

export function registerSubagentRunsIpc(
  options: { enqueueDurableWrite?: DurableWriteEnqueue } = {},
): void {
  enqueueProjectionWrite = options.enqueueDurableWrite ?? runProjectionWriteDirectly;
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
      runs: page?.runs ?? [],
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
    if (provider === 'pi') await reconcilePiDurableRuns(sessionId);
    const run = await getSubagentRunDetail(sessionId, provider, runIdOrAlias);
    let projectedRun = run;
    if (run && provider === 'pi') {
      const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
      const status = (await listPiSubagentRuns(piSubagentRunRoot(agentHome, sessionId))).find(
        (candidate) => candidate.runId === run.id
          || candidate.taskId === run.logicalAgentId
          || run.providerRunIds.includes(candidate.runId),
      );
      if (status) {
        projectedRun = {
          ...run,
          children: status.tasks.map((task) => ({
            id: task.childId,
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
      run: projectedRun ?? null,
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
    const nativeRunId = [...run.providerRunIds]
      .reverse()
      .find((id) => RUN_DIRECTORY_ID.test(id));
    if (!nativeRunId) {
      return { supported: false, entries: [] } satisfies SubagentTranscriptPageResponse;
    }
    const agentHome = path.join(app.getPath('userData'), 'pi-agent-home');
    const root = piSubagentRunRoot(agentHome, sessionId);
    const response = await readPiSubagentTranscriptPage(
      root,
      nativeRunId,
      { cursor, limit },
    );
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
