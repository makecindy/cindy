import type { InteractionDecision } from '@cindy/maker-core';
import type { InteractiveCardSpec } from '@cindy/im';
import {
  isExpiredPermissionDecision,
  type SharedPermission,
} from '../../maker-ipc/sharedPermission';
import { hasSessionPermissionUpdates } from '@cindy/maker-core';
import { forgetSharedPending, registerPendingExternal } from './pendingInteractions';

/** Receipt only: the Host may hold the choice until the task resumes. */
export const INTERACTION_CHOICE_RECEIVED_TEXT = '已收到你的选择。';

/** Text-only channels and Hook share the same final permission wording. */
export function permissionOutcomeText(decision: InteractionDecision, toolName?: string): string {
  const status =
    decision.kind === 'permission' && decision.behavior === 'allow'
      ? hasSessionPermissionUpdates(decision)
        ? '✅ 已允许（本任务）'
        : '✅ 已允许（仅本次）'
      : isExpiredPermissionDecision(decision)
        ? '⌛ 本次确认已失效'
        : '❌ 已拒绝';
  return toolName ? `${status}：${toolName}` : status;
}

/** Register before network IO; a Desktop decision may arrive while send is in flight. */
export function presentSharedPermissionCard(args: {
  requestId: string;
  toolName: string;
  owner: symbol;
  permission: SharedPermission;
  send(): Promise<{ messageId: string }>;
  resolved(decision: InteractionDecision): InteractiveCardSpec;
  update(messageId: string, spec: InteractiveCardSpec): Promise<void>;
  onError(error: unknown): void;
}): Promise<InteractionDecision> {
  const { permission, requestId } = args;
  if (permission.decision) return permission.result;
  registerPendingExternal(
    requestId,
    'permission',
    '',
    permission.decide,
    () => {
      permission.settle({ kind: 'permission', behavior: 'deny', reason: 'session_disposed' });
    },
    { owner: args.owner, toolName: args.toolName, sharedPermission: permission },
  );
  void permission.result.then(() => forgetSharedPending(requestId, permission));
  // Sending and updating are presentation only: neither delays execution nor
  // rejects a permission that can still be answered in Cindy.
  void (async () => {
    const { messageId } = await args.send();
    const decision = await permission.result;
    await args.update(messageId, args.resolved(decision));
  })().catch(args.onError);
  return permission.result;
}
