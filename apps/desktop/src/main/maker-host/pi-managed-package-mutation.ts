import {
  PiManagedPackageMutationFailedError,
  type PiManagedPackageMutationFailureCode,
  type PiManagedPackageMutationRequest,
} from '@cindy/maker-core';

import type {
  PiPackageMutationRequest,
  PiPackageMutationResult,
} from '../../shared/piPackages.js';
import { createLogger } from '../logger.js';
import {
  issuePiPackageMutationGrant,
  type PiPackageMutationGrant,
} from './pi-package-mutation-grant.js';
import {
  mutatePiPackage,
  piPackageMutationMayHaveChangedState,
} from './pi-package-store.js';

const log = createLogger('pi-managed-package-mutation');

type ManagedMutationRequest = Pick<PiPackageMutationRequest, 'action' | 'source'>;

function classifyMutationFailure(error: unknown): PiManagedPackageMutationFailureCode {
  const message = (error instanceof Error ? error.message : String(error)).toLowerCase();
  if (message.includes('state is unavailable')) return 'state-unavailable';
  if (/\betarget\b|no matching version|version[^\n]*not found/.test(message)) {
    return 'version-not-found';
  }
  if (/\be404\b|package[^\n]*not found|repository[^\n]*not found|404 not found/.test(message)) {
    return 'package-not-found';
  }
  if (/\benotfound\b|\beai_again\b|\beconnrefused\b|\betimedout\b|network|fetch failed|could not resolve host|unable to access/.test(message)) {
    return 'source-unavailable';
  }
  return 'native-command-failed';
}

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
    const failureCode = classifyMutationFailure(error);
    log.warn('Pi managed package native mutation failed', {
      action: request.action,
      failureCode,
      message: error instanceof Error ? error.message : String(error),
    });
    // Preserve only stable recovery metadata across the maker-core boundary.
    // Raw command/filesystem details remain Main-local and never enter receipts.
    throw new PiManagedPackageMutationFailedError(
      piPackageMutationMayHaveChangedState(error),
      failureCode,
    );
  }
}
