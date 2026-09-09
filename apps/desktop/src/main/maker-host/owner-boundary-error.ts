/**
 * owner-bound 出站在账号切换窗口里的唯一可重试错误。
 * 任何 catch 都不得把它改写成 401 / 502 / authentication_error。
 */
export const OWNER_BOUNDARY_PENDING_ERROR =
  'App session is switching; retry after the owner boundary settles.';

export class OwnerBoundaryPendingError extends Error {
  readonly code = 'owner_boundary_pending' as const;

  constructor(message = OWNER_BOUNDARY_PENDING_ERROR) {
    super(message);
    this.name = 'OwnerBoundaryPendingError';
  }
}

export function isOwnerBoundaryPendingError(err: unknown): boolean {
  if (err instanceof OwnerBoundaryPendingError) return true;
  if (!(err instanceof Error)) return false;
  if (err.name === 'OwnerBoundaryPendingError') return true;
  if ((err as { code?: unknown }).code === 'owner_boundary_pending') return true;
  return err.message === OWNER_BOUNDARY_PENDING_ERROR;
}
