import { defineSettings, type SettingsSearchModule } from './settingsSearchTypes';

/** Static search metadata owned by this settings module; no component mounting or IPC. */
export const modelGroupsSettings = defineSettings({
  page: {
    id: 'modelGroups.page',
    tab: 'model-groups',
    targetId: 'settings-panel-model-groups',
    titleKey: 'settings.tabs.modelGroups',
    descriptionKey: 'modelGroups.description',
    sectionKey: 'settings.tabs.modelGroups',
    aliases: ['模型编排', '模型路由', 'model routing', 'model orchestration'],
  },
  routes: {
    id: 'modelGroups.routes',
    tab: 'model-groups',
    targetId: 'settings-model-groups-routes',
    fallbackTargetId: 'settings-panel-model-groups',
    titleKey: 'modelGroups.routes',
    descriptionKey: 'modelGroups.routesDescription',
    sectionKey: 'settings.tabs.modelGroups',
    keywordKeys: [
      'modelGroups.strategy.expiring.title',
      'modelGroups.strategy.order.title',
      'modelGroups.strategy.rotate.title',
      'modelGroups.strategy.cheapest.title',
      'modelGroups.strategy.drain.title',
      'modelGroups.strategy.headroom.title',
      'modelGroups.strategy.weighted.title',
      'modelGroups.settings.weight',
      'modelGroups.settings.exceptions.title',
      'modelGroups.settings.exceptions.days',
      'modelGroups.settings.exceptions.daysHint',
      'modelGroups.settings.sources',
      'modelGroups.settings.try.title',
      'modelGroups.settings.effort',
      'modelGroups.settings.autoSwitch.title',
    ],
    aliases: ['路由', '额度', '订阅', '多账号', '自动选模型', 'routing', 'quota', 'fallback', 'failover', 'load balance', 'thinking', 'weight', '权重', '星期', '自动换', '接替', '故障转移', 'auto switch'],
  },
  /** 伙伴用哪个模型：这台电脑的默认、单独设置的伙伴、其他电脑上的伙伴(2026-11-26)。伙伴设置页的入口落到这里。 */
  buddies: {
    id: 'modelGroups.buddies',
    tab: 'model-groups',
    targetId: 'settings-model-groups-buddies',
    fallbackTargetId: 'settings-panel-model-groups',
    titleKey: 'modelGroups.buddies.title',
    descriptionKey: 'modelGroups.buddies.description',
    sectionKey: 'settings.tabs.modelGroups',
    keywordKeys: ['modelGroups.buddies.defaultLabel', 'modelGroups.buddies.ownTitle', 'modelGroups.buddies.otherComputers'],
    aliases: ['伙伴模型', '伙伴默认模型', '伙伴的模型', 'buddy model', 'buddies', 'companion model', 'default buddy model'],
  },
});

export default {
  id: 'model-groups',
  order: 5.1,
  entries: Object.values(modelGroupsSettings),
} satisfies SettingsSearchModule;
