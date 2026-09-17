import type { AgentInputCreateOpts, AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import type { SessionMeetingPeerCapture } from '../device-link/sessionMeetingDispatch.js';
import { assertSessionMeetingReferences, sessionMeetingOwnedQueueReferences } from '../device-link/sessionMeetingDispatch.js';

/** Build privileged input configuration from host truth, not guest queue snapshots. */
export function stampSessionMeetingInput(
  item: AgentInputQueuedMessage, capture: SessionMeetingPeerCapture | undefined,
  task: AgentInputCreateOpts | undefined,
): AgentInputQueuedMessage {
  const stamped = { ...item };
  delete stamped.meetingAuthor;
  if (!capture) return stamped;
  if (!task || !capture.isCurrent() || !capture.authorize('input.send')) {
    throw new Error('[PERMISSION_DENIED] Meeting task access denied');
  }
  assertSessionMeetingReferences(item, capture.author.sessionId, 0, capture.author.meetingId, sessionMeetingOwnedQueueReferences(capture, item.clientId));
  // Only content comes from the guest. The task owns runtime/bootstrap settings.
  stamped.createOpts = { ...task };
  stamped.workingDir = task.workingDir;
  stamped.permissionMode = task.permissionMode ?? 'ask';
  stamped.model = task.model;
  stamped.effort = task.effort ?? '';
  delete stamped.vendorOptions;
  delete stamped.origin;
  delete stamped.autoResume;
  delete stamped.autoResumeInfo;
  delete stamped.recoveryCheckpoint;
  delete stamped.bypassGhostHooks;
  delete stamped.hostAcceptedAtMs;
  stamped.meetingAuthor = { ...capture.author };
  stamped.userName = capture.author.displayName;
  return stamped;
}

/** Run inside the synchronous queue mutation, after all asynchronous preparation. */
export function assertSessionMeetingQueueMutation(
  capture: SessionMeetingPeerCapture | undefined, sessionId: string,
  operation: 'input.send' | 'input.edit' | 'input.withdraw' | 'agent.stop',
  item?: AgentInputQueuedMessage,
): void {
  if (!capture) return;
  const author = item?.meetingAuthor;
  if (capture.author.sessionId !== sessionId || !capture.isCurrent() ||
      (operation === 'input.edit' || operation === 'input.withdraw') &&
      (!author || author.meetingId !== capture.author.meetingId || author.memberId !== capture.author.memberId) ||
      !capture.authorize(operation, item ? {
        sessionId, authorAccountId: author?.accountId ?? '', state: 'pending',
      } : undefined)) {
    throw new Error('[PERMISSION_DENIED] Meeting task access denied');
  }
}
