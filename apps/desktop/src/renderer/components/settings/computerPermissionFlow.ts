/** Whether the current runtime permission snapshot is sufficient for use. */
export function isComputerPermissionReady(status: ComputerDriverStatus | null): boolean {
  const permissionState = status?.permissionState;
  return !permissionState?.required || permissionState.status === 'granted';
}

/** Start onboarding only after preflight proves at least one permission is missing. */
export function shouldStartComputerPermissionGuide(
  enabling: boolean,
  status: ComputerDriverStatus | null,
): boolean {
  return enabling && !isComputerPermissionReady(status);
}
