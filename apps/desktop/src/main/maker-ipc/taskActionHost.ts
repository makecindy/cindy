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
  NEEDS_OWNER_REQUEST,
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

/**
 * Owner-created routines run as standing grants, so changing or firing one is itself an
 * owner decision: on its own initiative a teammate must not mint the grant it then runs under.
 */
export const TEAMMATE_STANDING_GRANT_TOOLS: ReadonlySet<string> = new Set([
  'routine_save', 'routine_delete', 'routine_run_now', 'schedule_set_pre_run_hook',
]);

/**
 * The same standing grants through the scheduler surface, which addresses any schedule
 * (including `routine-*` rows) by id and can create new automations. Reads and the
 * current run's own notify/silence stay available.
 */
export const TEAMMATE_SCHEDULER_WRITE_TOOLS: ReadonlySet<string> = new Set([
  'routine_save', 'routine_delete', 'routine_run_now',
  'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_run_now',
  'schedule_pause', 'schedule_resume', 'schedule_set_pre_run_hook',
]);

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
  };
  getSession(sessionId: string): TaskActionSession | undefined;
  confirm(sessionId: string, tool: string, args: unknown): Promise<boolean>;
  /** The task is handed to this teammate (workbench continue scope); never inferred from args. */
  isEntrustedTask?(callerSessionId: string, taskId: string): Promise<boolean>;
}): ToolCallAuthorizer {
  /**
   * What a teammate may do on its own initiative: its own communication and background
   * tasks, tasks already handed to it, and its own Orca team. Everything else on the
   * owner's tasks needs the owner's request. Content scope stays with the permission mode.
   */
  const autonomousActionAllowed = async (
    call: Parameters<ToolCallAuthorizer>[0],
    sessionId: string,
    botId: string,
    orcaSenderSessionId: string | undefined,
  ): Promise<boolean> => {
    const db = tryGetDbClient();
    if (!db) return false;
    const args = call.args && typeof call.args === 'object' && !Array.isArray(call.args)
      ? (call.args as Record<string, unknown>) : {};
    const ownDelegation = async (column: 'id' | 'childSessionId', value: unknown) => {
      if (typeof value !== 'string' || !value) return false;
      const [row] = await db.drizzle.select({ id: botDelegations.id }).from(botDelegations)
        .where(and(eq(botDelegations[column], value), eq(botDelegations.requestingBotId, botId))).limit(1);
      return !!row;
    };
    if (call.server === 'cindy_orca') {
      if (call.tool === 'start_team' || !orcaSenderSessionId) return false;
      const [team] = await db.drizzle.select({ id: orcaTeams.id }).from(orcaTeams)
        .innerJoin(orcaWorkers, eq(orcaWorkers.teamId, orcaTeams.id))
        .where(and(eq(orcaTeams.leadSessionId, sessionId), eq(orcaTeams.status, 'active'),
          eq(orcaWorkers.sessionId, orcaSenderSessionId)))
        .limit(1);
      return !!team;
    }
    switch (call.tool) {
      case 'send_to_agent':
        return true;
      // The workbench service enforces which tasks are handed to this teammate.
      case 'continue_workbench_task':
        return true;
      case 'set_workbench_task_responsibility':
        return args.responsible === false;
      case 'message_session_task':
        // Permission decisions and resuming a pause stay with the owner.
        return args.decision === undefined && args.mode !== 'resume' && ownDelegation('id', args.task_id);
      case 'stop_session_task':
      case 'advance_session_task_route':
        return ownDelegation('id', args.task_id);
      case 'send_to_session':
        return ownDelegation('childSessionId', args.target_session_id);
      case 'set_session_runtime': {
        const target = args.session_id;
        if (target === undefined || target === sessionId) return true;
        if (await ownDelegation('childSessionId', target)) return true;
        return typeof target === 'string' && (await deps.isEntrustedTask?.(sessionId, target)) === true;
      }
      default:
        return false;
    }
  };
  /** The principal of a teammate caller's current turn; undefined for non-teammate callers. */
  const callerTeammatePrincipal = async (sessionId: string): Promise<TaskActionPrincipal | undefined> => {
    const db = tryGetDbClient();
    if (!db || isAppSessionBoundaryPending()) throw new Error('HOST_NOT_READY');
    const [caller] = await db.drizzle
      .select({ botId: botSessionLinks.botId, role: botSessionLinks.role })
      .from(botSessionLinks)
      .where(eq(botSessionLinks.sessionId, sessionId))
      .limit(1);
    if (!caller?.botId) return undefined;
    let groupOwner = false;
    if (caller.role === 'group') {
      try {
        await authorizeGroupTool(sessionId, caller.botId, 'owner-action');
        groupOwner = true;
      } catch { /* Not a verified owner request: the teammate acts on its own. */ }
    }
    const input = deps.input(sessionId);
    const live = deps.getSession(sessionId);
    const origin = live?.getCurrentTurnOrigin();
    return teammateTurnPrincipal({
      groupOwner,
      laneRequesterIsOwner: readChannelToolScope({ sessionId, sessionInstanceId: live?.instanceId })?.requesterIsOwner,
      ownerInput: input.ownerInput,
      ownerContinuation: input.ownerContinuation,
      scheduleId: origin?.kind === 'scheduler' ? origin.scheduleId : undefined,
    });
  };
  return isolateTaskActionAuthorizer(async (call) => {
    if ((call.server === 'cindy_helper' && TEAMMATE_STANDING_GRANT_TOOLS.has(call.tool))
      || (call.server === 'cindy_scheduler' && TEAMMATE_SCHEDULER_WRITE_TOOLS.has(call.tool))) {
      if (!call.sessionId) return { ok: true };
      return (await callerTeammatePrincipal(call.sessionId)) === 'autonomous' ? NEEDS_OWNER_REQUEST : { ok: true };
    }
    // Per invocation: a concurrent automatic call must never inherit owner evidence.
    let admittedScope: TaskActionScope | null = null;
    let rejectedDecision: Awaited<ReturnType<ToolCallAuthorizer>> | null = null;
    const fingerprint = taskActionFingerprint(call);
    const decision = await createTaskActionAuthorizer({
      confirm: deps.confirm,
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
          if (principal === 'autonomous' && !(await autonomousActionAllowed(call, sessionId, caller.botId, input.orcaSenderSessionId))) {
            rejectedDecision = NEEDS_OWNER_REQUEST;
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
        const assertDeliveryCurrent = async () => {
          runtime?.assertCurrent();
          await group?.refresh();
          if (
            isAppSessionBoundaryPending() ||
            db !== tryGetDbClient() ||
            deps.input(sessionId).boundary !== input.boundary
          )
            throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
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
          assertPermissionCurrent();
          if (db !== tryGetDbClient() || isAppSessionBoundaryPending())
            throw new Error('OWNER_SCOPE_CHANGED');
          runtime?.assertCurrent();
        };
        const assertCurrentSync = () => {
          runtime?.assertInputCurrent();
          group?.assertCurrent();
          assertPermissionCurrent();
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
          delegated: !!delegation || !!orcaTeam,
          assertDeliveryCurrent,
          assertCurrentSync,
          assertCurrent: async () => {
            if (fingerprint !== taskActionFingerprint(call))
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
            await assertDeliveryCurrent();
            assertCurrentSync();
          },
        };
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
