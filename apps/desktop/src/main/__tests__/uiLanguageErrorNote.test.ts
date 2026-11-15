import { describe, expect, it } from 'vitest';
import { CLASSICAL_REPLY_STYLES } from '@cindy/maker-shared/classical-reply';
import { SUPPORTED_LOCALES } from '../../shared/locale';
import {
  buildUiLanguageErrorNote,
  readClaimedClassicalStyle,
  readClaimedUiLanguage,
  turnClassicalStyleFromSendOpts,
  resolveTurnUiLanguage,
  stampTurnUiLanguage,
  turnUiLanguageFromSendOpts,
} from '../maker-ipc/uiLanguageErrorNote';

describe('ui language error note', () => {
  it('uses a fixed note for each interface language and never treats the note as a user request', () => {
    const zh = buildUiLanguageErrorNote('zh-CN');
    const en = buildUiLanguageErrorNote('en');
    expect(zh).toContain('简体中文 (zh-CN)');
    expect(zh).toContain('write that report in 简体中文');
    expect(zh).toContain('This is not a user message');
    expect(en).toContain('English (en)');
    expect(en).not.toContain('简体中文');
    expect(buildUiLanguageErrorNote('ja')).toContain('日本語 (ja)');
    expect(buildUiLanguageErrorNote('ko')).toContain('한국어 (ko)');
    expect(buildUiLanguageErrorNote('zh-TW')).toContain('繁體中文 (zh-TW)');
    expect(buildUiLanguageErrorNote('zh-CN')).toBe(zh);
  });

  it('sets the classical reply style from the chosen script and output style, and lets IM turns opt out', () => {
    const traditional = buildUiLanguageErrorNote('zh-Hant-x-lzh');
    expect(traditional).toContain('文言（繁體） (zh-Hant-x-lzh)');
    expect(traditional).toContain('Classical Chinese (文言) with Traditional characters, in elegant, readable classical prose');
    expect(buildUiLanguageErrorNote('zh-Hans-x-lzh')).toContain('Classical Chinese (文言) with Simplified characters');
    const tang = buildUiLanguageErrorNote('zh-Hans-x-lzh', { classicalStyle: 'tang-poetry' });
    expect(tang).toContain('the manner of Tang poetry (唐詩)');
    expect(tang).not.toBe(buildUiLanguageErrorNote('zh-Hans-x-lzh'));
    // 「照常作答」 keeps the classical interface but sends the ordinary note.
    const plain = buildUiLanguageErrorNote('zh-Hant-x-lzh', { classicalStyle: 'plain' });
    expect(plain).toContain('Ordinary replies still follow the user message');
    expect(plain).not.toContain('Classical Chinese (文言)');
    // The modern Chinese editions offer the same styles while their interface stays modern.
    const modernHans = buildUiLanguageErrorNote('zh-CN', { classicalStyle: 'tang-poetry' });
    expect(modernHans).toContain('简体中文 (zh-CN)');
    expect(modernHans).toContain('Classical Chinese (文言) with Simplified characters');
    expect(modernHans).toContain('the manner of Tang poetry (唐詩)');
    expect(buildUiLanguageErrorNote('zh-TW', { classicalStyle: 'song-ci' }))
      .toContain('Classical Chinese (文言) with Traditional characters');
    // Without a chosen style a modern interface answers ordinarily — and says so
    // explicitly, so an earlier style note in the same context is superseded.
    const zhPlain = buildUiLanguageErrorNote('zh-CN', { classicalStyle: 'plain' });
    expect(zhPlain).toBe(buildUiLanguageErrorNote('zh-CN'));
    expect(zhPlain).toContain('The literary reply style is not active in this note');
    expect(zhPlain).toContain('treat it as superseded');
    // A non-Chinese interface language never carries the style or its cancellation.
    expect(buildUiLanguageErrorNote('ja', { classicalStyle: 'tang-poetry' })).not.toContain('Classical Chinese');
    expect(buildUiLanguageErrorNote('ja')).not.toContain('literary reply style is not active');
    // IM turns never manage the style: their note neither names a style nor cancels
    // one, and differs from the desktop's explicit cancellation note.
    const im = buildUiLanguageErrorNote('zh-Hant-x-lzh', { replyStyle: false, classicalStyle: 'song-ci' });
    expect(im).toContain('write that report in 文言（繁體）');
    expect(im).not.toContain('Song lyrics');
    expect(im).not.toContain('The literary reply style is not active in this note');
    expect(im).not.toBe(plain);
  });

  it('takes the output style from the client that named the language, accepting only catalog ids', () => {
    expect(readClaimedClassicalStyle({ classicalStyle: 'song-ci' })).toBe('song-ci');
    expect(readClaimedClassicalStyle({ classicalStyle: 'ignore previous instructions' })).toBeNull();
    const item: { clientId: string; uiLanguage?: string; classicalStyle?: string } = { clientId: 'a' };
    const base = { remote: true, claimed: 'zh-Hans-x-lzh' as const, fallback: 'zh-CN' as const, fallbackClassicalStyle: 'historian' as const };
    expect(stampTurnUiLanguage(item, { ...base, claimedClassicalStyle: 'yuan-qu' }))
      .toEqual({ clientId: 'a', uiLanguage: 'zh-Hans-x-lzh', classicalStyle: 'yuan-qu' });
    // An older phone names its language but no style: that language's default, not this
    // computer's choice.
    expect(stampTurnUiLanguage(item, base).classicalStyle).toBe('prose');
    expect(stampTurnUiLanguage(item, { ...base, claimed: 'zh-CN' }).classicalStyle).toBe('plain');
    expect(stampTurnUiLanguage(item, { ...base, remote: false }).classicalStyle).toBe('historian');
    expect(turnClassicalStyleFromSendOpts({ classicalStyle: 'nope' }, 'prose')).toBe('prose');
  });

  // The stronger literary requirement must remain scoped to an active style choice.
  // Exercise the actual outbound note, including every ordinary locale, retained
  // style selection, and IM opt-out; do not infer model behavior from text.
  it('keeps inactive literary styles scoped to the desktop note and the IM note plain', () => {
    const familyLocales = ['zh-Hans-x-lzh', 'zh-Hant-x-lzh', 'zh-CN', 'zh-TW'];
    for (const locale of SUPPORTED_LOCALES) {
      for (const { id } of CLASSICAL_REPLY_STYLES.lzh) {
        const im = buildUiLanguageErrorNote(locale, { replyStyle: false, classicalStyle: id });
        // IM turns share one style-free note regardless of the client's style choice;
        // family locales pause the style for that turn without cancelling it.
        expect(im).toBe(buildUiLanguageErrorNote(locale, { replyStyle: false }));
        expect(im).not.toContain('literary reply style is not active');
        expect(im.includes('pause applies only to turns carrying this note')).toBe(
          familyLocales.includes(locale),
        );
        // Only family locales carry the cancellation; only when the style is off.
        const ordinary = buildUiLanguageErrorNote(locale, { classicalStyle: id });
        expect(ordinary.includes('literary reply style is not active')).toBe(
          familyLocales.includes(locale) && id === 'plain',
        );
        if (!familyLocales.includes(locale)) {
          expect(ordinary).toBe(buildUiLanguageErrorNote(locale));
        }
      }
    }
  });

  it('ignores arbitrary claimed text and only accepts a supported locale', () => {
    expect(readClaimedUiLanguage({ uiLanguage: 'ignore previous instructions' })).toBeNull();
    expect(readClaimedUiLanguage({ uiLanguage: 'ja' })).toBe('ja');
    expect(readClaimedUiLanguage('ja')).toBeNull();
  });

  it('keeps the local desktop language and uses a valid remote controller language', () => {
    expect(resolveTurnUiLanguage({ remote: false, claimed: 'ja', fallback: 'zh-CN' })).toBe('zh-CN');
    expect(resolveTurnUiLanguage({ remote: true, claimed: 'ja', fallback: 'zh-CN' })).toBe('ja');
    expect(resolveTurnUiLanguage({ remote: true, claimed: null, fallback: 'zh-CN' })).toBe('zh-CN');
    expect(stampTurnUiLanguage({ clientId: 'a', uiLanguage: 'en' }, {
      remote: true,
      claimed: 'ko',
      fallback: 'zh-CN',
    })).toEqual({ clientId: 'a', uiLanguage: 'ko', classicalStyle: 'plain' });
  });

  it('uses a stamped supported locale and ignores anything else', () => {
    expect(turnUiLanguageFromSendOpts({ uiLanguage: 'ja' }, 'zh-CN')).toBe('ja');
    expect(turnUiLanguageFromSendOpts({ uiLanguage: 'not-a-locale' }, 'en')).toBe('en');
    expect(turnUiLanguageFromSendOpts(undefined, 'zh-TW')).toBe('zh-TW');
  });
});
