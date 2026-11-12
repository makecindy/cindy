import { describe, expect, it } from 'vitest';

import {
  isSkillhubContentLocale,
  resolvePreferredSystemLocale,
  resolveSystemLocale,
  SKILLHUB_CONTENT_LOCALES,
} from '../locale';

describe('desktop locale resolution', () => {
  it('routes simplified and traditional Chinese tags separately', () => {
    for (const tag of ['zh', 'zh-CN', 'zh-Hans', 'zh-Hans-HK', 'zh-SG']) {
      expect(resolveSystemLocale(tag), tag).toBe('zh-CN');
    }
    for (const tag of ['zh-Hant', 'zh-TW', 'zh-HK', 'zh-MO', 'zh-Hant-CN', 'ZH_HANT_TW']) {
      expect(resolveSystemLocale(tag), tag).toBe('zh-TW');
    }
  });

  it('keeps the explicitly chosen Classical Chinese locale while OS Traditional tags stay zh-TW', () => {
    expect(resolveSystemLocale('zh-Hant-x-lzh')).toBe('zh-Hant-x-lzh');
    expect(resolveSystemLocale('zh-Hans-x-lzh')).toBe('zh-Hans-x-lzh');
    expect(resolveSystemLocale('zh-Hant')).toBe('zh-TW');
    expect(resolvePreferredSystemLocale(['zh-Hant-TW', 'zh-Hant-HK'])).toBe('zh-TW');
  });

  it('uses the first supported locale in the OS preference list', () => {
    expect(resolvePreferredSystemLocale(['it-IT', 'zh-Hant-TW', 'en-US'])).toBe('zh-TW');
    expect(resolvePreferredSystemLocale(['it-IT', 'ja-JP'])).toBe('ja');
    expect(resolvePreferredSystemLocale(['it-IT'])).toBe('en');
  });

  // #8142: each catalog must be reachable from real OS regional language tags.
  it.each([
    ['es-MX', 'es'], ['es-419', 'es'], ['fr-CA', 'fr'], ['de-AT', 'de'],
    ['pt-PT', 'pt-PT'], ['pt-BR', 'pt-BR'], ['PT_br', 'pt-BR'],
    ['pt-Latn-BR', 'pt-BR'], ['pt-AO', 'pt-PT'], ['pt', 'pt-PT'],
  ])('resolves %s to %s', (tag, expected) => {
    expect(resolveSystemLocale(tag)).toBe(expected);
  });

  describe('SkillHub content locales', () => {
    it('includes Turkish in the supported content locales', () => {
      expect(SKILLHUB_CONTENT_LOCALES).toContain('tr');
      expect(isSkillhubContentLocale('tr')).toBe(true);
    });

    it('rejects classical or unknown locales as content locales', () => {
      expect(isSkillhubContentLocale('zh-Hans-x-lzh')).toBe(false);
      expect(isSkillhubContentLocale('unknown')).toBe(false);
      expect(isSkillhubContentLocale(null)).toBe(false);
    });
  });
});
