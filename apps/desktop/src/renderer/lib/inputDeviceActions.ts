import type { InputDeviceRendererAction } from '../../shared/inputDevices';

export type InputDeviceActionHandler = (action: InputDeviceRendererAction) => boolean | void;

export interface InputDeviceApprovalTarget {
  kind: 'permission' | 'plan_review';
  requestId: string;
  observedAtMs: number;
}

const handlers = new Set<InputDeviceActionHandler>();
const bridges = new Set<() => void>();

/**
 * Hardware adapters fan into one renderer bus. Newest subscribers run first
 * so the focused task can consume a command before the shell fallback.
 */
export function subscribeInputDeviceAction(handler: InputDeviceActionHandler): () => void {
  handlers.add(handler);
  return () => {
    handlers.delete(handler);
  };
}

export function dispatchInputDeviceAction(action: InputDeviceRendererAction): void {
  for (const listener of [...handlers].reverse()) {
    if (listener(action) === true) break;
  }
}

/**
 * Bind an approval command only to the interaction that was already visible
 * when the hardware produced it. Main and renderer IPC channels can be
 * reordered, so an action issued for A must not be rebound to replacement B.
 * Actions from adapters without issuance metadata retain the legacy behavior.
 */
export function bindInputDeviceApprovalActionToTarget<T extends InputDeviceApprovalTarget>(
  action: InputDeviceRendererAction,
  target: T | null,
): T | null {
  if (
    action.type !== 'command' ||
    (action.commandId !== 'approval.approve' && action.commandId !== 'approval.decline') ||
    !target
  ) {
    return null;
  }
  if (action.issuedAtMs !== undefined && action.issuedAtMs <= target.observedAtMs) {
    return null;
  }
  return target;
}

/** Match the task view's visible-card priority: plan review precedes permission. */
export function createVisibleInputDeviceApprovalTarget(
  pendingPermissionRequestId: string | null,
  pendingPlanReviewRequestId: string | null,
  observedAtMs: number,
): InputDeviceApprovalTarget | null {
  if (pendingPlanReviewRequestId) {
    return {
      kind: 'plan_review',
      requestId: pendingPlanReviewRequestId,
      observedAtMs,
    };
  }
  return pendingPermissionRequestId
    ? {
        kind: 'permission',
        requestId: pendingPermissionRequestId,
        observedAtMs,
      }
    : null;
}

/** Let an adapter attach its preload channel without owning the subscriber set. */
export function attachInputDeviceActionBridge(
  connect: () => (() => void) | null | undefined,
): void {
  if (typeof window === 'undefined') return;
  const unsubscribe = connect();
  if (unsubscribe) bridges.add(unsubscribe);
}

export function __resetInputDeviceActionsForTests(): void {
  handlers.clear();
  for (const unsubscribe of bridges) unsubscribe();
  bridges.clear();
}
