import { describe, expect, it } from 'vitest';
import { createInstance, type TFunction } from 'i18next';
import { TAB_IDS, TAB_LABEL_KEY } from '@/lib/tabLabels';
import zhCN from '../../../i18n/locales/zh-CN/common.json';
import en from '../../../i18n/locales/en/common.json';
import { SELECTABLE_WALLPAPER_IDS } from '../../../../shared/appearanceSettings';
import { AGENT_ISLAND_SOUND_EVENTS, AGENT_ISLAND_SOUND_OPTIONS } from '../../../../shared/agentIsland';


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

// Regression: visible settings were absent from the hand-maintained catalog; Chinese
// compound queries and common names also returned no results. Exercise the production
// search with real locales (unit tier), rather than checking source strings.

const searchI18n = createInstance();
await searchI18n.init({ lng: 'zh-CN', fallbackLng: 'en', resources: {
  'zh-CN': { translation: zhCN }, en: { translation: en },
} });
const searchContext = { platform: 'win32', region: 'cn', mode: 'cloud', membershipKind: 'personal',
  voiceInput: { serviceMode: 'byok', asrProvider: 'custom-realtime-asr' },
} as const;

describe('settings discoverability regressions', () => {
  it('finds the local API import entry by its titles and source app names before mounting settings', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    for (const query of [
      searchI18n.t('settings.providers.import.local.title'),
      searchI18n.t('settings.providers.import.local.title', { lng: 'en' }),
      'Alma', 'CC Switch', 'OpenCode',
    ]) {
      const result = searchSettings(documents, query).find(({ entry }) => entry.id === 'providers.localImport');
      expect(result?.entry, query).toMatchObject({ tab: 'providers', targetId: 'settings-provider-local-import' });
    }
  });
  // Unit regression (#8481): automatic mode renders no slot explanations.
  // Existing catalog tests did not query those hidden descriptions.
  it('does not advertise custom-only auxiliary slot explanations', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    for (const slot of ['preferred', 'fallback1', 'fallback2']) {
      const query = searchI18n.t('settings.auxiliaryModels.' + slot + '.description');
      expect(searchSettings(documents, query).map(({ entry }) => entry.id))
        .not.toContain('settings.auxiliaryModels.' + slot + '.label');
    }
  });
  // Unit regressions (#8481): generic titles did not cover visible storage
  // explanations or the speaker card's unsupported/enrolled branches.
  it('finds storage rows by their visible descriptions', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    for (const lng of ['zh-CN', 'en']) {
      for (const field of ['cleanup', 'reconcile', 'dbSlimming', 'dbSizeWarningThreshold', 'dbSizeWarningDisable']) {
        const query = searchI18n.t(`settings.about.storage.${field}Description`, { lng });
        expect(searchSettings(documents, query).some(({ entry }) => entry.id === `settings.about.storage.${field}Label`), query).toBe(true);
      }
    }
  });
  it.each([undefined, { supported: false, enrolled: false }, { supported: true, enrolled: false }, { supported: true, enrolled: true }])(
    'indexes only rendered speaker-filter text for %j', (speakerFilter) => {
      const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, speakerFilter });
      for (const lng of ['zh-CN', 'en']) {
        for (const [key, visible] of [
          ['hint', speakerFilter?.supported !== false],
          ['unsupported', speakerFilter?.supported === false],
          ...['strictness.label', 'strictness.hint', 'strictness.options.relaxed', 'strictness.options.standard', 'strictness.options.strict']
            .map((key) => [key, speakerFilter?.supported === true && speakerFilter.enrolled] as const),
        ] as const) {
          const query = searchI18n.t(`settings.voiceInput.speakerFilter.${key}`, { lng });
          expect(searchSettings(documents, query).some(({ entry }) => entry.id === 'settings.voiceInput.speakerFilter.label'), query).toBe(visible);
        }
      }
    },
  );
  // Unit regression (#8481): backend title coverage missed the visible selected
  // description. Query real translated explanations through the production index.
  it('finds browser settings by each backend description', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    for (const lng of ['zh-CN', 'en']) {
      for (const backend of ['rsbWebview', 'external', 'userBrowser']) {
        const query = searchI18n.t(`settings.computerUse.browserBackend.${backend}.description`, { lng });
        expect(searchSettings(documents, query).some(({ entry }) => entry.id === 'computerUse.browserTarget'), query).toBe(true);
      }
    }
    expect(searchSettings(documents, 'with your existing sign-ins').some(({ entry }) => entry.id === 'computerUse.browserTarget')).toBe(true);
  });
  // Unit regressions (#8481): prior coverage checked generic wallpaper/sound
  // titles, not visible picker names. Query real translations via production search.
  it('finds the wallpaper picker by each selectable wallpaper name', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    for (const lng of ['zh-CN', 'en']) {
      for (const id of SELECTABLE_WALLPAPER_IDS) {
        const query = searchI18n.t(`settings.appearance.wallpaper.options.${id}`, { lng });
        expect(searchSettings(documents, query).some(({ entry }) => entry.id === 'settings.appearance.wallpaper.title'), query).toBe(true);
      }
    }
  });
  it.each([
    { supported: false, enabled: true, soundEnabled: true },
    { supported: true, enabled: false, soundEnabled: true },
    { supported: true, enabled: true, soundEnabled: false },
    { supported: true, enabled: true, soundEnabled: true },
  ])('indexes sound row labels only when mounted: %j', (agentIsland) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform: 'darwin', agentIsland });
    const visible = agentIsland.supported && agentIsland.enabled && agentIsland.soundEnabled;
    for (const lng of ['zh-CN', 'en']) {
      for (const key of [
        ...AGENT_ISLAND_SOUND_EVENTS.map((event) => `soundEvents.${event}`),
        ...AGENT_ISLAND_SOUND_OPTIONS.map((option) => `soundOptions.${option}`),
      ]) {
        const query = searchI18n.t(`settings.agentIsland.${key}`, { lng });
        // The row's hint is indexed whenever the row exists and may contain a short label such as "Follow system".
        const inHint = agentIsland.supported && agentIsland.enabled && searchI18n.t('settings.agentIsland.soundHint', { lng }).toLowerCase().includes(query.toLowerCase());
        expect(searchSettings(documents, query).some(({ entry }) => entry.id === 'settings.agentIsland.soundLabel'), query).toBe(visible || inHint);
      }
    }
  });
  // Character and sounds also serve the Live Activity, so they stay findable when it is the
  // only surface on; display and subtle reminders belong to Agent Notch alone. Unit tier.
  it('keeps shared island settings searchable with only the Live Activity on', () => {
    const agentIsland = { supported: true, enabled: false, soundEnabled: true, liveActivitySupported: true, liveActivity: true };
    const ids = new Set(buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform: 'darwin', agentIsland })
      .map(({ entry }) => entry.id));
    expect(['settings.agentIsland.skinLabel', 'settings.agentIsland.soundLabel'].every((id) => ids.has(id))).toBe(true);
    expect(['settings.agentIsland.displayLabel', 'settings.agentIsland.subtleRemindersLabel'].some((id) => ids.has(id))).toBe(false);
  });
  // Unit regression (#8481): hidden motion selectors must not advertise options.
  it.each([false, true])('filters wallpaper motion labels with selector visible=%s', (wallpaperMotionAvailable) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, wallpaperMotionAvailable });
    for (const lng of ['zh-CN', 'en']) {
      for (const option of ['motionStatic', 'motionDynamic']) {
        const results = searchSettings(documents, searchI18n.t(`settings.appearance.wallpaper.${option}`, { lng }));
        // Dynamic also appears in the always-visible custom-wallpaper hint.
        expect(results.some(({ entry }) => entry.id === 'settings.appearance.wallpaper.customChoose')).toBe(option === 'motionDynamic' || wallpaperMotionAvailable);
      }
    }
    expect(documents.some(({ entry }) => entry.id === 'settings.appearance.wallpaper.customChoose')).toBe(true);
    // Unit regression (#8481): motion coverage missed the always-visible sliders.
    // Search their real labels/hints through the production index in both states.
    for (const lng of ['zh-CN', 'en']) {
      for (const key of ['visibilityLabel', 'visibilityHint', 'blurLabel', 'blurHint']) {
        const query = searchI18n.t(`settings.appearance.wallpaper.${key}`, { lng });
        const results = searchSettings(documents, query);
        expect(results.some(({ entry }) => entry.id === 'settings.appearance.wallpaper.customChoose'), query).toBe(true);
      }
    }
  });
  // Unit regression (#8481): script/style controls mount only for an explicitly
  // selected classical locale; ordinary and system preferences leave them absent.
  it.each(['en', 'zh-CN', 'system', 'zh-Hans-x-lzh', 'zh-Hant-x-lzh'])(
    'finds classical controls only when mounted for %s', (locale) => {
      const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, locale });
      expect(searchSettings(documents, '唐诗').some(({ entry }) => entry.id === 'general.classicalLanguage')).toBe(locale.endsWith('-x-lzh'));
      for (const lng of ['zh-CN', 'en']) {
        const matches = searchSettings(documents, searchI18n.t('settings.language.classical.label', { lng }));
        expect(matches.some(({ entry }) => entry.id === 'general.classicalLanguage')).toBe(locale.endsWith('-x-lzh'));
        const language = searchSettings(documents, searchI18n.t('settings.language.options.classical', { lng }));
        expect(language.some(({ entry }) => entry.id === 'general.displayLanguage')).toBe(true);
      }
    },
  );
  // Unit regression (#8561): the modern-Chinese reply-style row is searchable by
  // the style names it renders; classical and system/en locales keep it absent.
  it.each(['en', 'zh-CN', 'zh-TW', 'system', 'zh-Hans-x-lzh'])('finds the reply-style row only in modern Chinese locales for %s', (locale) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, locale });
    const visible = locale === 'zh-CN' || locale === 'zh-TW';
    expect(searchSettings(documents, '唐诗').some(({ entry }) => entry.id === 'general.replyStyle')).toBe(visible);
    for (const lng of ['zh-CN', 'en']) {
      const matches = searchSettings(documents, searchI18n.t('settings.language.classical.styleAriaLabel', { lng }));
      expect(matches.some(({ entry }) => entry.id === 'general.replyStyle')).toBe(visible);
    }
  });
  // Unit regression (#8481): disabled refinement leaves both child controls
  // unmounted. Query real translated labels instead of inspecting declarations.
  it.each([false, true])('filters refinement children with refinementEnabled=%s', (voiceRefinementEnabled) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, voiceRefinementEnabled });
    for (const lng of ['zh-CN', 'en']) {
      for (const field of ['instructions', 'dictionary']) {
        const id = `settings.voiceInput.refinement.${field}.label`;
        const matches = searchSettings(documents, searchI18n.t(id, { lng }));
        expect(matches.some(({ entry }) => entry.id === id)).toBe(voiceRefinementEnabled);
      }
    }
    expect(documents.some(({ entry }) => entry.id === 'settings.voiceInput.refinement.enabled.label')).toBe(true);
  });

  // Unit regression (#8481): an unloaded, managed, or non-custom ASR selection
  // exposed unmounted fields. Existing title tests only covered visible fields.
  it.each([
    ['cloud', undefined, false, false],
    ['cloud', { serviceMode: 'cindy', asrProvider: 'custom-realtime-asr' }, false, false],
    ['cloud', { serviceMode: 'byok', asrProvider: 'openai' }, true, false],
    ['cloud', { serviceMode: 'byok', asrProvider: 'custom-realtime-asr' }, true, true],
    ['local', { serviceMode: 'cindy', asrProvider: 'custom-realtime-asr' }, true, true],
    ['local', { serviceMode: 'cindy', asrProvider: 'openai' }, true, false],
  ] as const)('matches mounted ASR fields for %s / %j', (mode, voiceInput, byokVisible, customVisible) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, mode, voiceInput });
    for (const lng of ['zh-CN', 'en']) {
      for (const field of ['protocol', 'websocketUrl', 'model', 'apiKey']) {
        const query = searchI18n.t(`settings.voiceInput.serviceSource.customAsr.${field}.label`, { lng });
        const matches = searchSettings(documents, query);
        const id = `voiceInput.customAsr${field[0].toUpperCase()}${field.slice(1)}`;
        expect(matches.some(({ entry }) => entry.id === id)).toBe(customVisible);
      }
    }
    expect(documents.some(({ entry }) => entry.id === 'voiceInput.asr')).toBe(byokVisible);
    expect(documents.some(({ entry }) => entry.id === 'voiceInput.serviceSource')).toBe(true);
  });

  it.each([
    ['LSP', 'general.lsp'],
    ['Beta', 'general.betaChannel'],
    ['提问导航', 'personalization.messageNavRail'],
    ['语义索引', 'personalization.chatEmbedding'],
    ['静默重试', 'personalization.silentRetry'],
    ['我的浏览器', 'computerUse.browserTarget'],
    ['恢复默认布局', 'appearance.layout'],
    ['对话工作区', 'storage.dialogueDirectory'],
    ['供应商组', 'providers.sharing'],
    ['字体大小', 'settings.appearance.font.uiSize.label'],
    ['自动更新', 'settings.about.autoUpdateLabel'],
    ['开机启动', 'settings.windowBehavior.loginItem.label'],
    ['语音快捷键', 'settings.voiceInput.shortcut.label'],
    ['Ctrl+Enter', 'settings.composer.sendShortcut.label'],
    ['鸿蒙字体', 'settings.appearance.font.uiFamily.label'],
    ['全速', 'settings.agentResource.preset'],
    ['Qwen 实时 ASR', 'voiceInput.customAsrProtocol'],
    // Option descriptions must be searchable in the current locale and English.
    ['无需配置任何密钥', 'voiceInput.serviceSource'],
    ['ASR-capable service', 'voiceInput.serviceSource'],
    ['系统默认浏览器', 'settings.linkOpen.web.label'],
  ])('finds %s without opening the page first', (query, id) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, searchContext);
    expect(searchSettings(documents, query).map(({ entry }) => entry.id)).toContain(id);
  });

  // Unit regressions (PR #8481): visible Linux descriptions and close options
  // were missing from search. Existing title queries do not cover these texts.
  // Use real translations through production search and reject other-platform text.
  it.each(['linux', 'win32', 'darwin'])('indexes the visible platform descriptions on %s', (platform) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform });
    for (const [id, standardKey, linuxKey] of [
      ['settings.about.autoUpdateLabel', 'settings.about.autoUpdateDescription', 'settings.about.linuxUpdateDescription'],
      ['settings.voiceInput.shortcut.label', 'settings.voiceInput.shortcut.hint', 'settings.voiceInput.shortcut.linuxUnsupported'],
    ]) {
      for (const lng of ['zh-CN', 'en']) {
        const visibleKey = platform === 'linux' ? linuxKey : standardKey;
        const hiddenKey = platform === 'linux' ? standardKey : linuxKey;
        expect(searchSettings(documents, searchI18n.t(visibleKey, { lng })).map(({ entry }) => entry.id)).toContain(id);
        expect(searchSettings(documents, searchI18n.t(hiddenKey, { lng })).map(({ entry }) => entry.id)).not.toContain(id);
      }
    }
  });

  it.each(['linux', 'win32', 'darwin'])('finds only visible close-behavior choices on %s', (platform) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform });
    for (const lng of ['zh-CN', 'en']) {
      for (const [option, visibleOn] of [
        ['tray', ['win32']],
        ['minimize', ['linux']],
        ['quit', ['win32', 'linux']],
      ] as const) {
        const query = searchI18n.t(`settings.windowBehavior.closeBehavior.${option}`, { lng });
        const ids = searchSettings(documents, query).map(({ entry }) => entry.id);
        if ((visibleOn as readonly string[]).includes(platform)) expect(ids).toContain('settings.windowBehavior.closeBehavior.label');
        // On Windows, "Minimize window" also legitimately matches the row title
        // plus "Minimize to tray"; that overlapping query cannot prove invisibility.
        else if (platform !== 'win32') expect(ids).not.toContain('settings.windowBehavior.closeBehavior.label');
      }
    }
  });

  // Unit regression (PR #8481): generic setting queries miss the mascot choices
  // rendered by AgentIslandSection. Real translated names/descriptions must locate
  // the skin selector on macOS, and must not reveal a hidden settings tab.
  it.each([
    { supported: true, enabled: true },
    { supported: true, enabled: false },
    { supported: false, enabled: true },
    { supported: false, enabled: false },
  ])('finds mascot choices only when their controls are mounted: %j', (agentIsland) => {
    const context = { ...searchContext, platform: 'darwin', agentIsland };
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, context);
    const hiddenDocuments = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS.filter((tab) => tab !== 'agent-island'), context);
    for (const lng of ['zh-CN', 'en']) {
      for (const field of ['name', 'description']) {
        const query = searchI18n.t(`settings.agentIsland.skins.whitesnow.${field}`, { lng });
        const target = searchSettings(documents, query).find(({ entry }) => entry.id === 'settings.agentIsland.skinLabel')?.entry.targetId;
        expect(target).toBe(agentIsland.supported && agentIsland.enabled
          ? 'settings-search-settings-agentIsland-skinLabel' : undefined);
        expect(searchSettings(hiddenDocuments, query).map(({ entry }) => entry.id))
          .not.toContain('settings.agentIsland.skinLabel');
      }
    }
    for (const field of ['subtleRemindersLabel', 'displayLabel', 'soundLabel']) {
      expect(documents.some(({ entry }) => entry.id === `settings.agentIsland.${field}`))
        .toBe(agentIsland.supported && agentIsland.enabled);
    }
    expect(documents.some(({ entry }) => entry.id === 'settings.agentIsland.enableLabel')).toBe(agentIsland.supported);
  });

  // Unit regression (PR #8481): option descriptions previously ignored local mode.
  // Existing cloud queries do not cover hidden options; exercise production search
  // with local mode + "no keys to configure", using real locales and retaining BYOK.
  it('does not find cloud-only voice options in local mode', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, {
      ...searchContext, mode: 'local',
    });
    for (const lng of ['zh-CN', 'en']) {
      const hiddenQuery = searchI18n.t('settings.voiceInput.serviceSource.optionDescriptions.cindy', { lng });
      const visibleQuery = searchI18n.t('settings.voiceInput.serviceSource.optionDescriptions.byok', { lng });
      expect(searchSettings(documents, hiddenQuery).map(({ entry }) => entry.id))
        .not.toContain('voiceInput.serviceSource');
      expect(searchSettings(documents, visibleQuery).map(({ entry }) => entry.id))
        .toContain('voiceInput.serviceSource');
    }
  });

  // Unit regression (#8481): the local service hint was visible but unsearchable.
  // Option visibility coverage above does not exercise the row's description.
  it.each(['local', 'cloud'] as const)('indexes only the visible voice service hint in %s mode', (mode) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, mode });
    for (const lng of ['zh-CN', 'en']) {
      for (const hint of ['localHint', 'hint']) {
        const query = searchI18n.t(`settings.voiceInput.serviceSource.${hint}`, { lng });
        const result = searchSettings(documents, query).find(({ entry }) => entry.id === 'voiceInput.serviceSource');
        if ((hint === 'localHint') === (mode === 'local')) {
          expect(result?.entry.targetId).toBe('settings-voice-serviceSource');
        } else {
          expect(result).toBeUndefined();
        }
      }
    }
  });

  it('respects platform capabilities and requires every Chinese search word', () => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, {
      ...searchContext, mode: 'local', supportsBetaUpdateChannel: false,
    });
    expect(searchSettings(documents, 'Beta').map(({ entry }) => entry.id)).not.toContain('general.betaChannel');
    expect(searchSettings(documents, '语义索引')).toEqual([]);
    expect(searchSettings(documents, '语音 不存在的设置')).toEqual([]);
    expect(searchSettings(documents, '!!!')).toEqual([]);
  });

  // Unit regression: hidden shortcut rows never mount, so returning their labels
  // creates an unlocatable result. Exercise real translated queries on both platforms.
  it.each(['win32', 'darwin'])('only finds visible shortcut settings on %s', (platform) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform });
    const result = searchSettings(documents, '截图').find(({ entry }) => entry.id === 'shortcuts.region-screenshot');
    expect(result?.entry.targetId).toBe('settings-shortcut-region-screenshot');
    const hiddenQuery = searchI18n.t('settings.shortcuts.items.close-tab-or-window.label');
    expect(searchSettings(documents, hiddenQuery).map(({ entry }) => entry.id))
      .not.toContain('shortcuts.close-tab-or-window');
  });

  it.each([['win32', 'Ctrl+Enter'], ['darwin', '⌘+Enter']])('keeps the %s shortcut in the search result title', (platform, shortcut) => {
    const documents = buildSettingsSearchDocuments(searchI18n.t, TAB_IDS, { ...searchContext, platform });
    const result = searchSettings(documents, shortcut).find(({ entry }) => entry.id === 'settings.composer.sendShortcut.label');
    expect(result?.title).toBe(searchI18n.t('settings.composer.sendShortcut.label', { shortcut }));
  });
});

