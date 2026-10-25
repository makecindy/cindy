/**
 * Requester of the turn that is starting. `other-task`: main stamped another task's user-visible
 * message on the send. `provider-wake`: no send at all, the agent harness woke the session itself
 * (Claude Code background task notifications; see Session `onProviderInitiatedTurn`). Desktop input,
 * IM input and internal delegation coordination are not marked. Scheduler turns are recognised by
 * their own turnOrigin instead.
 */
export type ChannelTurnSource = "other-task" | "provider-wake";

/**
 * The one relay predicate shared by official hook background results and personal IM output:
 * a non-IM, non-scheduler turn returns to the task's channel only for these sources.
 */
export function isRelayedChannelTurnSource(
  source: ChannelTurnSource | undefined,
): boolean {
  return source === "other-task" || source === "provider-wake";
}
