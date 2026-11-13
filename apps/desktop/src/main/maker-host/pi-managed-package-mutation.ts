import {
  mutatePiPackage,
  executePiNativeManagementCommand,
  piNativeManagementFailure,
  piPackageMutationMayHaveChangedState,
} from './pi-package-store.js';
import { createPiManagedPackageMutation } from './piManagedPackageMutationCore.js';
export type { PiManagedPackageMutationDeps } from './piManagedPackageMutationCore.js';

/** The desktop's binding of the managed mutation shared with the Node Host (piManagedPackageMutationCore.ts). */
const piManagedPackageMutation = createPiManagedPackageMutation({
  mutatePiPackage: (...args) => mutatePiPackage(...args),
  executePiNativeManagementCommand: (...args) => executePiNativeManagementCommand(...args),
  piNativeManagementFailure: (...args) => piNativeManagementFailure(...args),
  piPackageMutationMayHaveChangedState: (...args) => piPackageMutationMayHaveChangedState(...args),
});

export async function mutateAuthorizedPiManagedPackage(
  ...args: Parameters<typeof piManagedPackageMutation.mutateAuthorizedPiManagedPackage>
): ReturnType<typeof piManagedPackageMutation.mutateAuthorizedPiManagedPackage> {
  return piManagedPackageMutation.mutateAuthorizedPiManagedPackage(...args);
}
