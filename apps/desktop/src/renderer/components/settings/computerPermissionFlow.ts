/** Whether the current runtime permission snapshot is sufficient for use. */
export function isComputerPermissionReady(status: ComputerDriverStatus | null): boolean {
  if (status === null) return false;
  const permissionState = status.permissionState;
  return !permissionState?.required || permissionState.status === 'granted';
}

/** Whether passive preflight could not establish the current permission state. */
export function isComputerPermissionPreflightInconclusive(
  status: ComputerDriverStatus | null,
): boolean {
  return status?.permissionState?.required === true
    && status.permissionState.status === 'unknown';
}

/** Start onboarding only after preflight proves at least one permission is missing. */
export function shouldStartComputerPermissionGuide(
  enabling: boolean,
  status: ComputerDriverStatus | null,
): boolean {
  return enabling && status?.permissionState?.status === 'missing';
}

/** Keep persisted opt-in separate from whether the runtime is currently ready. */
export function getComputerPermissionSwitchChecked(
  enabled: boolean,
  togglePending: boolean,
  enableIntent: boolean,
): boolean {
  return togglePending ? enableIntent : enabled;
}
