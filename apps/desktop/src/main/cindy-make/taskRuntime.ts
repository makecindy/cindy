import { randomUUID } from 'node:crypto';
import { normalizeDbAgentKind, dbToMakerAgentKind } from '../../shared/agentKindConversion.js';
import { and, desc, eq, gt, isNull, like, or } from 'drizzle-orm';
import { app } from 'electron';
import { cindyMakeManager } from './manager.js';
import {
  createMakeToolchainEnvironment,
  resolveMakeToolEnvironment,
  type MakeToolchainEnvironment,
} from './toolchainEnvironment.js';
import { prepareCindyMakeEnvironment } from './prepare.js';
import { untilAborted } from './doctor.js';
import { prepareCindySource, readCurrentCindySourceStatus } from './sourcePreparation.js';
import { createCindyMakeWorktree, installCindyMakeWorktree } from './taskWorkspace.js';
import { CINDY_MAKE_RUN_ID_PATTERN, makeSourceRoot, makeTaskWorktreePath } from './sourcePaths.js';
import { makeToolRoot } from './toolInstaller.js';
import { getDbClient } from '../localDb/client/current.js';
import { messages, sessions } from '../localDb/schema.js';
import { sessionCreateToRow } from '../localDb/mapper.js';
import { createMessage, updateMessageContent } from '../localDb/ipc/messages.js';
import { emitSessionCreated } from '../localDb/ipc/sessionCreatedBroadcast.js';
import {
  captureDataOwnerBroadcastScope,
  isDataOwnerBroadcastScopeCurrent,
} from '../device-link/broadcast-tap.js';
import { createBusinessSessionId } from '../sessionIds.js';
import { createLogger } from '../logger.js';
import { throwIpcError } from '../utils/ipcValidate.js';
import { t } from '../i18n.js';
import { getSessionRuntimeControlSnapshot } from '../maker-ipc/sessionRuntimeControl.js';
import { normalizeWorkingDirForStorage } from '../../shared/workingDir.js';
import {
  isMakeEnvironmentReady,
  type CindyMakeTaskStart,
  type MakeDoctorReport,
  type MakeTaskWorkspace,
} from '../../shared/cindyMakeDoctor.js';
import type { DesktopMakerSendResult } from '../maker-host/send-outcome.js';
import { captureMakeHistoryReport } from './historyCapture.js';

export const CINDY_MAKE_TASK_DISPATCH = Symbol('cindy-make-task-dispatch');
const log = createLogger('cindy-make');
type SendTask = (
  sessionId: string,
  message: string,
  createOpts: Record<string, unknown>,
  sendOpts: Record<PropertyKey, unknown>,
) => Promise<DesktopMakerSendResult>;
let sendTask: SendTask | undefined;
let readClearBoundary: ((sessionId: string) => number | null) | undefined;

/** Dispatch a Main-created task without opting it into the personal-build lifecycle. */
export async function dispatchCindyMakeMergeTask(
  sessionId: string, message: string, createOpts: Record<string, unknown>,
  isCurrent: () => boolean, clientId: string,
): Promise<void> {
  if (!sendTask || !isCurrent()) throwIpcError('PRECONDITION_FAILED', 'Task runner is not ready');
  const expectedClearBoundaryMs = readClearBoundary?.(sessionId) ?? null;
  const sent = await sendTask(sessionId, message, createOpts, {
    expectedClearBoundaryMs,
    persistUserMessage: { clientId, content: message, expectedClearBoundaryMs, shouldBroadcast: isCurrent },
  });
  if (!sent.accepted) throwIpcError('PRECONDITION_FAILED', 'Could not start upstream merge task');
}

export function configureCindyMakeTaskSender(
  sender: SendTask,
  getClearBoundary: (sessionId: string) => number | null,
): void {
  sendTask = sender;
  readClearBoundary = getClearBoundary;
}

