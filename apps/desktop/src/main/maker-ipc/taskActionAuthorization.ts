import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import type { ToolCallAuthorizer } from '@cindy/mcps';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';

type Call = Parameters<ToolCallAuthorizer>[0];
type Decision = Awaited<ReturnType<ToolCallAuthorizer>>;

/** These names describe effects, not tool visibility or an Agent permission mode. */
export const TASK_ACTION_TOOLS: ReadonlySet<string> = new Set([
  'send_to_agent',
  'continue_workbench_task',
  'set_workbench_task_responsibility',
  'set_teammate_project',
  'send_to_session',
  'steer_session',
  'stop_session_turn',
  'set_session_runtime',
  'update_session_queued_message',
  'cancel_session_queued_message',
  'steer_session_queued_message',
  'move_session_queued_message',
  'start_session_task',
  'message_session_task',
  'stop_session_task',
  'advance_session_task_route',
  'archive_sessions',
  'unarchive_sessions',
  'rename_sessions',
  'move_session',
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

/** A confirmed new delegation may advance only its own live execution. */
export const DELEGATED_TASK_ACTIONS = ['message_session_task', 'stop_session_task'] as const;

/**
 * Who a teammate turn speaks for, decided by the Host before any permission mode applies.
 * - owner: the owner typed this turn (or a verified owner request in a group / IM lane);
 * - entrusted: a standing owner grant (an owner-created routine, the teammate's own Orca team);
 * - autonomous: anything else (follow-up wake-ups, teammate messages, non-owner speakers).
 * Ordinary (non-teammate) callers carry no principal and keep the normal permission flow.
 */
export type TaskActionPrincipal = 'owner' | 'entrusted' | 'autonomous';

export interface TaskActionScope {
  /** Host identity/active-input generation, captured before the confirmation. */
  key: string;
  ownerInput: boolean;
  principal?: TaskActionPrincipal;
  /** Existing, explicitly confirmed delegation; never inferred from creator/follower. */
  delegated: boolean;
  /** Rechecked at mutation/delivery; includes account, target and delegation revocation. */
  assertCurrent(): Promise<void>;
  /** Host generation check for existing synchronous commit/pre-send callbacks. */
  assertCurrentSync?(): void;
  assertDeliveryCurrent?(): Promise<void>;
}

interface ActionContext {
  sessionId: string;
  tool: string;
  fingerprint: string;
  principal?: TaskActionPrincipal;
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

/** A teammate acting on its own initiative must not act as the owner on the owner's tasks. */
export const NEEDS_OWNER_REQUEST: Decision = {
  ok: false,
  errorCode: 'NEEDS_OWNER_REQUEST',
  message:
    'The owner did not ask for this in the current turn (host-verified). On your own initiative you may read, keep Todos, notify the owner, message teammates, manage background tasks you started and continue tasks already handed to you; changing the owner’s other tasks needs the owner’s request. Do not retry: record a Todo or notify the owner with the concrete task, action and reason so they can ask you to do it.',
};

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
        ? TASK_ACTION_TOOLS.has(call.tool)
        : call.server === 'cindy_orca' && ORCA_TASK_ACTION_TOOLS.has(call.tool);
    if (!protectedAction) return { ok: true };
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
          principal: scope.principal,
          assertCurrent: scope.assertCurrent,
          assertCurrentSync: scope.assertCurrentSync,
          assertDeliveryCurrent: scope.assertDeliveryCurrent ?? scope.assertCurrent,
        },
        operation,
      );
    },
  };
}

/** Host-only creation evidence; no tool parameter can mint this snapshot. */
export function approvedTaskDelegation(
  callerSessionId: string,
): { version: 1; actions: readonly string[] } | undefined {
  const current = actionContext.getStore();
  return current?.sessionId === callerSessionId && current.tool === 'start_session_task'
    ? { version: 1, actions: DELEGATED_TASK_ACTIONS }
    : undefined;
}

/** Host-decided principal of the admitted call, for receipts. Tool arguments cannot set it. */
export function taskActionPrincipal(callerSessionId: string): TaskActionPrincipal | undefined {
  const current = actionContext.getStore();
  return current?.sessionId === callerSessionId ? current.principal : undefined;
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
 * ordinary-task semantics (no Bot delegation evidence or forced queue). */
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

/** Host lifecycle only: durable completion delivery is not another invocation
 * of the tool that started the task. Its caller must validate the persisted
 * delegation/run and recipient; this does not authorize any Agent task action. */
export function runHostCompletionDelivery<T>(operation: () => Promise<T>): Promise<T> {
  return actionContext.exit(operation);
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

/** Restored legacy Bot input has attribution, not consent. Never infer a grant from that data. */
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
      (item.origin.senderBotId || item.origin.senderSessionId.includes('::')) &&
      !item.botTaskCoordination &&
      !item.clientId.startsWith('bot-dm:'))
  )
    return async () => {
      throw new Error('TASK_ACTION_AUTHORIZATION_REQUIRED');
    };
  return undefined;
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
