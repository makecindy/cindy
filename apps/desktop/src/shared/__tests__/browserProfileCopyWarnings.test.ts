import { describe, expect, it } from 'vitest';
import { browserProfileCopyWarningsFromData } from '../browserBackend';

describe('browserProfileCopyWarningsFromData', () => {
  it('allows only controlled database names and reasons, stripping native details', () => {
    expect(
      browserProfileCopyWarningsFromData({
        realProfile: {
          warnings: [
            { database: 'Login Data', reason: 'locked', path: '/secret', message: 'credential' },
            { database: '/secret/Login Data', reason: 'locked' },
            { database: 'Web Data', reason: 'native error /secret' },
            null,
          ],
        },
      }),
    ).toEqual([{ database: 'Login Data', reason: 'locked' }]);
  });

  it.each([null, undefined, {}, { realProfile: {} }, { realProfile: { warnings: 'bad' } }])(
    'keeps older or malformed status payloads compatible: %j',
    (data) => {
      expect(browserProfileCopyWarningsFromData(data)).toEqual([]);
    },
  );
});