export async function restoreCindyMakeTaskState(): Promise<void> {
  const dbClient = getDbClient();
  const owner = captureDataOwnerBroadcastScope();
  const isCurrent = () => {
    try {
      return isDataOwnerBroadcastScopeCurrent(owner) && getDbClient() === dbClient;
    } catch {
      return false;
    }
  };
  const rows = await dbClient.drizzle
    .select({
      sessionId: messages.sessionId,
      clientId: messages.clientId,
      content: messages.content,
      clearedAt: sessions.clearedAt,
      sessionStatus: sessions.status,
      createdAt: sessions.createdAt,
    })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(sessions.source, 'cindy-make'),
        like(messages.clientId, 'cindy-make-preparation-%'),
        isNull(messages.rewindAt),
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt));
  for (const row of rows) {
    if (!isCurrent()) return;
    const isRestoredCurrent = () =>
      isCurrent() && (!readClearBoundary || readClearBoundary(row.sessionId) === row.clearedAt);
    if (!isRestoredCurrent()) continue;
    let content;
    try {
      content = JSON.parse(row.content);
    } catch {
      continue;
    }
    const report = content?.__cindyMakeCard?.data?.report as MakeDoctorReport | undefined;
    if (
      !report ||
      typeof report.runId !== 'string' ||
      !CINDY_MAKE_RUN_ID_PATTERN.test(report.runId) ||
      report.task?.sessionId !== row.sessionId ||
      !Array.isArray(report.checks)
    )
      continue;
    const savedStatus = report.status;
    captureMakeHistoryReport(report, undefined, row.createdAt);
    if (report.task.finished) {
      cindyMakeManager.forgetTask(report.runId);
      continue;
    }
    report.task.sessionStatus = row.sessionStatus;
    const restored = cindyMakeManager.restoreTaskReport(report, isRestoredCurrent);
    cindyMakeManager.projectTaskSession(report.runId, { sessionStatus: row.sessionStatus });
    if (restored && restored.status !== savedStatus && isRestoredCurrent()) {
      await updateMessageContent(row.sessionId, row.clientId, {
        ...content,
        text: t(
          restored.status === 'completed'
            ? 'cindyMake.code.prepared'
            : 'cindyMake.prepare.cancelled',
        ),
        __cindyMakeCard: {
          ...content.__cindyMakeCard,
          data: { ...content.__cindyMakeCard.data, report: restored },
        },
      });
    }
  }
}

export async function assertCindyMakeTaskReady(sessionId: string): Promise<void> {
  const [card] = await getDbClient()
    .drizzle.select({ content: messages.content })
    .from(messages)
    .innerJoin(sessions, eq(messages.sessionId, sessions.id))
    .where(
      and(
        eq(messages.sessionId, sessionId),
        like(messages.clientId, 'cindy-make-preparation-%'),
        isNull(messages.rewindAt),
        or(isNull(sessions.clearedAt), gt(messages.createdAt, sessions.clearedAt)),
      ),
    )
    .orderBy(desc(messages.createdAt))
    .limit(1);
  if (!card) return;
  let status: unknown;
  try {
    status = JSON.parse(card.content).__cindyMakeCard?.data?.report?.status;
  } catch {}
  if (status !== 'completed')
    throwIpcError('PRECONDITION_FAILED', 'Retry Cindy Make preparation before starting this task');
}

export function validateCindyMakeTaskStart(raw: unknown): CindyMakeTaskStart {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw))
    throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make task');
  const input = raw as Record<string, unknown>;
  if (
    (input.originSessionId !== undefined &&
      (typeof input.originSessionId !== 'string' ||
        !/^[a-zA-Z0-9-]{1,128}$/.test(input.originSessionId))) ||
    typeof input.runId !== 'string' ||
    !CINDY_MAKE_RUN_ID_PATTERN.test(input.runId) ||
    typeof input.request !== 'string' ||
    !input.request.trim() ||
    input.request.length > 4000 ||
    typeof input.title !== 'string' ||
    !input.title.trim() ||
    input.title.length > 200
  ) {
    throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make task');
  }
  const options = input.createOptions;
  if (options !== undefined) {
    if (!options || typeof options !== 'object' || Array.isArray(options))
      throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make preferences');
    const fields = options as Record<string, unknown>;
    for (const [key, value] of Object.entries(fields)) {
      const valid =
        value === undefined ||
        (key === 'agentKind'
          ? typeof value === 'string' && ['cc', 'codex', 'pi'].includes(value)
          : key === 'fastMode' || key === 'planModeEnabled'
            ? typeof value === 'boolean'
            : key === 'providerId' && value === null
              ? true
              : ['model', 'effort', 'providerId', 'permissionMode'].includes(key) &&
                typeof value === 'string' &&
                value.length <= 500);
      if (!valid) throwIpcError('INVALID_PARAMS', 'Invalid Cindy Make preferences');
    }
  }
  return {
    originSessionId: input.originSessionId as string | undefined,
    createOptions: options as CindyMakeTaskStart['createOptions'],
    runId: input.runId,
    request: input.request,
    title: input.title.trim(),
  };
}

