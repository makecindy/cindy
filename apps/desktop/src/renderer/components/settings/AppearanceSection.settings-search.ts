import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { SELECTABLE_WALLPAPER_IDS } from '../../../shared/appearanceSettings';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Search entries owned by the Appearance tab (AppearanceSection + StreamFadeSection). */
export const UI_FONT_PRESETS = [
  {
    id: 'default',
    labelKey: 'settings.appearance.font.presetsUi.default',
    family: '',
  },
  {
    id: 'codexStyle',
    labelKey: 'settings.appearance.font.presetsUi.codexStyle',
    family: '-apple-system, BlinkMacSystemFont, "Segoe UI"',
  },
  {
    id: 'harmonyOS',
    labelKey: 'settings.appearance.font.presetsUi.harmonyOS',
    family: '"HarmonyOS Sans SC"',
  },
];
export const CODE_FONT_PRESETS = [
  {
    id: 'default',
    labelKey: 'settings.appearance.font.presetsCode.default',
    family: '',
  },
  {
    id: 'jetbrainsMono',
    labelKey: 'settings.appearance.font.presetsCode.jetbrainsMono',
    family: '"JetBrains Mono Variable", "JetBrains Mono"',
  },
];
export const TERMINAL_FONT_PRESETS = [
  {
    id: 'default',
    labelKey: 'settings.appearance.font.presetsTerminal.default',
    family: '',
  },
  {
    id: 'jetbrainsMono',
    labelKey: 'settings.appearance.font.presetsCode.jetbrainsMono',
    family: '"JetBrains Mono Variable", "JetBrains Mono"',
  },
];

