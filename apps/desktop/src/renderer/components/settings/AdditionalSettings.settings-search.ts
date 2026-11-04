import {
  defineSettings,
  type SettingsSearchContext,
  type SettingsSearchModule,
} from './settingsSearchTypes';

/** Small settings rows share these definitions with the static search catalog. */
export const additionalSettings = defineSettings({
  lsp: {
    id: 'general.lsp',
    tab: 'general',
    targetId: 'settings-lsp',
    titleKey: 'settings.lspMode.cell.title',
    descriptionKey: 'settings.lspMode.cell.description',
    sectionKey: 'settings.sections.experimental',
  },
  betaChannel: {
    id: 'general.betaChannel',
    tab: 'general',
    targetId: 'settings-beta-channel',
    titleKey: 'settings.betaChannel.title',
    descriptionKey: 'settings.betaChannel.description',
    sectionKey: 'settings.sections.experimental',
    aliases: ['测试版', '体验版', 'beta channel'],
    isVisible: ({
      platform,
      supportsBetaUpdateChannel,
    }: Pick<SettingsSearchContext, 'platform' | 'supportsBetaUpdateChannel'>) =>
      supportsBetaUpdateChannel ?? platform !== 'linux',
  },
  messageNavRail: {
    id: 'personalization.messageNavRail',
    tab: 'personalization',
    targetId: 'settings-message-nav-rail',
    titleKey: 'settings.messageNavRail.cell.label',
    descriptionKey: 'settings.messageNavRail.cell.description',
    sectionKey: 'settings.sections.compatMode',
    aliases: ['提问导航', '消息导航'],
  },
  chatEmbedding: {
    id: 'personalization.chatEmbedding',
    tab: 'personalization',
    targetId: 'settings-chat-embedding',
    titleKey: 'settings.chatEmbedding.cell.label',
    descriptionKey: 'settings.chatEmbedding.cell.description',
    sectionKey: 'settings.sections.compatMode',
    isVisible: ({ mode }: Pick<SettingsSearchContext, 'mode'>) => mode !== 'local',
  },
  silentRetry: {
    id: 'personalization.silentRetry',
    tab: 'personalization',
    targetId: 'settings-silent-retry',
    titleKey: 'settings.silentEncryptedRetry.cell.label',
    descriptionKey: 'settings.silentEncryptedRetry.cell.description',
    sectionKey: 'settings.sections.compatMode',
    aliases: ['静默重试', 'invalid_encrypted_content'],
  },
  browserTarget: {
    id: 'computerUse.browserTarget',
    tab: 'computer-use',
    targetId: 'settings-browser-target',
    fallbackTargetId: 'settings-search-settings-computerUse-browser-title',
    titleKey: 'settings.computerUse.browserBackend.title',
    sectionKey: 'settings.computerUse.browser.title',
    options: [
      {
        value: 'rsb-webview',
        labelKey: 'settings.computerUse.browserBackend.rsbWebview.title',
        descriptionKey: 'settings.computerUse.browserBackend.rsbWebview.description',
      },
      {
        value: 'external',
        labelKey: 'settings.computerUse.browserBackend.external.title',
        descriptionKey: 'settings.computerUse.browserBackend.external.description',
      },
      {
        value: 'user-browser',
        labelKey: 'settings.computerUse.browserBackend.userBrowser.title',
        descriptionKey: 'settings.computerUse.browserBackend.userBrowser.description',
      },
    ],
  },
  layout: {
    id: 'appearance.layout',
    tab: 'appearance',
    targetId: 'settings-layout-reset',
    titleKey: 'settings.appearance.layout.label',
    descriptionKey: 'settings.appearance.layout.hint',
    sectionKey: 'settings.appearance.sidebarAndPanels',
    keywordKeys: ['settings.appearance.layout.reset'],
    aliases: ['重置布局', 'reset layout'],
  },
  dialogueDirectory: {
    id: 'storage.dialogueDirectory',
    tab: 'storage',
    targetId: 'settings-dialogue-directory',
    fallbackTargetId: 'settings-panel-storage',
    titleKey: 'settings.about.storage.dialogueDirectoryTitle',
    descriptionKey: 'settings.about.storage.dialogueDirectoryDescription',
    sectionKey: 'settings.tabs.storage',
    aliases: ['工作目录', 'working directory'],
  },
  botModel: {
    id: 'general.botModel',
    tab: 'general',
    targetId: 'settings-bot-model',
    titleKey: 'bots.globalSettings.defaultModel',
    descriptionKey: 'bots.globalSettings.defaultModelHint',
    sectionKey: 'settings.sections.bots',
    aliases: ['伙伴默认模型', 'teammate default model'],
  },
  botReplyTarget: {
    id: 'general.botReplyTarget',
    tab: 'general',
    targetId: 'settings-bot-reply-target',
    titleKey: 'bots.globalSettings.showReplyTarget',
    descriptionKey: 'bots.globalSettings.showReplyTargetHint',
    sectionKey: 'settings.sections.bots',
  },
});

export default {
  id: 'additional-settings',
  order: 32,
  entries: Object.values(additionalSettings),
} satisfies SettingsSearchModule;
