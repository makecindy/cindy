import type { PiManagedPackageMutationRequest } from '@cindy/maker-core';

import type {
  PiPackageMutationRequest,
  PiPackageMutationResult,
} from '../../shared/piPackages.js';
import {
  issuePiPackageMutationGrant,
  type PiPackageMutationGrant,
} from './pi-package-mutation-grant.js';
import { mutatePiPackage } from './pi-package-store.js';

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

  return deps.mutate(storeRequest, deps.issueGrant(storeRequest));
}