describe('settings search catalog', () => {
  // PR #9055 CI regression: discover the dynamic MCP notice even before a group is mounted.
  it('finds MCP duplicate choices and resolves their notice anchor', () => {
    const matches = searchSettings(buildSettingsSearchDocuments(t, ['builtin-tools']), 'MCP');
    expect(matches.some(match => match.entry.id === 'mcp.duplicates')).toBe(true);
    expect(resolveSettingsSearchTarget('builtin-tools', 'mcp.duplicates')).toBe('settings-mcp-duplicates');
  });
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
          ...(entry.options ?? []).map(({ labelKey }) => labelKey),
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
    expect(ids()).not.toContain('remoteControl.devices');
    expect(ids({ mode: 'cloud' })).toContain('remoteControl.devices');
    for (const region of ['cn', 'dev', 'global'] as const) {
      const visible = ids({ region, mode: 'cloud', membershipKind: 'personal' });
      expect(visible).toContain('imBot.cindy');
      expect(visible).toContain('imBot.cindy.telegram');
      expect(visible).toContain('imBot.cindy.x');
      expect(visible).toContain('imBot.cindy.feishu');
      expect(visible).toContain('imBot.discord');
      expect(visible).toContain('imBot.telegram');
      expect(visible).toContain('imBot.feishu');
      expect(visible).toContain('imBot.lark');
    }
    expect(ids()).not.toContain('imBot.cindy');
  });
});
