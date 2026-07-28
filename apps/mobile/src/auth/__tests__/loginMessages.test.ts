import { describe, expect, it, vi } from 'vitest';

/**
 * 登录域 4 语 catalog 测试(zh-CN/en/ja/ko,中文全并进 zh-CN):
 * key 全集 4 语一致非空、placeholder 逐语一致、系统 locale 解析规则
 * (zh 系一律→zh-CN / ja / ko / 兜底 en)。
 * expo-localization 依赖 RN 原生模块,node vitest 下用 vi.mock 隔离,
 * locale 解析走导出的纯函数 resolveLoginLocale 断言。
 */
const mockLanguageTag = { current: 'en-US' };
vi.mock('expo-localization', () => ({
  getLocales: () => [{ languageTag: mockLanguageTag.current }],
}));

import {
  authErrorMessages,
  authErrorText,
  getAuthLocale,
  loginMessages,
  loginText,
  resolveLoginLocale,
  type LoginLocale,
} from '@/auth/loginMessages';

const LOCALES: LoginLocale[] = ['zh-CN', 'en', 'ja', 'ko'];

describe('loginMessages 4 语 catalog', () => {
  it('catalog 覆盖全部 4 个 locale', () => {
    expect(Object.keys(loginMessages).sort()).toEqual([...LOCALES].sort());
  });

  it('4 语 key 全集一致且值非空', () => {
    const baseKeys = Object.keys(loginMessages['zh-CN']).sort();
    expect(baseKeys.length).toBeGreaterThan(0);
    for (const locale of LOCALES) {
      const catalog = loginMessages[locale];
      expect(Object.keys(catalog).sort(), `locale=${locale} key 集`).toEqual(
        baseKeys,
      );
      for (const [key, value] of Object.entries(catalog)) {
        expect(value.trim(), `locale=${locale} key=${key} 不得为空`).not.toBe(
          '',
        );
      }
    }
  });

  it('placeholder 逐语一致({email}/{org}/{reason})', () => {
    for (const locale of LOCALES) {
      const catalog = loginMessages[locale];
      expect(catalog.orgDetected, `locale=${locale}`).toContain('{email}');
      expect(catalog.orgDetected, `locale=${locale}`).toContain('{org}');
      expect(catalog.ssoOrgDetected, `locale=${locale}`).toContain('{org}');
      expect(catalog.endpointGateSubtitle, `locale=${locale}`).toContain(
        '{reason}',
      );
    }
  });

  it('手机号 placeholder 与固定 +86 前缀语义一致,不再提示输入国码', () => {
    expect(loginMessages['zh-CN'].phonePlaceholder).toBe('输入手机号');
    expect(loginMessages.en.phonePlaceholder).toBe('Phone number');
    expect(loginMessages.ja.phonePlaceholder).toBe('携帯電話番号');
    expect(loginMessages.ko.phonePlaceholder).toBe('휴대전화 번호');
  });

  it('登录错误码 4 语齐全且非空', () => {
    const codes = Object.keys(authErrorMessages);
    expect(codes.length).toBeGreaterThan(0);
    for (const code of codes) {
      const perLocale = authErrorMessages[code];
      expect(Object.keys(perLocale).sort(), `code=${code}`).toEqual(
        [...LOCALES].sort(),
      );
      for (const locale of LOCALES) {
        expect(
          perLocale[locale].trim(),
          `code=${code} locale=${locale} 不得为空`,
        ).not.toBe('');
      }
    }
  });
});

describe('resolveLoginLocale 系统 locale 解析', () => {
  it('zh 系(含 Hans/Hant/TW/HK/MO)一律 → zh-CN', () => {
    for (const tag of [
      'zh-Hant',
      'zh-Hant-TW',
      'zh-Hant-HK',
      'zh-TW',
      'zh-HK',
      'zh-MO',
      'ZH-HANT-TW',
      'zh-Hans-CN',
    ]) {
      expect(resolveLoginLocale(tag), tag).toBe('zh-CN');
    }
  });

  it('其余 zh → zh-CN(显式 Hans 脚本优先于港澳地区)', () => {
    for (const tag of [
      'zh',
      'zh-CN',
      'zh-Hans',
      'zh-Hans-CN',
      'zh-SG',
      'zh-Hans-HK',
      'zh-Hans-MO',
    ]) {
      expect(resolveLoginLocale(tag), tag).toBe('zh-CN');
    }
  });

  it('ja / ko 前缀直取', () => {
    expect(resolveLoginLocale('ja')).toBe('ja');
    expect(resolveLoginLocale('ja-JP')).toBe('ja');
    expect(resolveLoginLocale('ko')).toBe('ko');
    expect(resolveLoginLocale('ko-KR')).toBe('ko');
  });

  it('其余与缺失 → 兜底 en', () => {
    for (const tag of ['en-US', 'fr-FR', 'de', '', undefined, null]) {
      expect(resolveLoginLocale(tag), String(tag)).toBe('en');
    }
  });
});

describe('loginText / authErrorText 按系统 locale 取文案', () => {
  it('繁中系统 locale 下取 zh-CN 文案(中文全并进 zh-CN)', () => {
    mockLanguageTag.current = 'zh-Hant-TW';
    expect(loginText('title')).toBe(loginMessages['zh-CN'].title);
    expect(authErrorText('INVALID_CODE')).toBe(
      authErrorMessages.INVALID_CODE['zh-CN'],
    );
  });

  it('getAuthLocale 钳制在旧 wire 值域 zh-CN | en(server 5 语支持未验证前不外溢)', () => {
    const expectations: Array<[string, 'zh-CN' | 'en']> = [
      ['zh-Hans-CN', 'zh-CN'],
      ['zh-Hant-TW', 'zh-CN'],
      ['ja-JP', 'en'],
      ['ko-KR', 'en'],
      ['en-US', 'en'],
    ];
    for (const [tag, expected] of expectations) {
      mockLanguageTag.current = tag;
      expect(getAuthLocale(), tag).toBe(expected);
    }
  });

  it('未知错误码回退 errorFallback,null 返回 null', () => {
    mockLanguageTag.current = 'ko-KR';
    expect(authErrorText('SOME_UNKNOWN_CODE')).toBe(
      loginMessages.ko.errorFallback,
    );
    expect(authErrorText(null)).toBeNull();
  });
});
