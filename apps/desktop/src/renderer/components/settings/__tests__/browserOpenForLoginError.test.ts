import { describe, expect, it } from 'vitest';

import { createIpcError } from '../../../../shared/ipc-errors';
import {
  browserOpenForLoginErrorCode,
  browserOpenForLoginToastKey,
} from '../browserOpenForLoginError';

describe('browserOpenForLoginError', () => {
  it('extracts controlled codes after Electron wraps the IPC error', () => {
    const err = new Error(
      'Error invoking remote method: Error: [PROFILE_LOCKED] PROFILE_LOCKED',
    );

    expect(browserOpenForLoginErrorCode(err)).toBe('PROFILE_LOCKED');
    expect(browserOpenForLoginToastKey('PROFILE_LOCKED')).toBe(
      'settings.computerUse.browser.toast.profileLocked',
    );
  });

  it('maps App-Bound Encryption to its recovery guidance', () => {
    const err = createIpcError(
      'APP_BOUND_ENCRYPTION_UNSUPPORTED',
      'APP_BOUND_ENCRYPTION_UNSUPPORTED',
    );

    expect(browserOpenForLoginErrorCode(err)).toBe('APP_BOUND_ENCRYPTION_UNSUPPORTED');
    expect(browserOpenForLoginToastKey('APP_BOUND_ENCRYPTION_UNSUPPORTED')).toBe(
      'settings.computerUse.browser.toast.appBoundEncryptionUnsupported',
    );
  });

  it('does not classify unknown errors as browser domain failures', () => {
    expect(browserOpenForLoginErrorCode(new Error('C:\\private\\Cookies failed'))).toBeNull();
  });
});
