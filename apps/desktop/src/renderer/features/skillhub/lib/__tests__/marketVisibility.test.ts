import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';

import { marketVisibilityLabelKey, marketVisibilitySubtitleKey } from '../marketVisibility';

const SKILLHUB_LOCALES = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;

describe('marketVisibilityLabelKey', () => {
  it('does not expose legacy XD branding in SkillHub copy', () => {
    for (const locale of SKILLHUB_LOCALES) {
      const common = JSON.parse(readFileSync(
        new URL(`../../../../i18n/locales/${locale}/common.json`, import.meta.url),
        'utf8',
      )) as { skillhub: unknown };
      expect(JSON.stringify(common.skillhub)).not.toMatch(/XD\.Inc/i);
    }
  });

  it('keeps existing public and department labels', () => {
    expect(marketVisibilityLabelKey({
      visibility: 'PUBLIC',
      publishedVisibility: 'public',
    })).toBe('skillhub.marketCard.visibilityPublic');

    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'shared',
    })).toBe('skillhub.marketCard.visibilityDept');
  });

  it('only shows the private label in My Published cloud-management context', () => {
    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketCard.visibilityPrivate');

    expect(marketVisibilityLabelKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
    })).toBe('skillhub.marketCard.visibilityDept');
  });

  it('does not duplicate visible wording in the cloud detail subtitle', () => {
    expect(marketVisibilitySubtitleKey({
      visibility: 'PUBLIC',
      publishedVisibility: 'public',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityPublic');

    expect(marketVisibilitySubtitleKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'shared',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityDept');

    expect(marketVisibilitySubtitleKey({
      visibility: 'DEPARTMENT_SCOPED',
      publishedVisibility: 'private',
      allowPrivateLabel: true,
    })).toBe('skillhub.marketDetail.visibilityPrivate');
  });
});
