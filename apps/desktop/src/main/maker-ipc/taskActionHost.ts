import { and, eq } from 'drizzle-orm';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { Session } from '@cindy/maker-core';
import {
  botProfiles,
  botSessionLinks,
  sessions,
  orcaTeams,
  orcaWorkers,
} from '../localDb/schema.js';
import { tryGetDbClient } from '../localDb/client/current.js';
import { isAppSessionBoundaryPending } from '../appSessionState.js';
import {
  admitTaskAction,
  isolateTaskActionAuthorizer,
  createTaskActionAuthorizer,
  type TaskActionConfirmation,
  taskActionFingerprint,
  type TaskActionScope,
} from './taskActionAuthorization.js';

type TaskActionSession = Pick<Session,
  'stablePermissionModeState' | 'stablePlanModeState' |
  'getCurrentTurnOrigin' | 'reviewHostPermissionAction'> & { readonly instanceId?: string };


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
        // Teammates use the same task flow as ordinary tasks: any task can already open a
        // Full Access task, so a teammate-only gate would protect nothing (2026-11-08).
        const ownerInput = input.ownerInput;
        // All execution modes use the normal runtime permission flow, including
        // automatic/resumed turns. Do not ask for owner consent a second time.
        // Shared guests keep their own boundary.
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
        // or archived, or team changed. The sender's live
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
          if (orcaTeam) {
            if ((await readOrcaTeam())?.id !== orcaTeam.id)
              throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
          }
          assertSameOwner('OWNER_SCOPE_CHANGED');
        };
        const assertCurrentSync = () => {
          runtime?.assertInputCurrent();
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
          delegated: !!orcaTeam,
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
          // Retain delivery evidence so queues and later deliveries work too.
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
