import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { describe, expect, it } from 'vitest';

const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

function readLocale(locale: (typeof locales)[number]) {
  return JSON.parse(
    readFileSync(resolve(__dirname, '..', 'i18n', 'locales', locale, 'common.json'), 'utf8'),
  ) as {
    newChat?: {
      collaboration?: {
        startFailed?: unknown;
        startFailedContinue?: unknown;
        errors?: Record<string, unknown>;
      };
    };
  };
}

describe('collaboration error i18n', () => {
  it('keeps collaboration start error keys translated in every supported locale', () => {
    for (const locale of locales) {
      const collaboration = readLocale(locale).newChat?.collaboration;

      expect(collaboration?.startFailed, locale).toEqual(expect.any(String));
      expect(collaboration?.startFailedContinue, locale).toEqual(expect.any(String));
      for (const code of [
        'INVALID_PARAMS',
        'PRECONDITION_FAILED',
        'NO_PROVIDER_FOR_AGENT',
        'PROVIDER_ROUTE_UNAVAILABLE',
        'BUDGET_MODEL_REQUIRES_API_MODE',
      ]) {
        expect(collaboration?.errors?.[code], `${locale}:${code}`).toEqual(expect.any(String));
        expect(collaboration?.errors?.[`${code}_CONTINUE`], `${locale}:${code}_CONTINUE`).toEqual(
          expect.any(String),
        );
        expect(collaboration?.errors?.[`${code}_REMOTE`], `${locale}:${code}_REMOTE`).toEqual(
          expect.any(String),
        );
      }
    }
  });
});
