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
} from '@cindy/runtime-db/schema';
import {
  admitTaskAction,
  createTaskActionAuthorizer,
  DELEGATED_TASK_ACTIONS,
  taskActionFingerprint,
  type TaskActionScope,
} from './taskActionAuthorization.js';

type TaskActionSession = Pick<Session,
  'stablePermissionModeState' | 'stablePlanModeState' |
  'getCurrentTurnOrigin' | 'reviewHostPermissionAction'>;

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
export function createTaskActionHost(host:{
 tryGetDbClient():import('@cindy/runtime-db').DbClient|null;
 isAppSessionBoundaryPending():boolean;
 authorizeGroupTool:ReturnType<typeof import('./botGroupToolAuthorization.js').createGroupToolAuthorization>['authorizeGroupTool'];
}){
 const {tryGetDbClient,isAppSessionBoundaryPending,authorizeGroupTool}=host;
function createDesktopTaskActionAuthorizer(deps: {
  input(sessionId: string): {
    key: string;
    ownerInput: boolean;
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
}): ToolCallAuthorizer {
  return async (call) => {
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
  };
}

return {createDesktopTaskActionAuthorizer};
}
