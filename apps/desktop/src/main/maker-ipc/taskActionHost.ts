import { and, eq } from 'drizzle-orm';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { Session } from '@cindy/maker-core';
import {
  botDelegations,
  botProfiles,
  botSessionLinks,
  sessions,
  orcaTeams,
  orcaWorkers,
} from '../localDb/schema.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import { authorizeGroupTool } from './botGroupToolAuthorization.js';
import { readChannelToolScope } from '../im/shared/channelToolScope.js';
import { BUILTIN_ROUTINE_SCHEDULE_PREFIX } from '../../shared/botAutonomy.js';
import {
  admitTaskAction,
  isolateTaskActionAuthorizer,
  createTaskActionAuthorizer,
  DELEGATED_TASK_ACTIONS,
  taskActionRisk,
  taskActionStartsIndependentAgent,
  taskActionCreatesFullAccessTask,
  type TaskActionConfirmation,
  type TaskActionTarget,
  type TaskActionRoutineSnapshot,
  type TaskActionScheduleDefinition,
  taskActionFingerprint,
  type TaskActionPrincipal,
  type TaskActionScope,
} from './taskActionAuthorization.js';

type TaskActionSession = Pick<Session,
  'stablePermissionModeState' | 'stablePlanModeState' |
  'getCurrentTurnOrigin' | 'reviewHostPermissionAction'> & { readonly instanceId?: string };


/**
 * Who a teammate turn speaks for. Owner evidence is Host input provenance only:
 * a verified group owner request, the IM lane's per-turn requester, or the owner's
 * own accepted (or automatically resumed) input. Owner-created routines are standing
 * grants; Host wake-ups, teammate messages and other speakers act on the teammate's own.
 */
export function teammateTurnPrincipal(facts: {
  groupOwner: boolean;
  laneRequesterIsOwner?: boolean;
  ownerInput: boolean;
  ownerContinuation?: boolean;
  scheduleId?: string;
}): TaskActionPrincipal {
  if (facts.groupOwner) return 'owner';
  if (facts.laneRequesterIsOwner !== undefined) return facts.laneRequesterIsOwner ? 'owner' : 'autonomous';
  if (facts.ownerInput || facts.ownerContinuation) return 'owner';
  // Built-in routines (follow-up, Todo check) are Host templates, not an owner's standing instruction.
  if (facts.scheduleId?.startsWith('routine-') && !facts.scheduleId.startsWith(BUILTIN_ROUTINE_SCHEDULE_PREFIX))
    return 'entrusted';
  return 'autonomous';
}

/** The live turn identifies a continuation, not consent. Only its existing
 * permission reviewer may approve the exact action against restored user intent. */
function captureScheduledRuntime(
  sessionId: string,
  getSession: (id: string) => TaskActionSession | undefined,
) {
  const session = getSession(sessionId);
  const origin = session?.getCurrentTurnOrigin();
  if (!session || origin?.kind !== 'scheduler') return null;
  const permissionState = session.stablePermissionModeState;
  const planState = session.stablePlanModeState;
  if (!permissionState || !planState || planState.enabled || permissionState.mode === 'plan') return null;
  const permission = { ...permissionState };
  const plan = { ...planState };
  const assertCurrent = () => {
    const currentPermission = session.stablePermissionModeState;
    const currentPlan = session.stablePlanModeState;
    if (getSession(sessionId) !== session || !currentPermission || !currentPlan ||
      currentPermission.generation !== permission.generation ||
      currentPermission.mode !== permission.mode || currentPlan.enabled ||
      currentPlan.generation !== plan.generation) {
      throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
    }
  };
  return {
    session,
    assertCurrent,
    assertInputCurrent() {
      assertCurrent();
      if (session.getCurrentTurnOrigin() !== origin) {
        throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      }
    },
  };
}

