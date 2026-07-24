import { describe, expect, it } from 'vitest';

import { pluginMarketErrorKey } from '../pluginMarketErrorKey';

function serializedIpcError(code: string): Error {
  return new Error(`Error invoking remote method: Error: [${code}] internal detail`);
}

describe('pluginMarketErrorKey', () => {
  it.each([
    ['INVALID_PARAMS', 'invalidRequest'],
    ['NOT_FOUND', 'notFound'],
    ['ALREADY_EXISTS', 'conflict'],
    ['PRECONDITION_FAILED', 'stateChanged'],
    ['PERMISSION_DENIED', 'accessDenied'],
    ['UNSUPPORTED_CAPABILITY', 'notConfigured'],
    ['GHOST_FILE_INVALID', 'invalidPackage'],
  ])('maps %s to localized market copy', (code, suffix) => {
    expect(pluginMarketErrorKey(serializedIpcError(code))).toBe(
      `settings.ghosts.market.errors.${suffix}`,
    );
  });

  it('never exposes a plain main-process error message', () => {
    expect(pluginMarketErrorKey(new Error('不应显示给 renderer 的内部错误'))).toBe(
      'settings.ghosts.market.errors.generic',
    );
  });
});
