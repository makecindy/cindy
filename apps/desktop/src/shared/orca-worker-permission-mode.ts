export const ORCA_WORKER_PERMISSION_MODES = ['auto', 'bypassPermissions'] as const;

export type OrcaWorkerPermissionMode = (typeof ORCA_WORKER_PERMISSION_MODES)[number];

export const DEFAULT_ORCA_WORKER_PERMISSION_MODE: OrcaWorkerPermissionMode = 'auto';

export function isOrcaWorkerPermissionMode(value: unknown): value is OrcaWorkerPermissionMode {
  return ORCA_WORKER_PERMISSION_MODES.some((mode) => mode === value);
}

export function resolveOrcaWorkerPermissionMode(
  value: unknown,
): OrcaWorkerPermissionMode {
  return isOrcaWorkerPermissionMode(value) ? value : DEFAULT_ORCA_WORKER_PERMISSION_MODE;
}
