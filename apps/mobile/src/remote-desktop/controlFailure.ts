/** Failure classification for mobile remote desktop.
 *
 * Control is a lease-scoped capability, not a session: the host can refuse,
 * fail or retract input while the viewer keeps its lease, its video and its
 * picture. Errors in this class must therefore never rebuild the whole remote
 * desktop — they release control and leave the session running.
 */

/** Error codes that mean "this viewer lost control", not "the session died". */
const CONTROL_LOSS_CODES = new Set([
  // Host released control, typically because input injection failed.
  "DESKTOP_VIEW_ONLY",
  // Host has no usable input helper or display for this lease.
  "DESKTOP_INPUT_UNAVAILABLE",
  // Another control request for this lease is still settling.
  "DESKTOP_INPUT_BUSY",
  // The reply is unknown, not the lease: the heartbeat still owns liveness.
  "INVOKE_TIMEOUT",
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

/** True when the failure only costs control and must not restart the session. */
export function isControlLossError(cause: unknown): boolean {
  const code = remoteDesktopErrorCode(cause);
  return code !== undefined && CONTROL_LOSS_CODES.has(code);
}
