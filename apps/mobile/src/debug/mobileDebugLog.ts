/** Phone-local instrumentation only. Never pass session bodies, request payloads or credentials. */
export type MobileDebugScope =
  | "device-link"
  | "recovery"
  | "lifecycle"
  | "performance"
  | "scroll"
  | "keyboard";
export type MobileDebugLevel = "debug" | "info" | "warn" | "error";
type Sink = (
  level: MobileDebugLevel,
  scope: MobileDebugScope,
  args: unknown[],
) => void;
let sink: Sink | undefined;

export function setMobileDebugSink(next: Sink | undefined): void {
  sink = next;
}
export function mobileDebugEnabled(): boolean {
  return sink !== undefined;
}

/** Disabled recording does no serialization or native I/O. Diagnostics must never break the app. */
export function mobileDebugLog(
  level: MobileDebugLevel,
  scope: MobileDebugScope,
  ...args: unknown[]
): void {
  try {
    sink?.(level, scope, args);
  } catch {
    /* best-effort instrumentation */
  }
}
