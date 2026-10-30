/** An IPC lifecycle failure does not establish whether the OS opened the path. */
export interface OpenPathResult {
  success: boolean;
  error?: string;
  failureKind?: 'ipc_lifecycle';
}

export function shouldShowOpenPathError(result: OpenPathResult): boolean {
  return !result.success && result.failureKind !== 'ipc_lifecycle';
}
