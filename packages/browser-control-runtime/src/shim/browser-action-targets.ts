import type { BrowserActRequest } from '../_generated/extension/src/browser/client-actions.types.js';

/** Resolve the already-selected tab once, including actions inside a batch. */
export function resolveActionTargetIds(
  action: BrowserActRequest,
  requestedTargetId: string | undefined,
  resolvedTargetId: string,
): BrowserActRequest {
  if (action.targetId && action.targetId !== requestedTargetId && action.targetId !== resolvedTargetId) {
    throw new Error('action targetId must match request targetId');
  }
  return action.kind === 'batch'
    ? {
      ...action,
      targetId: resolvedTargetId,
      actions: action.actions.map((nested) => resolveActionTargetIds(nested, requestedTargetId, resolvedTargetId)),
    }
    : { ...action, targetId: resolvedTargetId };
}
