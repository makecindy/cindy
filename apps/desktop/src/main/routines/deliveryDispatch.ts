import type { AgentRequestReceipt } from '../../shared/forwardedRequest.js';

export type RoutineResultDispatch = (input: {
  targetSessionId: string; dispatcherSessionId: string; clientId: string;
  message: string; persistedContent: string; autoReviewUserText: AgentRequestReceipt;
  resumeWithStoredPermissionMode: true;
  authorizationGuard: { validate(): Promise<void>; assertCurrent(): void };
}) => Promise<{ ok: boolean; message?: string }>;
let dispatch: RoutineResultDispatch | undefined;
/** Reuse the normal task input queue, including busy/cold companion handling. */
export function setRoutineResultDispatch(value: RoutineResultDispatch): void { dispatch = value; }

export function getRoutineResultDispatch(): RoutineResultDispatch | undefined { return dispatch; }
