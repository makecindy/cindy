import { TAB_LABEL_KEY } from '@/lib/tabLabels';
import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const providersSettings = defineSettings({
  subscriptionAccounts: {
    id: 'providers.subscriptionAccounts',
    tab: 'providers',
    targetId: 'settings-provider-subscription-accounts',
    fallbackTargetId: 'settings-panel-providers',
    titleKey: 'subscriptionAccounts.title',
    sectionKey: 'settings.tabs.providers',
    keywordKeys: ['subscriptionAccounts.add', 'subscriptionAccounts.strategy'],
    aliases: [
      '多账号',
      '订阅账号',
      '并发上限',
      '权重',
      '暂停分配',
      'Claude Code',
      'ChatGPT',
      'Codex',
      'multiple accounts',
      'load balancing',
      'concurrency',
      'weight',
    ],
  },
  modelPricing: {
    id: 'providers.modelPricing',
    tab: 'providers',
    targetId: 'settings-model-pricing',
    fallbackTargetId: 'settings-panel-providers',
    titleKey: 'settings.providers.models.advanced.pricing',
    descriptionKey: 'settings.providers.models.priceOverride.description',
    sectionKey: 'settings.tabs.providers',
    keywordKeys: [
      'settings.providers.models.priceOverride.input',
      'settings.providers.models.priceOverride.output',
      'settings.providers.models.priceOverride.cacheRead',
      'settings.providers.models.priceOverride.cacheWrite',
      'settings.providers.models.priceOverride.currency',
      'settings.providers.models.priceOverride.resetShort',
      'settings.providers.models.priceOverride.referenceDetails',
    ],
  },
  sharing: {
    id: 'providers.sharing',
    tab: 'providers',
    targetId: 'settings-provider-remote-access',
    fallbackTargetId: 'settings-panel-providers',
    titleKey: 'providerShare.entry.label',
    sectionKey: 'settings.tabs.providers',
    keywordKeys: [
      'settings.providers.detail.remoteAccess.label',
      'settings.providers.detail.remoteAccess.description',
      'providerGroup.section.title',
      'settings.providers.detail.runLocation.label',
    ],
    aliases: ['供应商分享', '供应商组', 'provider group', 'provider sharing', '运行于', '借用', 'run on', 'borrow'],
  },
  modelCompaction: {
    id: 'model-compaction',
    tab: 'providers',
    targetId: 'settings-panel-providers',
    titleKey: 'settings.providers.models.advanced.compaction.title',
    sectionKey: 'settings.tabs.providers',
    aliases: ['compaction', '上下文压缩', '压缩比例'],
  },
  providers: {
    id: 'providers',
    tab: 'providers',
    targetId: 'settings-panel-providers',
    titleKey: TAB_LABEL_KEY['providers'],
    sectionKey: 'settings.sections.providers',
  },
  addProvider: {
    id: 'settings.providers.addProvider',
    fallbackTargetId: 'settings-panel-providers',
    tab: 'providers',
    targetId: 'settings-search-settings-providers-addProvider',
    titleKey: 'settings.providers.addProvider',
    keywordKeys: [
      'settings.providers.local.title',
      'settings.providers.llamacpp.title',
      'settings.providers.custom.nameSearchHint',
    ],
    sectionKey: 'settings.tabs.providers',
  },
});

export default {
  id: 'providers',
  order: 5,
  entries: Object.values(providersSettings),
} satisfies SettingsSearchModule;
