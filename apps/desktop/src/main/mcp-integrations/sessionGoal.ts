import { DeviceLinkError, type InvokeResultPayload } from '@cindy/device-link';
import type { SessionGoalCallback, SessionGoalRequest } from '@cindy/mcps';
import type { GoalController } from '../goal-host/controller.js';
import { GoalControllerInputError, GoalSessionRestoreError, GoalUpdateSupersededError } from '../goal-host/controller.js';
import type { GoalStatusPayload } from '../goal-host/types.js';

const fail = (errorCode: string, message: string) => ({ ok: false as const, errorCode, message });
type Controller = Pick<GoalController, 'getStatus' | 'setGoal' | 'updateGoal' | 'pauseGoal' | 'resumeGoal' | 'clearGoal'>;

/** Host-injected account and task checks; no window, database path or UI automation. */
export function createSessionGoalControl(deps: {
  capture(): {
    controller: Controller;
    readTask(id: string): Promise<{ status: string } | null>;
    assertCurrent(): void;
  };
  assertActionCurrent(): Promise<void>;
  remote?: SessionGoalCallback;
}): SessionGoalCallback {
  return async request => {
    if (request.deviceId) return deps.remote
      ? deps.remote(request)
      : fail('REMOTE_UNSUPPORTED', 'Remote goal control is unavailable on this host.');
    let mutationStarted = false;
    try {
      const context = deps.capture();
      const task = await context.readTask(request.sessionId);
      context.assertCurrent();
      if (!task || task.status === 'deleted') return fail('NOT_FOUND', 'The target task does not exist.');
      const existing = await context.controller.getStatus(request.sessionId);
      context.assertCurrent();
      const precondition = checkGoalAction(request, existing);
      if (precondition) return precondition;
      if (request.action === 'get' || (request.action === 'set' && existing)) return { ok: true, goal: existing };
      try { await deps.assertActionCurrent(); }
      catch { return fail('TASK_ACTION_AUTHORIZATION_EXPIRED', 'The goal action expired before mutation.'); }
      context.assertCurrent();
      mutationStarted = true;
      const c = context.controller;
      switch (request.action) {
        case 'set':
          await c.setGoal({ sessionId: request.sessionId, objective: request.objective!, limits: request.limits });
          break;
        case 'update':
          await c.updateGoal(request.sessionId, request.patch!);
          break;
        case 'pause': await c.pauseGoal(request.sessionId); break;
        case 'resume': await c.resumeGoal(request.sessionId); break;
        case 'clear': await c.clearGoal(request.sessionId); break;
      }
      context.assertCurrent();
      const goal = await c.getStatus(request.sessionId);
      context.assertCurrent();
      return verifyGoalMutation(request, goal);
    } catch (error) {
      if (error instanceof GoalControllerInputError) return fail('INVALID_ARGS', error.message);
      if (error instanceof GoalUpdateSupersededError) return fail('CONFLICT', 'A newer goal operation superseded this update. Read the goal before retrying.');
      if (error instanceof GoalSessionRestoreError) return fail('PRECONDITION_FAILED', 'The goal could not restore its task. Inspect the saved goal and task status before retrying.');
      return fail(mutationStarted ? 'GOAL_RESULT_UNKNOWN' : 'HOST_NOT_READY', mutationStarted
        ? 'The goal operation may have taken effect, but its saved result could not be verified. Read the goal before retrying.'
        : 'The host, account or action is no longer ready. No goal mutation was started.');
    }
  };
}

function checkGoalAction(request: SessionGoalRequest, goal: GoalStatusPayload | null) {
  if (request.action === 'set' && goal && goal.objective !== request.objective)
    return fail('GOAL_EXISTS', 'A different goal is already bound. Read it and use update_session_goal for an intentional edit.');
  if (!goal && ['update', 'pause', 'resume'].includes(request.action))
    return fail('GOAL_NOT_FOUND', 'There is no saved goal for this task.');
  return null;
}

function verifyGoalMutation(request: SessionGoalRequest, goal: GoalStatusPayload | null) {
  if (request.action === 'clear' && goal)
    return fail('CONFLICT', 'A goal remains after clear; inspect it before another operation.');
  if (request.action !== 'clear' && !goal)
    return fail('CONFLICT', 'The goal was cleared or completed while the operation was running. Inspect the task before retrying.');
  if (request.action === 'pause' && goal?.status === 'active')
    return fail('CONFLICT', 'The goal is active after pause. Read the current state before retrying.');
  const patch = request.action === 'set' ? { objective: request.objective } : request.action === 'update' ? request.patch : undefined;
  if (patch && Object.entries(patch).some(([key, value]) => value !== undefined && goal?.[key as keyof GoalStatusPayload] !== value))
    return fail('CONFLICT', 'The saved goal differs from this change. Read the current goal before retrying.');
  return { ok: true as const, goal };
}

