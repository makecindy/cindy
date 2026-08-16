import type { PiPackageMutationRequest } from '../../shared/piPackages.js';

const grants = new WeakMap<object, Readonly<PiPackageMutationRequest>>();

export interface PiPackageMutationGrant {
  readonly __piPackageMutationGrant: unique symbol;
}

export function issuePiPackageMutationGrant(
  request: PiPackageMutationRequest,
): PiPackageMutationGrant {
  const grant = Object.freeze({}) as PiPackageMutationGrant;
  grants.set(grant, Object.freeze({ ...request }));
  return grant;
}

export function consumePiPackageMutationGrant(
  request: PiPackageMutationRequest,
  grant: PiPackageMutationGrant | undefined,
): void {
  if (!grant) throw new Error('Pi extension mutation requires explicit authorization');
  const expected = grants.get(grant);
  grants.delete(grant);
  if (
    !expected ||
    expected.action !== request.action ||
    expected.source !== request.source ||
    expected.enabled !== request.enabled
  ) {
    throw new Error('Invalid or expired Pi extension mutation authorization');
  }
}

export function piPackageMutationNeedsGrant(request: PiPackageMutationRequest): boolean {
  return (
    request.action === 'install' ||
    request.action === 'update' ||
    (request.action === 'set-enabled' && request.enabled === true)
  );
}
