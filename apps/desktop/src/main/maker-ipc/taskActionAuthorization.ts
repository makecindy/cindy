import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

type Call = Parameters<ToolCallAuthorizer>[0];
type Decision = Awaited<ReturnType<ToolCallAuthorizer>>;

/** These names describe effects, not tool visibility or an Agent permission mode. */
export const TASK_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'set_teammate_project',
  'send_to_session',
  'steer_session',
  'stop_session_turn',
  'set_session_runtime',
  'set_app_default_model',
  'update_app_settings',
  'set_model_configuration',
  'configure_model_provider',
  'configure_model_connection',
  'reset_app_settings',
  'update_session_queued_message',
  'cancel_session_queued_message',
  'steer_session_queued_message',
  'move_session_queued_message',
  'archive_sessions',
  'unarchive_sessions',
  'rename_sessions',
  'move_session',
  'manage_session_prs',
  'create_shared_task_invitation',
  'request_remote_control',
]);

export const ORCA_TASK_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'start_team',
  'create_worker',
  'create_workers',
  'switch_focus',
  'send_to_worker',
  'interrupt_worker',
  'update_queued_message',
  'cancel_queued_message',
  'merge_queued_messages',
  'steer_queued_message',
  'move_queued_message',
  'idle_worker',
  'end_team',
  'archive_worker',
]);

export interface TaskActionScope {
  /** Host identity/active-input generation, captured before the confirmation. */
  key: string;
  ownerInput: boolean;
  /** Already confirmed upstream (an Orca team or delegate_task); never inferred from creator/follower. */
  delegated: boolean;
  /** Rechecked at mutation; includes account, target and team revocation. */
  assertCurrent(): Promise<void>;
  /** Host generation check for existing synchronous commit/pre-send callbacks. */
  assertCurrentSync?(): void;
  /** Queued delivery outlives the admitting turn: real revocation only, no live turn facts. */
  assertDeliveryCurrent?(): Promise<void>;
}

interface ActionContext {
  sessionId: string;
  tool: string;
  fingerprint: string;
  assertCurrent(): Promise<void>;
  assertCurrentSync?(): void;
  assertDeliveryCurrent(): Promise<void>;
}
const actionContext = new AsyncLocalStorage<ActionContext>();
export const TASK_ACTION_INPUT_GUARD = Symbol('task-action-input-guard');
export type TaskActionDeliveryGuard = (() => Promise<void>) & {
  onSettled?: () => Promise<void>;
};
type GuardedInput = AgentInputQueuedMessage & {
  [TASK_ACTION_INPUT_GUARD]?: ((target: string, item: AgentInputQueuedMessage) => Promise<void>) & {
    onSettled?: () => Promise<void>;
  };
};

const denied = (errorCode = 'TASK_ACTION_AUTHORIZATION_REQUIRED'): Decision => ({
  ok: false,
  errorCode,
  message:
    'The host could not admit this action for the current turn. Prepare the target, action and content for the owner instead of retrying.',
});


export const HELPER_AUTOMATION_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'schedule_set_pre_run_hook',
  // Re-enabling a feature the owner switched off is a resume (teammate-authority.md).
  'set_teammate_capability', 'set_bot_capability',
]);

/** Side-effect coverage, not an allowlist of what autonomous teammates may do. */
export const SCHEDULER_TASK_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_run_now',
  'schedule_pause', 'schedule_resume', 'schedule_set_pre_run_hook',
  'schedule_webhook_release', 'schedule_webhook_restore',
]);

export interface TaskActionConfirmation {
  server: string;
}

export function taskActionFingerprint(call: Pick<Call, 'tool' | 'args'>): string {
  return createHash('sha256')
    .update(JSON.stringify([call.tool, call.args]))
    .digest('hex');
}

/** One Host-confirmed call, consumed once. Direct and progressive tools use this same gate. */
export function createTaskActionAuthorizer(deps: {
  capture(call: Call): Promise<TaskActionScope | null>;
  confirm(sessionId: string, tool: string, args: unknown): Promise<boolean>;
}): ToolCallAuthorizer {
  return async (call) => {
    const protectedAction =
      call.server === 'cindy_helper'
        ? TASK_ACTION_TOOLS.has(call.tool) || HELPER_AUTOMATION_ACTION_TOOLS.has(call.tool)
        : call.server === 'cindy_scheduler' ? SCHEDULER_TASK_ACTION_TOOLS.has(call.tool)
        : call.server === 'cindy_orca' && ORCA_TASK_ACTION_TOOLS.has(call.tool);
    if (!protectedAction || (call.tool === 'manage_session_prs' && (call.args as Record<string, unknown>)?.action === 'list')) return { ok: true };
    const scope = await deps.capture(call);
    if (!scope) return { ok: true }; // ordinary user-delegated Agent task, unchanged
    if (!call.sessionId) return denied();
    const fingerprint = taskActionFingerprint(call);
    if (!scope.delegated) {
      // An automatic check proposes work in its report; it must not manufacture approval cards.
      if (!scope.ownerInput) return denied();
      if (!(await deps.confirm(call.sessionId, call.tool, structuredClone(call.args))))
        return denied('USER_CANCELLED');
    }
    return admitTaskAction(call, scope, fingerprint);
  };
}

