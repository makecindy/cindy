import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  caseStandardFor,
  findCaseMismatch,
  occursIn,
  sourceMentions,
  stripNonProse,
  findHalfWidthPunct,
  hasAsciiEllipsis,
  normalizeForPunctuation,
  HALFWIDTH_PUNCT_LOCALES,
  ELLIPSIS_LOCALES,
} from '../../../scripts/shared/glossary-rules.mjs';

// Native NSIS dialogs cannot load i18next. Check their separate catalog using
// the same glossary rules as the client instead of leaving it outside the gate.
const source = readFileSync(
  new URL('../resources/installer-directory-messages.nsh', import.meta.url),
  'utf8',
);
const glossary = JSON.parse(
  readFileSync(new URL('../../../i18n/glossary.json', import.meta.url), 'utf8'),
);
const locales = { en: 'en', zh_CN: 'zh-CN', zh_TW: 'zh-TW', ja: 'ja', ko: 'ko' };
const entries = [...source.matchAll(/^!define (\w+)_(en|zh_CN|zh_TW|ja|ko) "([^"]+)"$/gm)].map(
  ([, key, language, value]) => ({ key, locale: locales[language], value }),
);
const english = new Map(
  entries.filter((entry) => entry.locale === 'en').map((entry) => [entry.key, entry.value]),
);

describe('Windows installer directory messages', () => {
  it('provides every message in all five client languages', () => {
    expect(english.size).toBeGreaterThan(0);
    for (const key of english.keys()) {
      expect(
        entries
          .filter((entry) => entry.key === key)
          .map((entry) => entry.locale)
          .sort(),
      ).toEqual([...glossary.locales].sort());
    }
    expect(entries.length).toBe(english.size * glossary.locales.length);
  });

  it('uses the decided glossary and locale punctuation', () => {
    const violations = [];
    for (const { key, locale, value } of entries) {
      const prose = stripNonProse(value);
      for (const term of glossary.terms.filter((term) => term.status === 'decided')) {
        for (const forbidden of term.forbidden?.[locale] ?? []) {
          const bad = typeof forbidden === 'string' ? forbidden : forbidden.text;
          if (typeof forbidden !== 'string' && !sourceMentions(english.get(key), forbidden.whenEn))
            continue;
          if (occursIn(prose, bad)) violations.push(`${locale} ${key}: ${bad}`);
        }
        const standard = caseStandardFor(term, locale);
        if (standard && findCaseMismatch(prose, standard))
          violations.push(`${locale} ${key}: ${standard}`);
      }
      const punctuation = normalizeForPunctuation(value);
      if (HALFWIDTH_PUNCT_LOCALES.has(locale) && findHalfWidthPunct(punctuation))
        violations.push(`${locale} ${key}: punctuation`);
      if (ELLIPSIS_LOCALES.has(locale) && hasAsciiEllipsis(punctuation))
        violations.push(`${locale} ${key}: ellipsis`);
    }
    expect(violations).toEqual([]);
  });
});
