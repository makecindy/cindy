import { afterEach, describe, expect, it } from 'vitest';

import i18n, { DEFAULT_LOCALE, SUPPORTED_LOCALES } from '../index';

afterEach(async () => {
  await i18n.changeLanguage(DEFAULT_LOCALE);
});

describe('dev OAuth write recovery guidance', () => {
  it.each(SUPPORTED_LOCALES)('%s only points to the trusted isolated-auth command', async (locale) => {
    await i18n.changeLanguage(locale);
    const message = i18n.t('chatgptAuthRecovery.devWriteBlocked');

    expect(message).toContain('pnpm restart:desktop:remote -- --isolated-auth --isolated');
    expect(message).not.toContain('--isolated[');
    expect(message).not.toContain('XDT_ALLOW_DEV_OAUTH_WRITE');
  });
});