/** Keep admission evidence for downstream writes/queues, including ordinary owner
 * requests that bypass the autonomous-action gate. This does not prompt the owner. */
export async function admitTaskAction(
  call: Call,
  scope: TaskActionScope,
  fingerprint = taskActionFingerprint(call),
): Promise<Decision> {
  if (!call.sessionId) return denied();
  try {
    await scope.assertCurrent();
  } catch {
    return denied('TASK_ACTION_AUTHORIZATION_EXPIRED');
  }
  let consumed = false;
  return {
    ok: true,
    async run<T>(operation: () => Promise<T>): Promise<T> {
      if (consumed || fingerprint !== taskActionFingerprint(call))
        throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
      consumed = true;
      await scope.assertCurrent();
      return actionContext.run(
        {
          sessionId: call.sessionId!,
          tool: call.tool,
          fingerprint,
          assertCurrent: scope.assertCurrent,
          assertCurrentSync: scope.assertCurrentSync,
          assertDeliveryCurrent: scope.assertDeliveryCurrent ?? scope.assertCurrent,
        },
        operation,
      );
    },
  };
}

export async function assertTaskActionCurrent(): Promise<void> {
  await actionContext.getStore()?.assertCurrent();
}

/** An independent inbound request must not inherit the action that lazily started
 * its shared transport. This clears only task-action evidence, not MCP routing;
 * the request still passes the normal token, caller and per-tool authorization. */
export function runTaskActionRequest<T>(operation: () => Promise<T>): Promise<T> {
  return actionContext.exit(operation);
}

/** Cover in-process callers too: authorize this invocation without ambient evidence,
 * then execute under only the returned admission. A bare allow intentionally keeps
 * ordinary-task semantics (no confirmed-action evidence or forced queue). */
export function isolateTaskActionAuthorizer(authorize: ToolCallAuthorizer): ToolCallAuthorizer {
  return (call) => runTaskActionRequest(async () => {
    const decision = await authorize(call);
    if (!decision.ok) return decision;
    return {
      ok: true,
      run: <T>(operation: () => Promise<T>) => runTaskActionRequest(() =>
        decision.run ? decision.run(operation) : operation()),
    };
  });
}

/** Existing lifecycle callbacks can outlive the AsyncLocalStorage call itself. */
export function captureTaskActionGuard(): (() => Promise<void>) | undefined {
  return actionContext.getStore()?.assertCurrent;
}

export class TaskActionAuthorizationError extends Error {
  readonly code = 'TASK_ACTION_AUTHORIZATION_EXPIRED';
  constructor() {
    super('TASK_ACTION_AUTHORIZATION_EXPIRED');
  }
}

const REVOKED_MESSAGES: ReadonlySet<string> = new Set([
  'TASK_ACTION_AUTHORIZATION_EXPIRED',
  'TASK_ACTION_AUTHORIZATION_REQUIRED',
  'OWNER_SCOPE_CHANGED',
]);

/**
 * Whether a delivery-guard rejection proves the grant is gone. A check that merely failed
 * (group transport outage, database not ready, anything unknown) is not a revocation: its
 * message stays queued for retry instead of being destroyed. Group errors are matched by
 * code (`GROUP_AUTHORIZATION_UNAVAILABLE` is the temporary one) to avoid importing the group module.
 */
export function taskActionRevocationCode(error: unknown): string | undefined {
  if (error instanceof TaskActionAuthorizationError) return 'TASK_ACTION_AUTHORIZATION_EXPIRED';
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'GROUP_AUTHORIZATION_REQUIRED')
    return 'GROUP_AUTHORIZATION_REQUIRED';
  return error instanceof Error && REVOKED_MESSAGES.has(error.message) ? error.message : undefined;
}

export function isTaskActionRevoked(error: unknown): boolean {
  return taskActionRevocationCode(error) !== undefined;
}

