import path from 'node:path';
import { and, eq } from 'drizzle-orm';
import { app } from 'electron';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { updateMessageContent } from '../localDb/ipc/messages.js';
import { withSessionRouteLock } from '../localDb/sessionRouteLock.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { cindyMakeManager } from './manager.js';
import { isCindyMakeWorktreePath, makeSourceRoot } from './sourcePaths.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
} from './toolchainEnvironment.js';
import { manageCindyMakeWorkspace, taskError, type MakeTaskAction } from './taskCleanup.js';
import type { MakeDoctorReport } from '../../shared/cindyMakeDoctor.js';
import { captureMakeHistoryReport } from './historyCapture.js';
import { captureMakeHistoryStore } from './historyOwner.js';

interface TaskManagementRuntime {
  isAlive(sessionId: string): boolean | undefined;
  isRunning(sessionId: string): boolean;
  isWorkspaceBusy?(workingDir: string): boolean;
  setStatus(
    sessionId: string,
    patch: { status: 'archived' | 'deleted'; pinnedAt: null },
  ): Promise<unknown>;
  recycle(sessionId: string, status: 'archived' | 'deleted'): Promise<void>;
}
let runtime: TaskManagementRuntime | undefined;
/** The composition root supplies runtime shutdown and canonical session writes. */
export function configureCindyMakeTaskManagement(deps: TaskManagementRuntime): void {
  runtime = deps;
}

let integrationRefresh: { isCurrent: () => boolean; done: Promise<void> } | undefined;

/** Refresh cell facts in the background; opening Settings never waits for Git file scans. */
export function refreshCindyMakeTaskIntegration(): Promise<void> {
  if (integrationRefresh?.isCurrent()) return integrationRefresh.done;
  const client = getDbClient();
  const owner = captureDataOwnerBroadcastScope();
  const userData = app.getPath('userData');
  const isCurrent = () => {
    try {
      return (
        isDataOwnerBroadcastScopeCurrent(owner) &&
        getDbClient() === client &&
        app.getPath('userData') === userData
      );
    } catch {
      return false;
    }
  };
  const job = { isCurrent, done: Promise.resolve() };
  integrationRefresh = job;
  job.done = (async () => {
    const reports = Object.values(cindyMakeManager.getState().tasks ?? {});
    if (!reports.length) return;
    const environment = await createMakeToolchainEnvironment(userData);
    const env = await resolveMakeToolEnvironment(environment, ['git'], AbortSignal.timeout(15_000));
    for (const report of reports) {
      if (!isCurrent()) return;
      if (!report.task || report.task.finished) continue;
      await cindyMakeManager.withProject(makeSourceRoot(userData), async () => {
        if (!isCurrent() || !cindyMakeManager.taskReport(report.runId)?.task) return;
        const busy = () =>
          !runtime ||
          runtime.isRunning(report.task!.sessionId) ||
          cindyMakeManager.isTaskPreparing(report.task!.sessionId) ||
          !!cindyMakeManager.getState().taskActions?.[report.task!.sessionId];
        let integration: NonNullable<MakeDoctorReport['task']>['integration'] = 'unknown';
        if (!busy()) {
          try {
            integration = (await manageCindyMakeWorkspace(
              userData,
              report.runId,
              'inspect',
              env,
              AbortSignal.timeout(15_000),
              {
                checkCurrent: () => {
                  if (!isCurrent()) throw taskError('unavailable');
                },
              },
            ))
              ? 'integrated'
              : 'unintegrated';
          } catch {
            /* Unknown must not be presented as already integrated. */
          }
        }
        if (isCurrent())
          cindyMakeManager.projectTaskSession(report.runId, {
            integration: busy() ? 'unknown' : integration,
          });
      });
    }
  })()
    .catch(() => {
      if (!isCurrent()) return;
      for (const runId of Object.keys(cindyMakeManager.getState().tasks ?? {}))
        cindyMakeManager.projectTaskSession(runId, { integration: 'unknown' });
    })
    .finally(() => {
      if (integrationRefresh === job) integrationRefresh = undefined;
    });
  return job.done;
}

