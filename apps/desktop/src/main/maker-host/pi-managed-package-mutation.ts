import { piPackageCommandDiagnostic, piPackageMutationFailureCategory } from './pi-package-diagnostic.js';
import {
  PiManagedPackageMutationFailedError,
  PiManagedPackageMutationCancelledError,
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
  executePiNativeManagementCommand,
  piNativeManagementFailure,
  piPackageMutationMayHaveChangedState,
  type PiPackageMutationHooks,
} from './pi-package-store.js';

const log = createLogger('pi-managed-package-mutation');

type ManagedMutationRequest = Pick<PiPackageMutationRequest, 'action' | 'source'>;

export interface PiManagedPackageMutationDeps {
  issueGrant(request: ManagedMutationRequest): PiPackageMutationGrant;
  mutate(
    request: ManagedMutationRequest,
    grant: PiPackageMutationGrant,
    hooks?: PiPackageMutationHooks,
  ): Promise<PiPackageMutationResult>;
}

const defaultDeps: PiManagedPackageMutationDeps = {
  issueGrant: issuePiPackageMutationGrant,
  mutate: mutatePiPackage,
};

export async function mutateAuthorizedPiManagedPackage(
  request: PiManagedPackageMutationRequest,
  deps: PiManagedPackageMutationDeps = defaultDeps,
  hooks?: PiPackageMutationHooks,
): Promise<PiPackageMutationResult | Record<string, unknown>> {
  if (
    request.authorization !== 'local-desktop-command'
    && request.authorization !== 'authenticated-im-command'
    && request.authorization !== 'confirmed-tool-call'
  ) {
    throw new Error('Pi extension mutation is missing host-trusted authorization');
  }

  try {
    if (request.action === 'command') return await executePiNativeManagementCommand(request.command);
    const storeRequest = { action: request.action, source: request.source };
    const grant = deps.issueGrant(storeRequest);
    return await (hooks
      ? deps.mutate(storeRequest, grant, hooks)
      : deps.mutate(storeRequest, grant));
  } catch (error) {
    if (error instanceof PiManagedPackageMutationCancelledError) throw error;
    const diagnostic = piPackageCommandDiagnostic(error);
    const failureCode = piPackageMutationFailureCategory(error);
    const commandFailure = request.action === 'command' ? piNativeManagementFailure(error) : undefined;
    const mayHaveChangedState = piPackageMutationMayHaveChangedState(error);
    // This wrapper can receive raw Pi/npm/Git stderr containing source
    // credentials. Persist only stable recovery metadata, never Error.message.
    log.warn(commandFailure ? 'Pi management command failed' : 'Pi managed package native mutation failed', {
      action: request.action,
      failureCode,
      mayHaveChangedState,
      ...(diagnostic ? { diagnostic } : {}),
      ...(commandFailure ? { commandFailure } : {}),
    });
    throw new PiManagedPackageMutationFailedError(
      mayHaveChangedState,
      failureCode,
      commandFailure,
      diagnostic,
    );
  }
}
