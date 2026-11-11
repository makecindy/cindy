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
      'modelGroups.settings.exceptions.title',
      'modelGroups.settings.sources',
      'modelGroups.settings.try.title',
      'modelGroups.settings.effort',
    ],
    aliases: ['路由', '额度', '订阅', '多账号', '自动选模型', 'routing', 'quota', 'fallback', 'failover', 'load balance', 'thinking'],
  },
});

export default {
  id: 'model-groups',
  order: 5.1,
  entries: Object.values(modelGroupsSettings),
} satisfies SettingsSearchModule;
