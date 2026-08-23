import type { PiPackageMutationRequest } from '../../shared/piPackages.js';

export interface PiPackageMutationGrantBinding {
  /**
   * The executable package identity shown before enabling. `null` means the
   * inspected package had no Extension resources at confirmation time.
   */
  expectedPackageFingerprint?: string | null;
}

interface StoredGrant {
  request: Readonly<PiPackageMutationRequest>;
  binding: Readonly<PiPackageMutationGrantBinding>;
}

const grants = new WeakMap<object, StoredGrant>();

export interface PiPackageMutationGrant {
  readonly __piPackageMutationGrant: unique symbol;
}

export function issuePiPackageMutationGrant(
  request: PiPackageMutationRequest,
  binding: PiPackageMutationGrantBinding = {},
): PiPackageMutationGrant {
  const grant = Object.freeze({}) as PiPackageMutationGrant;
  grants.set(grant, {
    request: Object.freeze({ ...request }),
    binding: Object.freeze({ ...binding }),
  });
  return grant;
}

export function consumePiPackageMutationGrant(
  request: PiPackageMutationRequest,
  grant: PiPackageMutationGrant | undefined,
): Readonly<PiPackageMutationGrantBinding> {
  if (!grant) throw new Error('Pi extension mutation requires explicit authorization');
  const stored = grants.get(grant);
  grants.delete(grant);
  if (
    !stored ||
    stored.request.action !== request.action ||
    stored.request.source !== request.source ||
    stored.request.enabled !== request.enabled
  ) {
    throw new Error('Invalid or expired Pi extension mutation authorization');
  }
  return stored.binding;
}

export function piPackageMutationNeedsGrant(request: PiPackageMutationRequest): boolean {
  return (
    request.action === 'install' ||
    request.action === 'update' ||
    request.action === 'remove' ||
    (request.action === 'set-enabled' && request.enabled === true)
  );
}
