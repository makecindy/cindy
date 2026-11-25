import { describe, expect, it } from 'vitest';

import { createMainI18n } from '../i18n';
import { SUPPORTED_LOCALES } from '../../shared/locale';
import enCommon from '../../renderer/i18n/locales/en/common.json';
import enCloud from '../../renderer/i18n/locales/en/cloud.json';
import zhCNCloud from '../../renderer/i18n/locales/zh-CN/cloud.json';

// Native surfaces (the cloud sign-in window's title) read cloud copy in the main process.
describe('main-process cloud strings', () => {
  const i18n = createMainI18n(() => ['en']);
  const key = 'cloudSettings.onboarding.initialize';

  it('resolves cloud.json keys in every language instead of returning the key', () => {
    expect(i18n.t(key, 'zh-CN')).toBe(zhCNCloud.cloudSettings.onboarding.initialize);
    expect(i18n.t(key, 'en')).toBe(enCloud.cloudSettings.onboarding.initialize);
    for (const locale of SUPPORTED_LOCALES) expect(i18n.t(key, locale)).not.toBe(key);
  });

  it('leaves existing common keys as they were', () => {
    expect(i18n.t('settings.ghosts.remote.managingTarget', 'en')).toBe(
      enCommon.settings.ghosts.remote.managingTarget,
    );
  });
});
