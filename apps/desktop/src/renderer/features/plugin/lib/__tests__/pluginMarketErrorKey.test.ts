import { describe, expect, it } from 'vitest';

import i18n from '../../../../i18n';
import { GHOST_OFFICIAL_ID_PREFIXES } from '../../../../../shared/ghost';
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
    ['GHOST_BROKER_REDIRECT_PORT_REQUIRED', 'brokerRedirectPortRequired'],
  ])('maps %s to localized market copy', (code, suffix) => {
    expect(pluginMarketErrorKey(serializedIpcError(code))).toBe(
      `settings.ghosts.market.errors.${suffix}`,
    );
  });

  it('reuses the existing Cindy compatibility reminder', () => {
    expect(pluginMarketErrorKey(serializedIpcError('GHOST_HOST_UNSUPPORTED'))).toBe(
      'settings.ghosts.errors.hostUnsupported',
    );
  });

  it('never exposes a plain main-process error message', () => {
    expect(pluginMarketErrorKey(new Error('不应显示给 renderer 的内部错误'))).toBe(
      'settings.ghosts.market.errors.generic',
    );
  });

  it('maps a reserved id to the actionable shared install copy instead of generic retry guidance', () => {
    const key = pluginMarketErrorKey(serializedIpcError('GHOST_ID_RESERVED'));

    // This excludes keeping the default branch that tells users to retry a permanently rejected id.
    expect(key).toBe('settings.ghosts.errors.idReserved');
    expect(key).not.toBe('settings.ghosts.market.errors.generic');
  });

  it.each(['zh-CN', 'zh-TW', 'en', 'ja', 'ko'])(
    'renders the complete reserved-prefix authority in the %s market toast',
    (locale) => {
      const key = pluginMarketErrorKey(serializedIpcError('GHOST_ID_RESERVED'));
      const rawMessage = i18n.getResource(locale, 'common', key);
      const message = i18n.getFixedT(locale)(key).toString();

      // The raw resource check excludes a missing locale being hidden by English fallback.
      expect(rawMessage).toEqual(expect.any(String));
      // These assertions exclude a broken defaultVariables path leaving a literal placeholder.
      expect(message).toContain(GHOST_OFFICIAL_ID_PREFIXES.join(' / '));
      expect(message).not.toContain('{{');
      // This excludes the market channel silently falling back to its generic retry toast.
      expect(message).not.toBe(i18n.getFixedT(locale)('settings.ghosts.market.errors.generic'));
    },
  );

  it.each([
    { locale: 'zh-CN', publisherAction: '联系发布者' },
    { locale: 'zh-TW', publisherAction: '聯絡釋出者' },
    { locale: 'en', publisherAction: 'Contact the publisher' },
    { locale: 'ja', publisherAction: '発行元' },
    { locale: 'ko', publisherAction: '게시자' },
  ])(
    'keeps the broker redirect-port market guidance local and actionable in $locale',
    ({ locale, publisherAction }) => {
      const key = pluginMarketErrorKey(serializedIpcError('GHOST_BROKER_REDIRECT_PORT_REQUIRED'));
      const rawMessage = i18n.getResource(locale, 'common', key);
      const message = i18n.getFixedT(locale)(key).toString();

      // Reading the locale's raw resource excludes a missing key being hidden by English fallback.
      expect(rawMessage).toEqual(expect.any(String));
      // These fragments exclude falling back to the generic retry toast or reusing author-facing copy.
      expect(rawMessage).toContain('redirectPort');
      expect(rawMessage).toContain(publisherAction);
      expect(message).toBe(rawMessage);
      expect(message).not.toBe(i18n.getFixedT(locale)('settings.ghosts.market.errors.generic'));
    },
  );
});
