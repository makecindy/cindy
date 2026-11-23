export default {
  name: 'plugin-event-detail', entry: './plugin-event-detail-fixture.tsx', viewport: { width: 780, height: 620 },
  real: 'RunHistoryPane, WebhookTriggerPanel plugin-event branch, RunHistoryCard, translations and theme',
  notCovered: 'Fixture plugin catalog, listening status and runs. No real plugin, event delivery, model execution or writes.',
  stubs: {
    'src/renderer/contexts/AuthContext': 'export const useOptionalDataOwnerGeneration = () => 0;',
    'src/renderer/hooks/useCCSessions': 'export const useCCSessions = () => ({ sessions: [] });',
    'src/renderer/features/scheduler/hooks/useSessionReferences': 'export const useSessionReferences = () => new Map();',
    'src/renderer/features/scheduler/hooks/useRuns': 'export const useRuns = id => ({ runs: window.__pluginEventRuns, runsScheduleId: id, hasLoaded: true, error: null });',
    'src/renderer/lib/sessionAttentionStore': 'export const clearSessionAttentionMany = () => {};',
    'src/renderer/lib/sessionService': 'export const resolveReferences = async () => [];',
    'src/renderer/lib/errorDiagnosisPrompt': 'export const buildErrorDiagnosisPrompt = () => ""; export const prefillErrorDiagnosisDraft = () => {};',
  },
  cases: {
    default: { about: '自动化详情：各插件的监听状态、所选事件、条件数与离线提示；没有地址和密钥' },
  },
  async ready(page) {
    await page.locator('[role="status"]').first().waitFor();
  },
  async check(page, ui) {
    await page.getByText(await ui.t('scheduler.editor.webhook.plugin.state.listening'), { exact: true }).waitFor();
    if (await page.getByText('https://', { exact: false }).count()) throw new Error('Plugin events must not show a Webhook address');
  },
};
