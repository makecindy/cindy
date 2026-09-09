import { describe, expect, it } from 'vitest';

import { extractIpcError } from '../utils/ipcError';

describe('extractIpcError · saved-account errors', () => {
  it.each(['ACCOUNT_REAUTH_REQUIRED', 'REGION_MISMATCH', 'CREDENTIAL_STORE_UNAVAILABLE'] as const)(
    'decodes %s after Electron wraps the main-process error',
    (code) => {
      expect(
        extractIpcError(
          new Error(`Error invoking remote method 'auth:accounts:switch': Error: [${code}] failed`),
        ),
      ).toEqual({ code, message: 'failed' });
    },
  );
});
