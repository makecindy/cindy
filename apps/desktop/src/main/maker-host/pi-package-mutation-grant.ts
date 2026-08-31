import type { PiPackageMutationRequest } from '../../shared/piPackages.js';

interface StoredGrant {
  request: Readonly<PiPackageMutationRequest>;
}

const grants = new WeakMap<object, StoredGrant>();

export interface PiPackageMutationGrant {
  readonly __piPackageMutationGrant: unique symbol;
}

export function issuePiPackageMutationGrant(
  request: PiPackageMutationRequest,
): PiPackageMutationGrant {
  const grant = Object.freeze({}) as PiPackageMutationGrant;
  grants.set(grant, {
    request: Object.freeze({ ...request }),
  });
  return grant;
}

export function consumePiPackageMutationGrant(
  request: PiPackageMutationRequest,
  grant: PiPackageMutationGrant | undefined,
): void {
  if (!grant) throw new Error('Pi extension mutation requires explicit authorization');
  const stored = grants.get(grant);
  grants.delete(grant);
  if (
    !stored ||
    stored.request.action !== request.action ||
    stored.request.source !== request.source ||
    stored.request.mutationTarget !== request.mutationTarget ||
    stored.request.enabled !== request.enabled
  ) {
    throw new Error('Invalid or expired Pi extension mutation authorization');
  }
}

export function piPackageMutationNeedsGrant(request: PiPackageMutationRequest): boolean {
  return (
    request.action === 'install' ||
    request.action === 'update' ||
    request.action === 'remove' ||
    (request.action === 'set-enabled' && request.enabled === true)
  );
}