export const appearanceSettings = defineSettings({
  appearance: {
    id: 'appearance',
    tab: 'appearance',
    targetId: 'settings-panel-appearance',
    titleKey: TAB_LABEL_KEY['appearance'],
    sectionKey: 'settings.tabs.appearance',
    aliases: ['general.appearance', 'settings-search-target-general-appearance'],
  },
  fonts: {
    id: 'appearance.fonts',
    tab: 'appearance',
    targetId: 'settings-search-target-appearance-fonts',
    titleKey: 'settings.appearance.font.title',
    sectionKey: 'settings.appearance.font.title',
  },
  sidebar: {
    id: 'appearance.sidebar',
    tab: 'appearance',
    targetId: 'settings-search-target-appearance-sidebar',
    titleKey: 'settings.appearance.sidebarAndPanels',
    sectionKey: 'settings.appearance.sidebarAndPanels',
  },
  wallpaperCustomChoose: {
    id: 'settings.appearance.wallpaper.customChoose',
    fallbackTargetId: 'settings-search-target-appearance-wallpaper',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-wallpaper',
    titleKey: 'settings.appearance.wallpaper.options.custom',
    sectionKey: 'settings.appearance.wallpaper.title',
    descriptionKey: 'settings.appearance.wallpaper.customHint',
    keywordKeys: [
      'settings.appearance.wallpaper.visibilityLabel',
      'settings.appearance.wallpaper.visibilityHint',
      'settings.appearance.wallpaper.blurLabel',
      'settings.appearance.wallpaper.blurHint',
    ],
    options: [
      { value: 'static', labelKey: 'settings.appearance.wallpaper.motionStatic', isVisible: ({ wallpaperMotionAvailable }) => wallpaperMotionAvailable === true },
      { value: 'dynamic', labelKey: 'settings.appearance.wallpaper.motionDynamic', isVisible: ({ wallpaperMotionAvailable }) => wallpaperMotionAvailable === true },
    ],
  },
  modeLabel: {
    id: 'settings.appearance.modeLabel',
    fallbackTargetId: 'settings-search-target-appearance-theme',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-modeLabel',
    titleKey: 'settings.appearance.modeLabel',
    sectionKey: 'settings.appearance.themeLabel',
    options: [
      { value: 'light', labelKey: 'settings.appearance.theme.light' },
      { value: 'dark', labelKey: 'settings.appearance.theme.dark' },
      { value: 'system', labelKey: 'settings.appearance.theme.system' },
    ],
  },
  themeLabel: {
    id: 'settings.appearance.themeLabel',
    fallbackTargetId: 'settings-search-target-appearance-theme',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-themeLabel',
    titleKey: 'settings.appearance.themeLabel',
    sectionKey: 'settings.appearance.themeLabel',
  },
  wallpaperTitle: {
    id: 'settings.appearance.wallpaper.title',
    fallbackTargetId: 'settings-search-target-appearance-wallpaper',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-wallpaper',
    titleKey: 'settings.appearance.wallpaper.title',
    aliases: ['背景', '背景图', '背景图片', 'background'],
    sectionKey: 'settings.appearance.wallpaper.title',
    descriptionKey: 'settings.appearance.wallpaper.description',
    options: SELECTABLE_WALLPAPER_IDS.map((id) => ({
      value: id,
      labelKey: `settings.appearance.wallpaper.options.${id}`,
    })),
  },
  localThemesTitle: {
    id: 'settings.appearance.localThemes.title',
    fallbackTargetId: 'settings-search-target-appearance-theme',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-localThemes-title',
    titleKey: 'settings.appearance.localThemes.title',
    sectionKey: 'settings.appearance.themeLabel',
  },
  fontUiFamilyLabel: {
    id: 'settings.appearance.font.uiFamily.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-uiFamily-label',
    titleKey: 'settings.appearance.font.uiFamily.label',
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.uiFamily.description',
    options: UI_FONT_PRESETS.map(({ id, labelKey }) => ({ value: id, labelKey })),
  },
  fontUiSizeLabel: {
    id: 'settings.appearance.font.uiSize.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-uiSize-label',
    titleKey: 'settings.appearance.font.uiSize.label',
    aliases: ['字体大小', '文字大小'],
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.uiSize.description',
  },
  fontCodeFamilyLabel: {
    id: 'settings.appearance.font.codeFamily.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-codeFamily-label',
    titleKey: 'settings.appearance.font.codeFamily.label',
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.codeFamily.description',
    options: CODE_FONT_PRESETS.map(({ id, labelKey }) => ({ value: id, labelKey })),
  },
  fontCodeSizeLabel: {
    id: 'settings.appearance.font.codeSize.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-codeSize-label',
    titleKey: 'settings.appearance.font.codeSize.label',
    aliases: ['代码字体大小'],
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.codeSize.description',
  },
  fontTerminalFamilyLabel: {
    id: 'settings.appearance.font.terminalFamily.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-terminalFamily-label',
    titleKey: 'settings.appearance.font.terminalFamily.label',
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.terminalFamily.description',
    options: TERMINAL_FONT_PRESETS.map(({ id, labelKey }) => ({ value: id, labelKey })),
  },
  fontTerminalSizeLabel: {
    id: 'settings.appearance.font.terminalSize.label',
    fallbackTargetId: 'settings-search-target-appearance-fonts',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-font-terminalSize-label',
    titleKey: 'settings.appearance.font.terminalSize.label',
    aliases: ['终端字体大小'],
    sectionKey: 'settings.appearance.font.title',
    descriptionKey: 'settings.appearance.font.terminalSize.description',
  },
  sidebarCardModeLabel: {
    id: 'settings.appearance.sidebarCardMode.label',
    fallbackTargetId: 'settings-search-target-appearance-sidebar',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-sidebarCardMode-label',
    titleKey: 'settings.appearance.sidebarCardMode.label',
    sectionKey: 'settings.appearance.sidebarAndPanels',
    descriptionKey: 'settings.appearance.sidebarCardMode.hint',
    options: [
      { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList' },
      { value: 'card', labelKey: 'ccAgent.sidebar.viewStyleCard' },
      { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide' },
    ],
  },
  sidebarMainListModeLabel: {
    id: 'settings.appearance.sidebarMainListMode.label',
    fallbackTargetId: 'settings-search-target-appearance-sidebar',
    tab: 'appearance',
    targetId: 'settings-search-settings-appearance-sidebarMainListMode-label',
    titleKey: 'settings.appearance.sidebarMainListMode.label',
    sectionKey: 'settings.appearance.sidebarAndPanels',
    descriptionKey: 'settings.appearance.sidebarMainListMode.hint',
    options: [
      { value: 'text', labelKey: 'ccAgent.sidebar.viewStyleList' },
      { value: 'list', labelKey: 'ccAgent.sidebar.viewStyleListWide' },
    ],
  },
  streamFade: {
    id: 'appearance.streamFade',
    tab: 'appearance',
    targetId: 'settings-search-target-appearance-stream-fade',
    titleKey: 'settings.sections.streamFade',
    sectionKey: 'settings.sections.streamFade',
    aliases: ['personalization.streamFade', 'settings-search-target-personalization-stream-fade'],
  },
  streamFadeLabel: {
    id: 'settings.streamFade.label',
    fallbackTargetId: 'settings-search-target-appearance-stream-fade',
    tab: 'appearance',
    targetId: 'settings-search-target-appearance-stream-fade',
    titleKey: 'settings.streamFade.label',
    sectionKey: 'settings.sections.streamFade',
    aliases: ['fade in', '流式淡入'],
    descriptionKey: 'settings.streamFade.hint',
  },
});

export default {
  id: 'AppearanceSection',
  order: 30,
  entries: Object.values(appearanceSettings),
} satisfies SettingsSearchModule;