export async function startCindyMakeTask(raw: unknown, sender: number): Promise<string> {
  const input = validateCindyMakeTaskStart(raw);
  if (!sendTask) throwIpcError('PRECONDITION_FAILED', 'Task runner is not ready');
  const dbClient = getDbClient();
  const db = dbClient.drizzle;
  const owner = captureDataOwnerBroadcastScope();
  const isCurrent = () => {
    try {
      return isDataOwnerBroadcastScopeCurrent(owner) && getDbClient() === dbClient;
    } catch {
      return false;
    }
  };
  const checkCurrent = () => {
    if (!isCurrent()) throwIpcError('PRECONDITION_FAILED', 'Task owner changed');
  };
  const [origin] = input.originSessionId
    ? await db.select().from(sessions).where(eq(sessions.id, input.originSessionId)).limit(1)
    : [];
  checkCurrent();
  const userData = app.getPath('userData');
  const root = makeSourceRoot(userData);
  const clientId = 'cindy-make-preparation-' + input.runId;
  let sessionId = '';
  let expectedClearBoundaryMs: number | null = null;
  let report: MakeDoctorReport;
  let workspace: MakeTaskWorkspace;
  const isPreparationCurrent = () =>
    isCurrent() && (!readClearBoundary || readClearBoundary(sessionId) === expectedClearBoundaryMs);
  const checkPreparationCurrent = () => {
    checkCurrent();
    if (!isPreparationCurrent())
      throwIpcError('PRECONDITION_FAILED', 'Task preparation was cleared');
  };
  const persist = async (next: MakeDoctorReport) => {
    checkPreparationCurrent();
    const [current] = await db
      .select({ clearedAt: sessions.clearedAt })
      .from(sessions)
      .where(eq(sessions.id, sessionId))
      .limit(1);
    checkPreparationCurrent();
    if (!current || current.clearedAt !== expectedClearBoundaryMs)
      throwIpcError('PRECONDITION_FAILED', 'Task preparation was cleared');
    const content = {
      text: t(
        next.status === 'failed'
          ? 'cindyMake.code.preparationFailed'
          : next.status === 'cancelled'
            ? 'cindyMake.prepare.cancelled'
            : next.status === 'completed'
              ? 'cindyMake.code.prepared'
              : 'cindyMake.code.phases.' + next.task!.phase,
      ),
      __cindyMakeCard: {
        type: 'cindy-make',
        data: {
          request: input.request,
          codeSessionId: sessionId,
          decision: 'personal',
          mainOwned: true,
          report: next,
        },
      },
    };
    const updated = await updateMessageContent(sessionId, clientId, content);
    checkPreparationCurrent();
    if (!updated)
      await createMessage(
        sessionId,
        { clientId, role: 'assistant', content },
        {
          broadcastOwnerScope: owner,
          expectedClearBoundaryMs,
          shouldBroadcast: isPreparationCurrent,
        },
      );
    checkPreparationCurrent();
    captureMakeHistoryReport(next);
  };
  const phase = (
    name: NonNullable<MakeDoctorReport['task']>['phase'],
    publish: (value: MakeDoctorReport) => void,
  ) => {
    checkPreparationCurrent();
    report = { ...report, status: 'running', task: { ...report.task!, phase: name } };
    publish(report);
  };
  return cindyMakeManager.startTask(input, {
    isCurrent: isPreparationCurrent,
    onError: (error) =>
      log.warn('task preparation failed', {
        runId: input.runId,
        code: (error as { code?: unknown })?.code,
      }),
    onCreated: () => {
      checkPreparationCurrent();
      emitSessionCreated(sessionId);
    },
    create: async (previousReport) => {
      const [previous] = await db
        .select({
          sessionId: messages.sessionId,
          content: messages.content,
          status: sessions.status,
          createdAt: messages.createdAt,
          clearedAt: sessions.clearedAt,
        })
        .from(messages)
        .innerJoin(sessions, eq(sessions.id, messages.sessionId))
        .where(and(eq(messages.clientId, clientId), eq(sessions.source, 'cindy-make')))
        .limit(1);
      checkCurrent();
      if (previous) {
        if (previous.status !== 'active')
          throwIpcError('PRECONDITION_FAILED', 'Prepared task is archived');
        if (previous.clearedAt !== null && previous.createdAt <= previous.clearedAt)
          throwIpcError('PRECONDITION_FAILED', 'Task preparation was cleared');
        const data = JSON.parse(previous.content).__cindyMakeCard?.data;
        if (
          data?.report?.task?.originSessionId !== input.originSessionId ||
          data?.request !== input.request
        )
          throwIpcError('INVALID_PARAMS', 'Task run does not match');
        sessionId = previous.sessionId;
        expectedClearBoundaryMs = previous.clearedAt;
        checkPreparationCurrent();
        report = data.report as MakeDoctorReport;
        const alreadyStarted = report.status === 'completed';
        report = {
          ...report,
          status: alreadyStarted ? 'completed' : 'running',
          task: {
            ...report.task!,
            phase: alreadyStarted ? 'completed' : 'waiting',
            dependencies: undefined,
          },
        };
      } else if (previousReport?.task) {
        sessionId = previousReport.task.sessionId;
        const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
        checkCurrent();
        if (
          !row ||
          row.status !== 'active' ||
          row.source !== 'cindy-make' ||
          normalizeWorkingDirForStorage(row.workingDir) !==
            normalizeWorkingDirForStorage(makeTaskWorktreePath(userData, input.runId)) ||
          row.remoteHostId
        )
          throwIpcError('PRECONDITION_FAILED', 'Prepared task is unavailable');
        if (row.clearedAt !== null && row.createdAt <= row.clearedAt)
          throwIpcError('PRECONDITION_FAILED', 'Task preparation was cleared');
        expectedClearBoundaryMs = row.clearedAt;
        checkPreparationCurrent();
        report = {
          ...previousReport,
          status: 'running',
          task: { ...previousReport.task, phase: 'waiting', dependencies: undefined },
        };
      } else {
        // Existing preparations own their session and preferences. Only a new
        // task needs a live local origin from which to inherit its configuration.
        if (input.originSessionId && (!origin || origin.status !== 'active'))
          throwIpcError('NOT_FOUND', 'Origin task is unavailable');
        if (origin?.remoteHostId)
          throwIpcError('UNSUPPORTED_CAPABILITY', 'Cindy Make requires a local task');
        const effective = origin
          ? getSessionRuntimeControlSnapshot(origin.id).effectiveOverride
          : undefined;
        const preferences = origin ?? input.createOptions ?? {};
        sessionId = createBusinessSessionId();
        const row = sessionCreateToRow(
          sessionId,
          {
            title: input.title,
            workingDir: makeTaskWorktreePath(userData, input.runId),
            workspaceKind: 'project',
            source: 'cindy-make',
            agentKind: normalizeDbAgentKind(effective?.agentKind ?? preferences.agentKind),
            model: effective?.model ?? preferences.model,
            effort: effective ? (effective.effort ?? '') : preferences.effort,
            providerId: effective ? effective.providerId : preferences.providerId,
            fastMode: effective?.fastMode ?? preferences.fastMode,
            planModeEnabled: preferences.planModeEnabled,
            permissionMode: preferences.permissionMode,
          },
          Date.now(),
        );
        await db.insert(sessions).values(row);
        checkCurrent();
        expectedClearBoundaryMs = row.clearedAt ?? null;
        report = {
          runId: input.runId,
          platform: process.platform,
          arch: process.arch,
          mode: 'prepare',
          status: 'running',
          checks: [],
          task: {
            title: input.title,
            request: input.request,
            sessionId,
            originSessionId: input.originSessionId,
            phase: 'waiting',
          },
        };
      }
      return report;
    },
    persist,
    prepare: async (signal, publish) => {
      phase('environment', publish);
      const operationId = randomUUID();
      const operation = cindyMakeManager.claim<MakeToolchainEnvironment>(
        { resource: 'environment', mode: 'prepare', forceManagedTools: false },
        operationId,
        sender,
        (environmentReport) => {
          if (!signal.aborted) {
            report = { ...report, checks: environmentReport.checks };
            publish(report);
          }
        },
      );
      if (!operation.attached) {
        void (async () => {
          try {
            const environment = await createMakeToolchainEnvironment(userData);
            const sharedSignal = AbortSignal.any([
              operation.controller.signal,
              AbortSignal.timeout(20 * 60_000),
            ]);
            const checked = await prepareCindyMakeEnvironment(
              operationId,
              environment,
              makeToolRoot(userData),
              sharedSignal,
              operation.publish,
            );
            operation.complete(checked, environment);
          } catch {
            operation.complete({
              runId: operationId,
              platform: process.platform,
              arch: process.arch,
              checks: [],
              mode: 'prepare',
              status: operation.controller.signal.aborted ? 'cancelled' : 'failed',
            });
          }
        })();
      }
      let env: MakeToolchainEnvironment;
      try {
        const prepared = await untilAborted(operation.promise, signal);
        signal.throwIfAborted();
        if (!isMakeEnvironmentReady(prepared) || !operation.context)
          throw Object.assign(new Error('environment not ready'), { code: 'environmentNotReady' });
        env = operation.context;
      } finally {
        operation.unsubscribe();
      }
      phase('source', publish);
      let source = await readCurrentCindySourceStatus(root, env);
      signal.throwIfAborted();
      if (source.status !== 'ready') {
        const version = app.getVersion();
        const result = await untilAborted(
          prepareCindySource(
            env,
            root,
            {
              channel: !app.isPackaged ? 'dev' : version.includes('-beta') ? 'beta' : 'release',
              version,
            },
            AbortSignal.timeout(20 * 60_000),
            (progress) => {
              if (!signal.aborted) {
                report = { ...report, source: { ...progress, ref: progress.target.ref } };
                publish(report);
              }
            },
          ),
          signal,
        );
        if (result.status !== 'ready')
          throw Object.assign(new Error('source not ready'), { code: result.error });
        source = await readCurrentCindySourceStatus(root, env);
      }
      signal.throwIfAborted();
      report = { ...report, source };
      cindyMakeManager.setSourceStatus(source);
      phase('workspace', publish);
      await untilAborted(
        cindyMakeManager.withProject(
          root,
          async () => {
            checkCurrent();
            const processEnvironment = await resolveMakeToolEnvironment(
              env,
              ['git', 'node', 'pnpm', 'python'],
              signal,
            );
            workspace = await createCindyMakeWorktree(userData, input.runId, signal, {
              processEnvironment,
            });
            signal.throwIfAborted();
            report = { ...report, source: { status: 'ready', ...workspace } };
            phase('dependencies', publish);
            await installCindyMakeWorktree(
              userData,
              workspace,
              signal,
              { processEnvironment },
              undefined,
              (dependencies) => {
                if (!signal.aborted) {
                  report = { ...report, task: { ...report.task!, dependencies } };
                  publish(report);
                }
              },
            );
          },
          signal,
        ),
        signal,
      );
    },
    start: async (signal) => {
      checkPreparationCurrent();
      signal.throwIfAborted();
      const [row] = await db.select().from(sessions).where(eq(sessions.id, sessionId)).limit(1);
      checkPreparationCurrent();
      signal.throwIfAborted();
      if (
        !row ||
        row.status !== 'active' ||
        row.source !== 'cindy-make' ||
        normalizeWorkingDirForStorage(row.workingDir) !==
          normalizeWorkingDirForStorage(workspace.path) ||
        row.clearedAt !== expectedClearBoundaryMs ||
        row.remoteHostId
      )
        throwIpcError('PRECONDITION_FAILED', 'Task changed during preparation');
      const sent = await sendTask!(
        sessionId,
        input.request,
        {
          id: sessionId,
          agentKind: dbToMakerAgentKind(row.agentKind),
          workingDir: workspace.path,
          model: row.model,
          effort: row.effort,
          providerId: row.providerId,
          fastMode: row.fastMode,
          permissionMode: row.permissionMode,
          planMode: row.planModeEnabled,
        },
        {
          [CINDY_MAKE_TASK_DISPATCH]: true,
          signal,
          expectedClearBoundaryMs,
          persistUserMessage: {
            clientId: 'cindy-make-first-' + input.runId,
            content: input.request,
            expectedClearBoundaryMs,
            shouldBroadcast: isPreparationCurrent,
          },
        },
      );
      if (!sent.accepted)
        throw Object.assign(new Error('task dispatch failed'), { code: sent.reason });
    },
  });
}
