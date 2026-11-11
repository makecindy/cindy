import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const locales = ['zh-CN', 'zh-TW', 'en', 'ja', 'ko'] as const;
const read = (locale: string) => JSON.parse(readFileSync(new URL(`../../../i18n/locales/${locale}/common.json`, import.meta.url), 'utf8')) as {
  settings: { tabs: { remoteControl: string } };
  bots: { cloud: { hereControlOff: string } };
};

describe('bots.cloud.hereControlOff', () => {
  it.each(locales)('points at the settings page that holds the switch, by its real name (%s)', (locale) => {
    const { settings, bots } = read(locale);
    // "Allow same-account devices to control this machine" lives under Settings → Remote Connection (settings.tabs.remoteControl).
    expect(bots.cloud.hereControlOff).toContain(settings.tabs.remoteControl);
  });
});