function isGoal(value: unknown, sessionId: string): value is GoalStatusPayload | null {
  if (value === null) return true;
  if (!value || typeof value !== 'object') return false;
  const goal = value as GoalStatusPayload;
  return goal.sessionId === sessionId && typeof goal.objective === 'string'
    && ['active', 'paused', 'blocked', 'complete', 'budgetLimited', 'usageLimited'].includes(goal.status)
    && Number.isFinite(goal.turnsUsed) && Number.isFinite(goal.tokensUsed)
    && Number.isFinite(goal.startedAt)
    && [goal.maxTurns, goal.budgetTokens, goal.noProgressLimit, goal.usageResetAt]
      .every(v => v === null || (typeof v === 'number' && Number.isFinite(v)))
    && (goal.lastReason === null || typeof goal.lastReason === 'string');
}

/** Reuses authenticated device-link goal writes. Never replay an uncertain write. */
class RemoteGoalError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

export function createRemoteSessionGoalControl(deps: {
  captureAccess(): () => void;
  assertActionCurrent(): Promise<void>;
  captureActionGuard(): (() => void) | undefined;
  invoke(deviceId: string, channel: string, args: unknown[], options?: { preSend?: () => void }): Promise<InvokeResultPayload>;
}): SessionGoalCallback {
  return async request => {
    let writeStarted = false;
    let preSendRejected = false;
    try {
      const assertCurrent = deps.captureAccess();
      const actionGuard = request.action === 'get' ? undefined : deps.captureActionGuard();
      const invoke = async (channel: string, args: unknown[], writing = false) => {
        const result = await deps.invoke(request.deviceId!, channel, args, { preSend: () => {
          try { assertCurrent(); if (writing) actionGuard?.(); }
          catch (error) { if (writing) preSendRejected = true; throw error; }
        } });
        assertCurrent();
        if (!result.ok) throw new RemoteGoalError(result.error.code, result.error.message);
        return result.result;
      };
      const inspect = async () => {
        // A new channel is deliberate: old get-status implicitly starts dormant goals.
        // Old hosts must reject instead of silently performing a supposedly read-only action.
        const value = await invoke('maker:goal:inspect', [request.sessionId]);
        if (!isGoal(value, request.sessionId)) throw new Error('Invalid goal status receipt');
        return value;
      };
      const existing = await inspect();
      const precondition = checkGoalAction(request, existing);
      if (precondition) return precondition;
      if (request.action === 'get' || (request.action === 'set' && existing)) return { ok: true, goal: existing };
      await deps.assertActionCurrent();
      assertCurrent();
      const args = request.action === 'set'
        ? [{ sessionId: request.sessionId, objective: request.objective, ...(request.limits ? { limits: request.limits } : {}) }]
        : request.action === 'update' ? [{ sessionId: request.sessionId, patch: request.patch }] : [request.sessionId];
      writeStarted = true;
      const receipt = await invoke(`maker:goal:${request.action}`, args, true);
      if (!receipt || typeof receipt !== 'object' || (receipt as { ok?: boolean }).ok !== true)
        throw new Error('Invalid goal write receipt');
      return verifyGoalMutation(request, await inspect());
    } catch (error) {
      if (preSendRejected && writeStarted) return fail('TASK_ACTION_AUTHORIZATION_EXPIRED', 'The goal action expired before dispatch; no write was sent.');
      if (writeStarted) return fail('REMOTE_RESULT_UNKNOWN', 'The remote goal operation may have taken effect. Read the goal before retrying; the tool did not resend it.');
      if (error instanceof DeviceLinkError || error instanceof RemoteGoalError) {
        if (['CHANNEL_NOT_ALLOWED', 'VERSION_MISMATCH', 'NOT_FOUND'].includes(error.code))
          return fail('REMOTE_UNSUPPORTED', 'The other computer must support read-only goal inspection before Agent goal control can be used.');
        if (error.code === 'DEVICE_OFFLINE') return fail('REMOTE_DEVICE_OFFLINE', 'The target computer is offline; no goal write was sent.');
        if (['ACCESS_REVOKED', 'PERMISSION_DENIED', 'REMOTE_DISABLED', 'DEVICE_LINK_CONTROL_DISABLED'].includes(error.code))
          return fail('REMOTE_DISABLED', 'Remote control is unavailable or revoked; no goal write was sent.');
      }
      return fail('REMOTE_UNAVAILABLE', 'Could not inspect the remote goal. No goal write was sent.');
    }
  };
}