/** Adapt the shared gate to Host facts. No transcript parsing or Agent-supplied approval fields. */
export function createDesktopTaskActionAuthorizer(deps: {
  input(sessionId: string): {
    key: string;
    ownerInput: boolean;
    /** Automatic resume/retry of the owner's own input (teammate principal only). */
    ownerContinuation?: boolean;
    automatic?: boolean;
    orcaSenderSessionId?: string;
    /** Live runtime facts only; never persisted preferences or tool arguments. */
    permission?: {
      permissionMode: string;
      planModeEnabled?: boolean;
      isCurrent?: () => boolean;
    } | null;
    boundary: string;
    /** The coordinator's in-memory /clear fence; it can be ahead of `sessions.cleared_at`. */
    clearBoundaryMs?: number | null;
  };
  getSession(sessionId: string): TaskActionSession | undefined;
  confirm(sessionId: string, tool: string, args: unknown, context?: TaskActionConfirmation): Promise<boolean>;
  capturePermissionRequest(sessionId: string, taskId: string): Promise<TaskActionTarget | null>;
  captureRoutine(botId: string, id: string, forExecution?: boolean): Promise<TaskActionRoutineSnapshot | undefined>;
  getSessionWorkDir(sessionId: string): Promise<string | undefined>;
  getScheduleDefinition(id: string, hookInstallation?: { workingDir?: string }, device?: string): Promise<TaskActionScheduleDefinition | null>;
}): ToolCallAuthorizer {
  return isolateTaskActionAuthorizer(async (call) => {
    // Per invocation: a concurrent automatic call must never inherit owner evidence.
    let admittedScope: TaskActionScope | null = null;
    let rejectedDecision: Awaited<ReturnType<ToolCallAuthorizer>> | null = null;
    const fingerprint = taskActionFingerprint(call);
    const decision = await createTaskActionAuthorizer({
      confirm: (sessionId, tool, args) => deps.confirm(sessionId, tool, args, { server: call.server }),
      capture: async (call) => {
        if (!call.sessionId) throw new Error('TASK_UNAVAILABLE');
        const sessionId = call.sessionId;
        const db = tryGetDbClient();
        if (!db || isAppSessionBoundaryPending()) throw new Error('HOST_NOT_READY');
        const [caller] = await db.drizzle
          .select({
            source: sessions.source,
            clearedAt: sessions.clearedAt,
            botId: botSessionLinks.botId,
            role: botSessionLinks.role,
            botStatus: botProfiles.status,
            archivedAt: botSessionLinks.archivedAt,
          })
          .from(sessions)
          .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
          .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
          .where(eq(sessions.id, sessionId))
          .limit(1);
        if (!caller) throw new Error('TASK_UNAVAILABLE');
        const input = deps.input(sessionId);
        const scheduled = !caller.botId && caller.source !== 'bot' &&
          deps.getSession(sessionId)?.getCurrentTurnOrigin()?.kind === 'scheduler';
        // User-authored ordinary work retains the existing Agent permission flow.
        if (
          !caller.botId &&
          caller.source !== 'bot' &&
          caller.source !== 'scheduler' &&
          !input.automatic && !scheduled
        )
          return null;
        if (caller.botId && (caller.botStatus !== 'active' || caller.archivedAt !== null))
          throw new Error('BOT_SESSION_INACTIVE');
        // A persisted group lane is not consent. Reuse Chat Server's live, owner-only
        // execution authority; guest, stale and temporarily unavailable grants fail closed.
        const group =
          caller.botId && caller.role === 'group'
            ? await authorizeGroupTool(sessionId, caller.botId, 'owner-action')
            : null;
        const ownerInput = group !== null || input.ownerInput;
        let principal: TaskActionPrincipal | undefined;
        if (caller.botId) {
          const live = deps.getSession(sessionId);
          const lane = readChannelToolScope({ sessionId, sessionInstanceId: live?.instanceId });
          const origin = live?.getCurrentTurnOrigin();
          principal = teammateTurnPrincipal({
            groupOwner: group !== null,
            laneRequesterIsOwner: lane?.requesterIsOwner,
            ownerInput: input.ownerInput,
            ownerContinuation: input.ownerContinuation,
            scheduleId: origin?.kind === 'scheduler' ? origin.scheduleId : undefined,
          });
          // An authenticated external speaker is an access boundary, not an operation
          // risk. Never turn missing source authority into a claim that the owner refused.
          if (lane && !lane.requesterIsOwner) {
            rejectedDecision = { ok: false, errorCode: 'TASK_ACTION_SOURCE_UNAUTHORIZED',
              message: 'This channel speaker cannot manage the owner’s tasks. Use the owner’s private conversation.' };
            return null;
          }
        }
        // All execution modes use the normal runtime permission flow, including
        // automatic/resumed turns. Do not ask for owner consent a second time.
        // Group identity was checked above; shared guests keep their own boundary.
        // This is the Host admission snapshot, not an upstream approval receipt.
        // Its revocation lifetime starts here; the approval-to-Host handoff keeps
        // ordinary session semantics and is not made atomic by this gate.
        const permission = input.permission;
        const runtimePermissionApplies = caller.source !== 'shared'
          && ['bypassPermissions', 'auto', 'ask', 'default', 'acceptEdits'].includes(permission?.permissionMode ?? '')
          && permission != null
          && permission.planModeEnabled === false
          && permission.isCurrent?.() === true;
        const assertPermissionCurrent = () => {
          if (runtimePermissionApplies && permission?.isCurrent?.() !== true)
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
        };
        const useRuntimePermissions = ownerInput || runtimePermissionApplies;
        // Retain scheduled-review recovery only when no live runtime decision can
        // be reused. A current permission flow must never be reviewed twice.
        const runtime = !useRuntimePermissions && scheduled
          ? captureScheduledRuntime(sessionId, deps.getSession)
          : null;
        const args =
          call.args && typeof call.args === 'object' && !Array.isArray(call.args)
            ? (call.args as Record<string, unknown>)
            : {};
        const taskId = typeof args.task_id === 'string' ? args.task_id : undefined;
        const needsPermissionTarget = principal === 'autonomous' && runtimePermissionApplies &&
          call.tool === 'message_session_task' && args.decision !== undefined;
        const permissionTarget = needsPermissionTarget && taskId
          ? await deps.capturePermissionRequest(sessionId, taskId) : undefined;
        if (needsPermissionTarget && !permissionTarget) {
          rejectedDecision = { ok: false, errorCode: 'INTERACTION_STALE',
            message: 'The target permission request is unavailable. Read the task again before proposing a new decision.' };
          return null;
        }
        const routineBotId = call.server === 'cindy_scheduler' && typeof args.botId === 'string'
          ? args.botId : caller.botId;
        const routineId = typeof args.id === 'string' && args.id ? args.id : undefined;
        const routine = principal === 'autonomous' && runtimePermissionApplies &&
          (call.tool === 'routine_save' && (args.enabled === true || args.preRunHook != null) || call.tool === 'routine_run_now') && routineBotId && routineId
          ? await deps.captureRoutine(routineBotId, routineId, call.tool === 'routine_run_now') : undefined;
        const routineExecution = call.tool === 'routine_run_now' && routine?.preRunCommand?.trim();
        const routineSignature = JSON.stringify(routine?.details);
        // Read saved commands for execution/partial updates; the card must show
        // what a bare schedule ID will run, and a changed definition expires it.
        const helperInstallation = principal === 'autonomous' && runtimePermissionApplies &&
          call.server === 'cindy_helper' && call.tool === 'schedule_set_pre_run_hook';
        const helperCreation = principal === 'autonomous' && runtimePermissionApplies && taskActionCreatesFullAccessTask(call);
        const helperWorkDir = helperInstallation || helperCreation ? await deps.getSessionWorkDir(sessionId) : undefined;
        const hookInstallation = call.server === 'cindy_scheduler' && call.tool === 'schedule_set_pre_run_hook'
          ? { workingDir: typeof args.workingDir === 'string' ? args.workingDir : undefined } : undefined;
        const scheduleIdArg = hookInstallation ? args.scheduleId : args.id;
        const scheduleDevice = call.server === 'cindy_scheduler' && typeof args.device === 'string' ? args.device : undefined;
        const scheduleId = principal === 'autonomous' && runtimePermissionApplies &&
          (hookInstallation || call.server === 'cindy_scheduler' &&
            ['schedule_update', 'schedule_run_now', 'schedule_resume'].includes(call.tool)) && typeof scheduleIdArg === 'string'
          ? scheduleIdArg : undefined;
        const schedule = scheduleId ? await deps.getScheduleDefinition(scheduleId, hookInstallation, scheduleDevice) : undefined;
        const scheduleSignature = JSON.stringify(schedule);
        const readDelegation = async (rechecking = false) => {
          if (
            !taskId ||
            !DELEGATED_TASK_ACTIONS.includes(call.tool as (typeof DELEGATED_TASK_ACTIONS)[number])
          )
            return null;
          const [row] = await db.drizzle
            .select()
            .from(botDelegations)
            .where(
              and(eq(botDelegations.id, taskId), eq(botDelegations.parentSessionId, sessionId)),
            )
            .limit(1);
          if (!row || !['queued', 'running', 'waiting'].includes(row.status)) return null;
          let snapshot: {
            taskActionAuthority?: { version?: number; actions?: string[] };
            taskPause?: unknown;
          };
          try {
            snapshot = JSON.parse(row.permissionSnapshotJson);
          } catch {
            return null;
          }
          const grant = snapshot.taskActionAuthority;
          // Paused work only resumes following a new owner request. Permission answers
          // and model changes are also exact decisions, never a standing message grant.
          // An admitted pause writes its intent before stopping the execution.
          // That intent cannot revoke the very same stop; it still blocks every
          // new admission and every message/resume delivery.
          const completingPause = rechecking && call.tool === 'stop_session_task' && args.mode === 'pause';
          if ((snapshot.taskPause && !completingPause) || args.decision || args.answers || args.mode === 'resume')
            return null;
          return grant?.version === 1 && grant.actions?.includes(call.tool) ? row : null;
        };
        const delegation = useRuntimePermissions ? null : await readDelegation();
        // A real Worker report continues its ordinary Lead's existing team. It
        // cannot authorize helper writes to unrelated tasks or create a new team.
        const readOrcaTeam = async () => {
          if (
            caller.botId ||
            caller.source === 'bot' ||
            caller.source === 'scheduler' ||
            call.server !== 'cindy_orca' ||
            !input.orcaSenderSessionId
          )
            return null;
          const [team] = await db.drizzle
            .select({ id: orcaTeams.id })
            .from(orcaTeams)
            .innerJoin(orcaWorkers, eq(orcaWorkers.teamId, orcaTeams.id))
            .where(
              and(
                eq(orcaTeams.leadSessionId, sessionId),
                eq(orcaTeams.status, 'active'),
                eq(orcaWorkers.sessionId, input.orcaSenderSessionId),
              ),
            )
            .limit(1);
          return team ?? null;
        };
        const orcaTeam = useRuntimePermissions ? null : await readOrcaTeam();
        // An admitted message outlives the turn that sent it. Delivery stops only on
        // real revocation: account switch, sender cleared or deleted, companion paused
        // or archived, delegation run or team changed, group grant. The sender's live
        // Session incarnation, input generation and permission/Plan generation gate
        // executing this call (assertCurrent), never an already queued message.
        // The captured database client is the owner identity. A held app-session boundary alone
        // proves nothing: a same-owner Ghost projection repair holds it too. While it is pending
        // a delivery check cannot be answered, which is a failed check (kept for retry), not a
        // revocation; once the client is replaced the next check proves the owner changed.
        const assertSameOwner = (revokedAs: string) => {
          if (db !== tryGetDbClient()) throw new Error(revokedAs);
          if (isAppSessionBoundaryPending()) throw new Error('HOST_NOT_READY');
        };
        const assertDeliveryCurrent = async () => {
          await group?.refresh();
          assertSameOwner('TASK_ACTION_AUTHORIZATION_EXPIRED');
          const [fresh] = await db.drizzle
            .select({
              status: sessions.status,
              clearedAt: sessions.clearedAt,
              botStatus: botProfiles.status,
              archivedAt: botSessionLinks.archivedAt,
            })
            .from(sessions)
            .leftJoin(botSessionLinks, eq(botSessionLinks.sessionId, sessions.id))
            .leftJoin(botProfiles, eq(botProfiles.id, botSessionLinks.botId))
            .where(eq(sessions.id, sessionId))
            .limit(1);
          if (
            !fresh ||
            fresh.status === 'deleted' ||
            fresh.clearedAt !== caller.clearedAt ||
            (caller.botId && (fresh.botStatus !== 'active' || fresh.archivedAt !== null))
          )
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          // /clear moves the coordinator's fence before persisting cleared_at, and persisting may
          // fail, so the sender's clear is also read from memory. A persisted boundary loaded late
          // (restart) is no newer than what admission already saw in the database.
          const clearedInMemory = deps.input(sessionId).clearBoundaryMs;
          if (clearedInMemory != null && clearedInMemory > Math.max(input.clearBoundaryMs ?? 0, caller.clearedAt ?? 0))
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          if (delegation) {
            const current = await readDelegation(true);
            if (!current || current.runSequence !== delegation.runSequence)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          if (orcaTeam) {
            if ((await readOrcaTeam())?.id !== orcaTeam.id)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          group?.assertCurrent();
          assertSameOwner('OWNER_SCOPE_CHANGED');
        };
        const assertCurrentSync = () => {
          runtime?.assertInputCurrent();
          group?.assertCurrent();
          assertPermissionCurrent();
          permissionTarget?.assertCurrent();
          routine?.assertCurrent();
          const current = deps.input(sessionId);
          if (
            isAppSessionBoundaryPending() || db !== tryGetDbClient() ||
            current.boundary !== input.boundary || current.key !== input.key
          ) throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
        };
        const scope: TaskActionScope = {
          key: input.key,
          ownerInput,
          principal,
          ...(routine && routineBotId && routineId
            ? { routine: { botId: routineBotId, id: routineId, revision: routine.revision } } : {}),
          ...(schedule?.mutationGuard ? { scheduleGuard: schedule.mutationGuard } : {}),
          delegated: !!delegation || !!orcaTeam,
          assertDeliveryCurrent,
          assertCurrentSync,
          assertCurrent: async () => {
            if (fingerprint !== taskActionFingerprint(call))
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            await assertDeliveryCurrent();
            if ((helperInstallation || helperCreation) && await deps.getSessionWorkDir(sessionId) !== helperWorkDir)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            if (scheduleId && JSON.stringify(await deps.getScheduleDefinition(scheduleId, hookInstallation, scheduleDevice)) !== scheduleSignature)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            if (routineExecution && routineBotId && routineId &&
              JSON.stringify((await deps.captureRoutine(routineBotId, routineId, true))?.details) !== routineSignature)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            assertCurrentSync();
          },
        };
        // Missing owner provenance no longer disables ordinary work. Only explicit
        // risks on autonomous turns need an exact, visible owner decision. The decision
        // keeps the caller principal and admits only this invocation. Reviewed active
        // routine instructions can become the standing grant for later routine runs.
        const risk = principal === 'autonomous' ? taskActionRisk(call, { routineEnabled: routine?.enabled, routinePrompt: routine?.prompt,
          routineBuiltin: routine?.builtin, routinePreRunCommand: routine?.preRunCommand, schedule }) : undefined;
        const scheduleForConfirmation = schedule
          ? (({ mutationGuard: _mutationGuard, ...display }) => display)(schedule)
          : undefined;
        if (risk && runtimePermissionApplies) {
          await scope.assertCurrent();
          const confirmed = await deps.confirm(sessionId, call.tool, structuredClone(call.args),
            { server: call.server, risk, ...(permissionTarget ? { details: permissionTarget.details }
              : helperInstallation ? { details: { installation: { workingDir: helperWorkDir ?? null } } }
              : helperCreation ? { details: { execution: { mode: 'agent', newTaskPermissionMode: 'bypassPermissions', workingDir: helperWorkDir ?? null } } }
              : risk === 'command' && taskActionStartsIndependentAgent(call, schedule)
                ? { details: { ...(scheduleForConfirmation ? { schedule: scheduleForConfirmation } : {}), execution: { mode: 'agent', newTaskPermissionMode: 'bypassPermissions' } } }
              : scheduleForConfirmation ? { details: { schedule: scheduleForConfirmation } }
              : (call.tool === 'routine_run_now' || risk === 'resume') && routine?.details
                ? { details: routine.details } : {}) });
          if (!confirmed) {
            rejectedDecision = { ok: false, errorCode: 'USER_CANCELLED',
              message: 'The action was not approved. Do not execute or retry it without a new request.' };
            return null;
          }
          admittedScope = scope;
          return null;
        }
        if (useRuntimePermissions) {
          // Owner requests and live execution modes use the normal Agent permission flow.
          // Retain delivery evidence so workbench, queues and new delegations work too.
          admittedScope = scope;
          return null;
        }
        if (runtime && !scope.delegated) {
          // Session reuses Full Access / Auto / Ask and the owning task's restored
          // user intent. Do not turn scheduled text into a fresh owner request.
          const review = await runtime.session.reviewHostPermissionAction({
            kind: 'other',
            description: JSON.stringify({
              toolName: `mcp__${call.server}__${call.tool}`,
              input: structuredClone(call.args),
              // Host timing fact, not a grant: setup may have asked to wait
              // for a trigger which has now occurred. Owner scope still applies.
              context: { source: 'scheduler', phase: 'triggered-continuation' },
            }),
          });
          // A stale review must not open a confirmation for a newer task/input.
          const admission = await admitTaskAction(call, scope, fingerprint);
          if (!admission.ok) {
            rejectedDecision = admission;
            return null;
          }
          if (review.verdict === 'allow' || (review.verdict === 'ask' &&
            await deps.confirm(sessionId, call.tool, structuredClone(call.args)))) {
            admittedScope = scope;
            return null;
          }
        }
        return scope;
      },
    })(call);
    return rejectedDecision ?? (decision.ok && admittedScope
      ? admitTaskAction(call, admittedScope, fingerprint) : decision);
  });
}
