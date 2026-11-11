import type { getComputerDriverStatus } from '../mcp-integrations/computer.js';

export type ComputerStatusRequest = NonNullable<Parameters<typeof getComputerDriverStatus>[0]> & {
  /** Page-entry reads must not publish a delayed snapshot into an active guide. */
  refreshPermissionGuide?: boolean;
};

/** Keep request-local reads separate from explicit permission-guide refreshes. */
export async function readComputerStatusForSettings(
  options: ComputerStatusRequest | undefined,
  deps: {
    getStatus: typeof getComputerDriverStatus;
    refreshPermissionGuide: (status: Awaited<ReturnType<typeof getComputerDriverStatus>>) => void;
  },
) {
  const { refreshPermissionGuide, ...probeOptions } = options ?? {};
  const status = await deps.getStatus(probeOptions);
  if (
    refreshPermissionGuide !== false
    && (probeOptions.forcePermissionProbe === true || probeOptions.freshPermissionProbe === true)
  ) {
    deps.refreshPermissionGuide(status);
  }
  return status;
}