/** Capture once; late callbacks must not pick up another invocation's authority. */
export function captureTaskActionSyncGuard(): (() => void) | undefined {
  const current = actionContext.getStore();
  if (!current) return undefined;
  return () => {
    if (!current.assertCurrentSync) throw new TaskActionAuthorizationError();
    current.assertCurrentSync();
  };
}

export function hasTaskActionAuthorization(callerSessionId?: string): boolean {
  const current = actionContext.getStore();
  return !!current && (!callerSessionId || current.sessionId === callerSessionId);
}

/** Used by authenticated handoff transport, never returned to the model. */
export function captureTaskActionDeliveryGuard(): (() => Promise<void>) | undefined {
  return actionContext.getStore()?.assertDeliveryCurrent;
}

/** Keep the immutable reviewed body bound to the queued item, including same-turn steering. */
export function bindTaskActionInput(
  target: string,
  item: AgentInputQueuedMessage,
  deliveryGuard?: TaskActionDeliveryGuard,
): void {
  const current = actionContext.getStore();
  const validate = deliveryGuard ?? current?.assertDeliveryCurrent;
  if (!validate) return;
  const onSettled =
    deliveryGuard?.onSettled ?? (item as GuardedInput)[TASK_ACTION_INPUT_GUARD]?.onSettled;
  const text = item.text;
  const clientId = item.clientId;
  item.taskActionRequiresAuthorization = true;
  (item as GuardedInput)[TASK_ACTION_INPUT_GUARD] = async (actualTarget, actualItem) => {
    if (actualItem.text !== text || actualItem.clientId !== clientId || actualTarget !== target)
      throw new Error('TASK_ACTION_AUTHORIZATION_EXPIRED');
    await validate();
  };
  (item as GuardedInput)[TASK_ACTION_INPUT_GUARD]!.onSettled = onSettled;
}

/** Delivery/discard cleanup uses the existing queue lifecycle, never authorizes a retry. */
export async function settleTaskActionInput(item: AgentInputQueuedMessage): Promise<void> {
  await (item as GuardedInput)[TASK_ACTION_INPUT_GUARD]?.onSettled?.();
}

/** Restored input that needed a live grant has attribution, not consent. Never infer a grant from that data. */
export function taskActionInputGuard(
  target: string,
  item: AgentInputQueuedMessage,
): (() => Promise<void>) | undefined {
  const guard = (item as GuardedInput)[TASK_ACTION_INPUT_GUARD];
  if (guard) return () => guard(target, item);
  if (
    item.taskActionRequiresAuthorization ||
    item.clientId.startsWith('remote-task-action:') ||
    (item.origin?.kind === 'session' &&
      item.origin.senderSessionId.includes('::') &&
      !item.botTaskCoordination)
  )
    return async () => {
      throw new Error('TASK_ACTION_AUTHORIZATION_REQUIRED');
    };
  return undefined;
}

/**
 * A recovery copy (hidden "continue", manual retry, zero-output resend) of a turn the receiving
 * task already accepted. The delivery guard is judged only before the first persist, and the copy
 * has a new clientId and text: inheriting the original guard, its "requires authorization" mark or
 * the remote-origin rule would discard it every time. The copy runs under the receiving task's
 * own permissions; attribution (origin, requested owner words) stays on it. Items the guard never
 * covered are returned unchanged.
 */
export function acceptTaskActionRecoveryCopy(
  original: AgentInputQueuedMessage,
  copy: AgentInputQueuedMessage,
): AgentInputQueuedMessage {
  if (!taskActionInputGuard('', original)) return copy;
  delete copy.taskActionRequiresAuthorization;
  // Only the authorization check is waived: the original's settle callback (releasing the receiver
  // claim and sender receipt) still has to run once the copy is dispatched or discarded.
  const accepted: NonNullable<GuardedInput[typeof TASK_ACTION_INPUT_GUARD]> = async () => {};
  accepted.onSettled = (original as GuardedInput)[TASK_ACTION_INPUT_GUARD]?.onSettled;
  (copy as GuardedInput)[TASK_ACTION_INPUT_GUARD] = accepted;
  return copy;
}

/** Share the existing pre-persistence / pre-vendor guard lifecycle with App cards. */
export function combineInputGuards(
  ...guards: Array<(() => Promise<void>) | undefined>
): (() => Promise<void>) | undefined {
  return guards.some(Boolean)
    ? async () => {
        for (const guard of guards) await guard?.();
      }
    : undefined;
}
