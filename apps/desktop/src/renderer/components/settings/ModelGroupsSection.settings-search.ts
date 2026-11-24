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
  autoSwitch: {
    id: 'modelGroups.autoSwitch',
    tab: 'model-groups',
    targetId: 'settings-model-groups-auto-switch',
    fallbackTargetId: 'settings-panel-model-groups',
    titleKey: 'modelGroups.settings.autoSwitch.title',
    descriptionKey: 'modelGroups.settings.autoSwitch.hint',
    sectionKey: 'settings.tabs.modelGroups',
    aliases: ['自动换', '自动接替', '故障转移', '降级', 'fallback', 'failover', 'auto switch'],
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
    ],
    aliases: ['路由', '额度', '订阅', '多账号', '自动选模型', 'routing', 'quota', 'fallback', 'failover', 'load balance', 'thinking', 'weight', '权重', '星期'],
  },
});

export default {
  id: 'model-groups',
  order: 5.1,
  entries: Object.values(modelGroupsSettings),
} satisfies SettingsSearchModule;
