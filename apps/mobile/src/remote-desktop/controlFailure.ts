/** Failure classification for mobile remote desktop.
 *
 * Control is a lease-scoped capability, not a session: the host can refuse,
 * fail or retract input while the viewer keeps its lease, its video and its
 * picture. Errors in that class must never rebuild the whole remote desktop —
 * they release control and leave the session running. Failures whose outcome is
 * unknown (a lost reply) are neither: guessing either way would either strand
 * input or needlessly drop the picture.
 */

export type ControlFailureAction =
  // The host no longer counts this viewer as controlling: drop to view only.
  | "release"
  // Unknown or transient: keep control and let the next attempt decide.
  | "ignore"
  // The lease itself is unusable: rebuild the session with the existing path.
  | "rebuild";

/** Failure codes that mean "this viewer lost control", not "the session died". */
const CONTROL_LOSS_CODES = new Set([
  // Host released control, typically because input injection failed.
  "DESKTOP_VIEW_ONLY",
  // Host has no usable input helper or display for this lease.
  "DESKTOP_INPUT_UNAVAILABLE",
]);

/** Failure codes whose outcome is unknown: neither release nor rebuild. */
const UNKNOWN_OUTCOME_CODES = new Set([
  // The batch may or may not have been injected; the heartbeat owns liveness.
  "INVOKE_TIMEOUT",
  // Another control request for this lease is still settling.
  "DESKTOP_INPUT_BUSY",
]);

/** Stable error code of a remote-desktop failure, or undefined when unknown. */
export function remoteDesktopErrorCode(cause: unknown): string | undefined {
  const message = cause instanceof Error ? cause.message : String(cause);
  const code =
    cause &&
    typeof cause === "object" &&
    "code" in cause &&
    typeof cause.code === "string"
      ? cause.code
      : message.match(
          /\b(?:DESKTOP|CHANNEL|DEVICE|INVOKE|REMOTE|ACCESS)_[A-Z_]+\b/,
        )?.[0];
  return code && /^[A-Z_]+$/.test(code) ? code : undefined;
}

/** What a failed input or control request should do to this viewer. */
export function controlFailureAction(cause: unknown): ControlFailureAction {
  const code = remoteDesktopErrorCode(cause);
  if (code === undefined) return "rebuild";
  if (CONTROL_LOSS_CODES.has(code)) return "release";
  if (UNKNOWN_OUTCOME_CODES.has(code)) return "ignore";
  return "rebuild";
}
