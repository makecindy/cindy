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

interface TaskManagementRuntime {
  isAlive(sessionId: string): boolean | undefined;
  isRunning(sessionId: string): boolean;
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
  const workingDir = row.workingDir;
  const runId = path.basename(workingDir);
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
  if (report?.task?.finished) {
    cindyMakeManager.forgetTask(runId);
    return;
  }
  const checkCurrent = () => {
    if (!isCurrent()) throw taskError('unavailable');
  };
  if (!runtime) throw taskError('busy');
  await cindyMakeManager.runTaskAction(
    sessionId,
    row.status === 'deleted' ? 'delete' : 'finish',
    isCurrent,
    () =>
      cindyMakeManager.withProject(makeSourceRoot(userData), async () => {
        checkCurrent();
        const signal = AbortSignal.timeout(120_000);
        const environment = await createMakeToolchainEnvironment(userData);
        const env = await resolveMakeToolEnvironment(environment, ['git'], signal);
        // Recheck after waiting for project operations and tool discovery. A failed
        // close, or another session borrowing this directory, must preserve it.
        if (runtime!.isAlive(sessionId)) throw taskError('busy');
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
        if (!cleaned) return;
        if (card && report?.task) {
          await updateMessageContent(sessionId, card.clientId, {
            ...content,
            __cindyMakeCard: {
              ...content.__cindyMakeCard,
              data: {
                ...content.__cindyMakeCard.data,
                report: { ...report, task: { ...report.task, finished: true } },
              },
            },
          });
        }
        checkCurrent();
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
    (action !== 'finish' && action !== 'delete')
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
    (row.status === 'deleted' && action !== 'delete')
  )
    throwIpcError('NOT_FOUND', 'Cindy Make task unavailable');
  if (!runtime) throwIpcError('PRECONDITION_FAILED', 'busy');
  if (
    action === 'finish' &&
    (cindyMakeManager.isTaskPreparing(sessionId) || runtime.isRunning(sessionId))
  )
    throwIpcError('PRECONDITION_FAILED', 'busy');
  if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'unavailable');
  try {
    await cindyMakeManager.runTaskAction(sessionId, action, isCurrent, async () => {
      const status = action === 'delete' ? 'deleted' : 'archived';
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