/** Called under the existing terminal-session route lock, after all writers stop. */
export async function recycleCindyMakeTask(
  sessionId: string,
  db: ReturnType<typeof getDbClient>['drizzle'],
  isCurrent: () => boolean,
  action?: MakeTaskAction,
): Promise<void> {
  if (!isCurrent()) {
    if (action) throw taskError('unavailable');
    return;
  }
  const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
  const userData = app.getPath('userData');
  if (
    !row ||
    row.source !== 'cindy-make' ||
    row.remoteHostId ||
    !row.workingDir ||
    !isCindyMakeWorktreePath(userData, row.workingDir) ||
    (row.status !== 'archived' && row.status !== 'deleted')
  ) {
    if (action) throw taskError('unavailable');
    return;
  }
  if (action === 'finish' && row.status !== 'archived') throw taskError('unavailable');
  if (!action && row.status === 'archived') return;
  const workingDir = row.workingDir;
  const runId = path.basename(workingDir);
  const featureOperation = cindyMakeManager.getState().upstreamMerge;
  if (featureOperation?.feature?.taskSessionId === sessionId && featureOperation.status !== 'merged' && featureOperation.hasWorkspace)
    throw taskError('busy');
  const [card] = await db
    .select({ content: messages.content, clientId: messages.clientId })
    .from(messages)
    .where(
      and(
        eq(messages.sessionId, sessionId),
        eq(messages.clientId, 'cindy-make-preparation-' + runId),
      ),
    )
    .limit(1);
  const content = (() => {
    try {
      return card ? JSON.parse(card.content) : undefined;
    } catch {
      // A damaged card must not strand a managed workspace.
      return undefined;
    }
  })();
  const report = content?.__cindyMakeCard?.data?.report as MakeDoctorReport | undefined;
  const history = captureMakeHistoryStore();
  if (report) captureMakeHistoryReport(report, history, row.createdAt);
  if (report?.task?.finished) {
    history.end(runId);
    cindyMakeManager.forgetTask(runId);
    return;
  }
  const checkCurrent = () => {
    if (!isCurrent()) throw taskError('unavailable');
  };
  if (!runtime) throw taskError('busy');
  await cindyMakeManager.runTaskAction(
    sessionId,
    action ?? (row.status === 'deleted' ? 'delete' : 'finish'),
    isCurrent,
    () =>
      cindyMakeManager.withProject(makeSourceRoot(userData), async () => {
        checkCurrent();
        const signal = AbortSignal.timeout(120_000);
        const environment = await createMakeToolchainEnvironment(userData);
        const env = await resolveMakeToolEnvironment(environment, ['git'], signal);
        // Recheck after waiting for project operations and tool discovery. A failed
        // close, or another session borrowing this directory, must preserve it.
        if (runtime!.isAlive(sessionId) || runtime!.isWorkspaceBusy?.(workingDir))
          throw taskError('busy');
        const borrowers = await db
          .select({ id: sessions.id, status: sessions.status })
          .from(sessions)
          .where(eq(sessions.workingDir, workingDir));
        if (
          borrowers.some(
            (other) =>
              other.id !== sessionId && (other.status === 'active' || runtime!.isAlive(other.id)),
          )
        )
          throw taskError('busy');
        if (action === 'end' && card && report?.task && !report.task.cleanupPending) {
          report.task.cleanupPending = true;
          await updateMessageContent(sessionId, card.clientId, content);
          checkCurrent();
          cindyMakeManager.projectTaskSession(runId, { cleanupPending: true });
        }
        const cleaned = await manageCindyMakeWorkspace(
          userData,
          runId,
          row.status === 'deleted' ? 'delete' : (action ?? 'archive'),
          env,
          signal,
          {
            baseCommit: report?.source?.baseCommit,
            checkCurrent,
            preparedWorkspace:
              report?.runId === runId &&
              report.task?.sessionId === sessionId &&
              report.source?.path &&
              report.source.branch
                ? { path: report.source.path, branch: report.source.branch }
                : undefined,
          },
        );
        checkCurrent();
        if (!cleaned) {
          if (action) throw taskError('dirty');
          return;
        }
        if (card && report?.task) {
          await updateMessageContent(sessionId, card.clientId, {
            ...content,
            __cindyMakeCard: {
              ...content.__cindyMakeCard,
              data: {
                ...content.__cindyMakeCard.data,
                report: {
                  ...report,
                  task: { ...report.task, finished: true, cleanupPending: false },
                },
              },
            },
          });
        }
        checkCurrent();
        history.end(runId);
        cindyMakeManager.forgetTask(runId);
      }),
    true,
  );
}

/** Settings actions reuse the canonical archive/delete pipeline and its runtime shutdown. */
export async function manageCindyMakeTask(sessionId: unknown, action: unknown): Promise<void> {
  if (
    typeof sessionId !== 'string' ||
    !/^[a-zA-Z0-9-]{1,128}$/.test(sessionId) ||
    (action !== 'end' && action !== 'finish' && action !== 'delete')
  )
    throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make action');
  const client = getDbClient();
  const owner = captureDataOwnerBroadcastScope();
  const isCurrent = () => {
    try {
      return isDataOwnerBroadcastScopeCurrent(owner) && getDbClient() === client;
    } catch {
      return false;
    }
  };
  const [row] = await client.drizzle
    .select()
    .from(sessions)
    .where(eq(sessions.id, sessionId))
    .limit(1);
  if (
    !isCurrent() ||
    !row ||
    row.source !== 'cindy-make' ||
    row.remoteHostId ||
    !row.workingDir ||
    !isCindyMakeWorktreePath(app.getPath('userData'), row.workingDir) ||
    (row.status === 'deleted' && action === 'finish')
  )
    throwIpcError('NOT_FOUND', 'Cindy Make task unavailable');
  if (!runtime) throwIpcError('PRECONDITION_FAILED', 'busy');
  const featureOperation = cindyMakeManager.getState().upstreamMerge;
  if (featureOperation?.feature?.taskSessionId === sessionId && featureOperation.status !== 'merged' && featureOperation.hasWorkspace)
    throwIpcError('PRECONDITION_FAILED', 'busy');
  if (runtime.isWorkspaceBusy?.(row.workingDir)) throwIpcError('PRECONDITION_FAILED', 'busy');
  if (
    action === 'finish' &&
    (cindyMakeManager.isTaskPreparing(sessionId) || runtime.isRunning(sessionId))
  )
    throwIpcError('PRECONDITION_FAILED', 'busy');
  if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'unavailable');
  try {
    await cindyMakeManager.runTaskAction(sessionId, action, isCurrent, async () => {
      // Ending keeps the conversation. Old deleted tasks may only finish their cleanup.
      const status = action === 'delete' || row.status === 'deleted' ? 'deleted' : 'archived';
      await runtime!.setStatus(sessionId, { status, pinnedAt: null });
      await runtime!.recycle(sessionId, status);
      if (!isCurrent()) throw taskError('unavailable');
      await withSessionRouteLock(sessionId, () =>
        recycleCindyMakeTask(sessionId, client.drizzle, isCurrent, action),
      );
    });
  } catch (error) {
    const code = (error as { code?: string }).code;
    throwIpcError(
      'PRECONDITION_FAILED',
      code && ['busy', 'dirty', 'conflict', 'unavailable', 'directoryBusy'].includes(code)
        ? code
        : 'cleanupFailed',
    );
  }
}
