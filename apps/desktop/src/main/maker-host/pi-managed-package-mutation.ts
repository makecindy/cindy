import {
  PiManagedPackageMutationFailedError,
  type PiManagedPackageMutationRequest,
} from '@cindy/maker-core';

import type {
  PiPackageMutationRequest,
  PiPackageMutationResult,
} from '../../shared/piPackages.js';
import {
  issuePiPackageMutationGrant,
  type PiPackageMutationGrant,
} from './pi-package-mutation-grant.js';
import {
  mutatePiPackage,
  piPackageMutationMayHaveChangedState,
} from './pi-package-store.js';

type ManagedMutationRequest = Pick<PiPackageMutationRequest, 'action' | 'source'>;

export interface PiManagedPackageMutationDeps {
  issueGrant(request: ManagedMutationRequest): PiPackageMutationGrant;
  mutate(
    request: ManagedMutationRequest,
    grant: PiPackageMutationGrant,
  ): Promise<PiPackageMutationResult>;
}

const defaultDeps: PiManagedPackageMutationDeps = {
  issueGrant: issuePiPackageMutationGrant,
  mutate: mutatePiPackage,
};

export async function mutateAuthorizedPiManagedPackage(
  request: PiManagedPackageMutationRequest,
  deps: PiManagedPackageMutationDeps = defaultDeps,
): Promise<PiPackageMutationResult> {
  const storeRequest = {
    action: request.action,
    source: request.source,
  } as const;

  if (
    request.authorization !== 'local-desktop-command'
    && request.authorization !== 'authenticated-im-command'
    && request.authorization !== 'confirmed-tool-call'
  ) {
    throw new Error('Pi extension mutation is missing host-trusted authorization');
  }

  try {
    return await deps.mutate(storeRequest, deps.issueGrant(storeRequest));
  } catch (error) {
    // Preserve only the convergence bit across the maker-core boundary. Raw
    // command/filesystem details remain Main-local and never enter receipts.
    throw new PiManagedPackageMutationFailedError(
      piPackageMutationMayHaveChangedState(error),
      error,
    );
  }
}
