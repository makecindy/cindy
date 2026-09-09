/** One host boot boundary for the pending-alert query and session serialization. */
let bootAtMs = Date.now();

export function getSessionInterruptionBootAt(): number {
  return bootAtMs;
}

/** Test-only: keep query and serialized interruption evidence on the same clock. */
export function setSessionInterruptionBootAtForTests(value: number): void {
  bootAtMs = value;
}
