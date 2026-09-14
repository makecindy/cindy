import { describe, expect, it } from 'vitest';

import { extractIpcError } from '../utils/ipcError';

describe('extractIpcError · Pi extension package errors', () => {
  it('recognizes the stable list failure code after Electron serialization', () => {
    expect(
      extractIpcError(
        new Error(
          'Error invoking remote method maker:pi-packages:list: Error: ' +
            '[PI_PACKAGE_LIST_FAILED] The Pi extension list could not be loaded.',
        ),
      ),
    ).toEqual({
      code: 'PI_PACKAGE_LIST_FAILED',
      message: 'The Pi extension list could not be loaded.',
    });
  });
});
