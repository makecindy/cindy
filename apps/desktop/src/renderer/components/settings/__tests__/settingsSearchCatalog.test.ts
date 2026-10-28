import { describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import { TAB_IDS, TAB_LABEL_KEY } from '@/lib/tabLabels';

import {
  buildSettingsSearchDocuments,
  isLegacyAppearanceDeepLink,
  normalizeSettingsSearchText,
  resolveSettingsSearchTarget,
  searchSettings,
  validateSettingsSearchCatalog,
  SETTINGS_SEARCH_ENTRIES,
  SETTINGS_SEARCH_MODULES,
} from '../settingsSearchCatalog';

const translations: Record<string, string> = {
  'settings.sections.appearance': 'Appearance',
  'settings.sections.language': 'Language',
  'settings.sections.user': 'User',
  'settings.tabs.general': 'General',
  'settings.tabs.appearance': 'Appearance',
  'settings.tabs.personalization': 'Personalization',
  'settings.wechatBot.title': '个人微信',
  'settings.wecomBot.title': '企业微信智能机器人',
  'settings.dingtalkBot.title': '钉钉机器人',
  'settings.imBot.groups.personal': '个人',
};

const t = ((key: string) => translations[key] ?? key) as unknown as TFunction;

describe('settings search catalog', () => {
  it('normalizes mixed-width and repeated whitespace', () => {
    expect(normalizeSettingsSearchText('  Ａppearance\u00a0  ')).toBe('appearance');
  });

  it('filters documents to the visible settings tabs', () => {
    const documents = buildSettingsSearchDocuments(t, ['general']);

    expect(documents.every(({ entry }) => entry.tab === 'general')).toBe(true);
    expect(documents.map(({ entry }) => entry.id)).toContain('general.language');
    expect(documents.map(({ entry }) => entry.id)).not.toContain('appearance');
    expect(documents.map(({ entry }) => entry.id)).not.toContain('personalization.memory');
  });

  it('ranks exact section matches before broader category matches', () => {
    const documents = buildSettingsSearchDocuments(t, ['general', 'appearance']);
    const matches = searchSettings(documents, 'appearance');

    expect(matches[0]?.entry.id).toBe('appearance');
  });

  it('routes legacy appearance deep links to the Appearance tab', () => {
    expect(isLegacyAppearanceDeepLink(null, 'appearance')).toBe(true);
    expect(isLegacyAppearanceDeepLink('general', 'general.appearance')).toBe(true);
    expect(isLegacyAppearanceDeepLink(null, 'settings.appearance.modeLabel')).toBe(true);
    expect(isLegacyAppearanceDeepLink('personalization', 'streamFade')).toBe(true);
    expect(isLegacyAppearanceDeepLink('personalization', 'personalization.streamFade')).toBe(true);
    expect(resolveSettingsSearchTarget('appearance', 'streamFade')).toBe(
      'settings-search-target-appearance-stream-fade',
    );
  });

  it('resolves legacy concrete anchor ids to the Appearance tab', () => {
    expect(isLegacyAppearanceDeepLink(null, 'settings-search-target-general-appearance')).toBe(true);
    expect(
      isLegacyAppearanceDeepLink('personalization', 'settings-search-target-personalization-stream-fade'),
    ).toBe(true);
    expect(resolveSettingsSearchTarget('appearance', 'settings-search-target-general-appearance')).toBe(
      'settings-panel-appearance',
    );
    expect(
      resolveSettingsSearchTarget('appearance', 'settings-search-target-personalization-stream-fade'),
    ).toBe('settings-search-target-appearance-stream-fade');
  });

  it('keeps sections that still live on General or Personalization in place', () => {
    expect(isLegacyAppearanceDeepLink(null, 'notifications')).toBe(false);
    expect(isLegacyAppearanceDeepLink('personalization', 'memory')).toBe(false);
    expect(isLegacyAppearanceDeepLink(null, null)).toBe(false);
    expect(isLegacyAppearanceDeepLink('remote-control', 'appearance')).toBe(false);
  });

  it('returns no results for an empty or unknown query', () => {
    const documents = buildSettingsSearchDocuments(t, ['general']);

    expect(searchSettings(documents, '   ')).toEqual([]);
    expect(searchSettings(documents, 'does-not-exist')).toEqual([]);
  });

  it('resolves both short and catalog section deep links', () => {
    expect(resolveSettingsSearchTarget('general', 'notifications')).toBe('settings-notifications');
    expect(resolveSettingsSearchTarget('general', 'collaboration')).toBe('settings-collaboration');
    expect(resolveSettingsSearchTarget('general', 'general.language')).toBe(
      'settings-search-target-general-language',
    );
    expect(resolveSettingsSearchTarget('general', 'missing')).toBeNull();
  });

  it('resolves declared aliases in deep links', () => {
    expect(resolveSettingsSearchTarget('im-bot', 'Slack')).toBe('cindy-im-slack');
  });

  it('indexes always-visible personal IM channels', () => {
    const documents = buildSettingsSearchDocuments(t, ['im-bot']);

    expect(searchSettings(documents, '个人微信').map(({ entry }) => entry.id)).toContain(
      'imBot.wechat',
    );
    expect(searchSettings(documents, 'Lark')[0]?.entry.id).toBe('imBot.lark');
  });

  it('finds common aliases and multi-word queries', () => {
    const documents = buildSettingsSearchDocuments(t, ['remote-control']);
    expect(searchSettings(documents, 'SSH 主机')[0]?.entry.id).toBe('remoteControl.ssh');
    expect(searchSettings(documents, 'remote host')[0]?.entry.id).toBe('remoteControl.ssh');
  });

  it('keeps the declaration catalog complete and unique', () => {
    expect(validateSettingsSearchCatalog()).toEqual([]);
    expect(new Set(SETTINGS_SEARCH_MODULES.map(({ id }) => id)).size).toBe(
      SETTINGS_SEARCH_MODULES.length,
    );
    for (const tab of TAB_IDS) {
      expect(
        SETTINGS_SEARCH_ENTRIES.some(
          (entry) => entry.tab === tab && entry.titleKey === TAB_LABEL_KEY[tab],
        ),
        tab,
      ).toBe(true);
    }
  });

  it('uses real translated text in every supported language', async () => {
    const locales = import.meta.glob<Record<string, unknown>>(
      '../../../i18n/locales/*/common.json',
      { eager: true, import: 'default' },
    );
    for (const [path, translation] of Object.entries(locales)) {
      const language = path.split('/').at(-2)!;
      const instance = createInstance();
      await instance.init({
        lng: language,
        resources: { [language]: { translation } },
        fallbackLng: false,
      });
      for (const entry of SETTINGS_SEARCH_ENTRIES) {
        for (const key of [
          entry.titleKey,
          entry.sectionKey,
          entry.descriptionKey,
          ...(entry.keywordKeys ?? []),
        ].filter((key): key is string => Boolean(key))) {
          expect(
            instance.exists(key) && typeof instance.t(key) === 'string',
            language + ': ' + key,
          ).toBe(true);
        }
      }
      const documents = buildSettingsSearchDocuments(instance.t, TAB_IDS, {
        platform: 'win32',
        region: 'global',
        mode: 'cloud',
        membershipKind: 'personal',
      });
      for (const document of documents) {
        expect(
          searchSettings(documents, document.title).some(
            ({ entry }) => entry.id === document.entry.id,
          ),
          language + ': ' + document.entry.id,
        ).toBe(true);
      }
    }
  });

  it('points to existing anchors and covers every search anchor', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', {
      query: '?raw',
      eager: true,
      import: 'default',
    });
    const source = Object.entries(sources)
      .filter(([path]) => !path.includes('__tests__') && !path.endsWith('/SettingsSearchBox.tsx'))
      .map(([, text]) => text)
      .join();
    const targets = new Set(
      SETTINGS_SEARCH_ENTRIES.flatMap((entry) => [entry.targetId, entry.fallbackTargetId]),
    );
    for (const target of targets) {
      // The shared WeChat component selects its anchor at runtime. Its catalog target
      // and companion isolation are checked against real DOM in WechatBotSection.test.tsx.
      if (target === 'personal-im-wechat') continue;
      if (target) {
        const dynamicProviderAnchor =
          /^cindy-im-(slack|telegram|x)$/.test(target) &&
          source.includes('id={\`cindy-im-\${provider}\`}');
        expect(source.includes('id="' + target + '"') || dynamicProviderAnchor, target).toBe(true);
      }
    }
    for (const [, target] of source.matchAll(/id="(settings-search-[^"]+)"/g)) {
      expect(targets.has(target), target).toBe(true);
    }
  });

  it('uses the same account and platform visibility as settings', () => {
    const context = {
      platform: 'linux',
      region: 'cn',
      mode: 'local',
      membershipKind: null,
    } as const;
    const ids = (override = {}) =>
      buildSettingsSearchDocuments(t, TAB_IDS, { ...context, ...override }).map(
        ({ entry }) => entry.id,
      );
    expect(ids()).not.toContain('hud.settings');
    expect(ids({ platform: 'win32' })).not.toContain('hud.settings');
    expect(ids({ platform: 'darwin' })).toContain('hud.settings');
    expect(ids()).not.toContain('remoteControl.devices');
    expect(ids({ mode: 'cloud' })).toContain('remoteControl.devices');
    for (const region of ['cn', 'dev', 'global'] as const) {
      const visible = ids({ region, mode: 'cloud', membershipKind: 'personal' });
      expect(visible).toContain('imBot.cindy');
      expect(visible).toContain('imBot.cindy.telegram');
      expect(visible).toContain('imBot.cindy.x');
      expect(visible).toContain('imBot.discord');
      expect(visible).toContain('imBot.telegram');
      expect(visible).toContain('imBot.feishu');
      expect(visible).toContain('imBot.lark');
    }
    expect(ids()).not.toContain('imBot.cindy');
  });
});
