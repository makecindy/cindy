import { describe, expect, it } from 'vitest';

import { extractIpcError } from '../utils/ipcError';

describe('extractIpcError — app shortcut error codes', () => {
  it('recognizes a global shortcut registration conflict', () => {
    expect(
      extractIpcError(
        new Error('[APP_SHORTCUT_GLOBAL_UNAVAILABLE] shortcut is owned by another app'),
      ),
    ).toEqual({
      code: 'APP_SHORTCUT_GLOBAL_UNAVAILABLE',
      message: 'shortcut is owned by another app',
    });
  });
});
