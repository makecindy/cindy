export default {
  name: 'plugin-event-trigger', entry: './plugin-event-fixture.tsx', viewport: { width: 1100, height: 900 },
  real: 'ScheduleFormDialog, WebhookSourceFields, PluginEventSourceFields, translations and theme',
  notCovered: 'Fixture plugin catalog, listening status. No real plugin, event delivery, model execution or writes.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration = () => 0;',
    'src/renderer/hooks/useAgentCapabilities': '../scheduler-trigger/catalog-hooks.ts',
    'src/renderer/hooks/useProviders': '../scheduler-trigger/catalog-hooks.ts',
    'src/renderer/hooks/useDeviceProviders': '../scheduler-trigger/catalog-hooks.ts',
    'src/renderer/hooks/useFeishuBot': 'export const useFeishuBot = () => ({status: "disconnected"});',
    'src/renderer/hooks/useWecomGroupNotificationSettings': 'export const useWecomGroupNotificationSettings = () => ({});',
    'src/renderer/hooks/useProjectPickerOptions': 'export const useProjectPickerOptions = () => [];',
    'src/renderer/features/scheduler/hooks/useSessionReferences': 'export const useSessionReferences = () => new Map();',
    'src/renderer/lib/sessionService': 'export const resolveReferences = async () => [];',
    'src/renderer/features/scheduler/components/BoundSessionCard': 'export const BoundSessionCard = () => null;',
    'src/renderer/features/scheduler/components/TemplateGallery': 'export const TemplateGallery = () => null;',
    'src/renderer/features/scheduler/components/ScheduleChips': `import React from 'react'; const chip = label => React.createElement('button', {type: 'button', style: {height: 34}}, label); export const ProjectChip = () => chip('对话'); export const ModelEffortChip = () => chip('Codex'); export const ScheduleChip = () => chip('09:00'); export const ScheduleSettingsButton = () => null; export const ThreadPickerInline = () => null;`,
  },
  cases: {
    default: { about: '编辑已选插件事件的自动化：飞书只选“收到私信”，Slack 全部事件，保留 Agent 设置的条件' },
    'signed-out': { about: '未登录 Cindy：「事件」仍可选，只提供插件事件，勾选后保存' },
  },
  async ready(page) {
    await page.locator('[role="dialog"]').first().waitFor();
  },
  async check(page, ui) {
    const legend = await ui.t('scheduler.editor.webhook.plugin.label');
    if (ui.case === 'signed-out') {
      const trigger = page.getByRole('radio', { name: await ui.t('scheduler.editor.trigger.event'), exact: true });
      await trigger.click();
      await page.getByText(legend, { exact: true }).waitFor();
      await page.getByRole('checkbox', { name: '收到私信', exact: true }).check();
      await ui.capture('plugin-selected');
      return;
    }
    await page.getByText(legend, { exact: true }).scrollIntoViewIfNeeded();
    await ui.capture('plugin-sources');
    // A saved plugin that is no longer installed stays visible and removable.
    await page.getByText(await ui.t('scheduler.editor.webhook.plugin.hint'), { exact: true }).scrollIntoViewIfNeeded();
    await page.getByText(await ui.t('scheduler.editor.webhook.plugin.unavailable'), { exact: true }).waitFor();
    await ui.capture('plugin-hint');
    // 2026-11-24: every event source may add a timed check.
    await page.getByRole('checkbox', { name: await ui.t('scheduler.prTrigger.timed'), exact: true }).check();
    await ui.capture('timed-check');
  },
};
