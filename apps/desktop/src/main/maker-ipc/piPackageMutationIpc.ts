import { piPackageCommandDiagnostic } from '../maker-host/pi-package-diagnostic.js';
import { isIpcError } from '../../shared/ipc-errors.js';
import { throwIpcError } from '../utils/ipcValidate.js';

/** Keep package-list process and filesystem details inside Main. */
export async function runPiPackageListIpcBoundary<T>(
  operation: () => Promise<T>,
  failureMessage: string,
  onUnexpectedError: (error: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    onUnexpectedError(error);
    throwIpcError('PI_PACKAGE_LIST_FAILED', failureMessage);
  }
}

/** Keep package-manager details in Main while exposing one stable IPC contract. */
export async function runPiPackageMutationIpcBoundary<T>(
  operation: () => Promise<T>,
  failureMessage: string | ((error: unknown) => string),
  onUnexpectedError: (error: unknown) => void,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (isIpcError(error) && error.code === 'MUTATION_CANCELLED') throw error;
    onUnexpectedError(error);
    const message = typeof failureMessage === 'function' ? failureMessage(error) : failureMessage;
    const diagnostic = piPackageCommandDiagnostic(error);
    // Existing Electron error serialization preserves only code/message. Add
    // the safe evidence there so old Settings consumers also receive it.
    throwIpcError(
      'PI_PACKAGE_MUTATION_FAILED',
      diagnostic ? `${message} ${JSON.stringify(diagnostic)}` : message,
    );
  }
}
