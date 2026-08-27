import { describe, expect, it } from 'vitest';

import { i18n } from '@/i18n';

describe('scheduler session title template i18n rendering', () => {
  it('renders literal token braces through real i18next interpolation in all five locales', async () => {
    const previousLanguage = i18n.language;
    try {
      for (const locale of ['zh-CN', 'zh-TW', 'en', 'ja', 'ko']) {
        await i18n.changeLanguage(locale);
        const unknown = i18n.t('scheduler.editor.validation.sessionTitleTemplate.unknownToken', {
          token: '{notAllowed}',
        });
        expect(unknown).toContain('{notAllowed}');
        expect(unknown).not.toContain('{{token}}');
        expect(unknown).not.toContain('\u200b');

        const preview = i18n.t('scheduler.editor.sessionTitleTemplate.preview', {
          title: '{literal} report',
        });
        expect(preview).toContain('{literal} report');
      }
    } finally {
      await i18n.changeLanguage(previousLanguage);
    }
  });
});
