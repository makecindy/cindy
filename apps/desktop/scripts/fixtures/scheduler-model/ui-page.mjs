import assert from 'node:assert/strict';

const model = { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000,
  efforts: ['low', 'medium', 'high'], defaultEffort: 'high', icon: 'claude' };
const provider = { id: 'anthropic', name: 'Anthropic', connected: true, remoteInvocationEnabled: true,
  agents: ['claude-code'], source: 'builtin', auth: { method: 'oauth' },
  routing: { 'claude-code': { mode: 'direct', wireProtocol: 'anthropic-messages' } },
  models: { 'claude-code': [model] } };
const speedModel = { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', contextWindow: 272000,
  efforts: ['low', 'medium', 'high', 'xhigh', 'ultra'], defaultEffort: 'high', icon: 'openai',
  supportsFastMode: true, supportsUltrafastMode: true };
const speedProvider = { ...provider, id: 'openai', name: 'OpenAI', agents: ['codex'],
  routing: { codex: { mode: 'direct', wireProtocol: 'openai-responses' } }, models: { codex: [speedModel] } };
const snapshot = JSON.stringify({ providers: [provider, speedProvider], providerOrder: [], loading: false, error: null, unsupported: false });
const caps = JSON.stringify({ availableModels: [model, speedModel].map(m => ({ ...m, displayName: m.name })),
  hasFastMode: true, effortLevels: model.efforts.map(id => ({ id, displayName: id })) });

export default {
  name: 'scheduler-model',
  entry: './scheduler-model-fixture.tsx',
  viewport: { width: 720, height: 600 },
  real: 'ScheduleFormDialog, form serialization/restoration, ModelEffortChip, unified picker and speed menu, source icons, themes and translations',
  notCovered: 'Live device/share discovery, authorization, database persistence and task execution; catalogs and JSON save boundary use fixture data',
  stubs: {
    'src/renderer/hooks/useModelRouteDevices': `const devices = [{ deviceId: 'shared:fixture', name: 'Shared Anthropic' }]; export const useModelRouteDevices = ({ leadAgentDeviceId }) => ({ devices, leadAgentDeviceId: leadAgentDeviceId ?? null });`,
    'src/renderer/hooks/useProviders': { partial: `const snapshot = ${snapshot}; export const useProviders = () => snapshot;` },
    'src/renderer/hooks/useDeviceProviders': { partial: `const snapshot = ${snapshot}; export const useDeviceProviders = () => snapshot;` },
    'src/renderer/hooks/useDevicesProviders': { partial: `const snapshot = ${snapshot}; const devices = new Map([['shared:fixture', snapshot]]); export const useDevicesProviders = () => devices;` },
    'src/renderer/hooks/useAgentCapabilities': { partial: `const capabilities = ${caps}; export const useAgentCapabilities = () => ({ capabilities, loading: false, error: null });` },
    'src/renderer/hooks/useAvailableAgents': { partial: `const agents = ['claude-code', 'codex']; export const useModelPickerAgents = () => agents; export const useAvailableAgents = () => ({availableVendors: new Set(['cc', 'codex']), loaded: true, loading: false});` },
    'src/renderer/hooks/useFeishuBot': 'export const useFeishuBot = () => ({status: "disconnected"});',
    'src/renderer/hooks/useWecomGroupNotificationSettings': 'export const useWecomGroupNotificationSettings = () => ({});',
    'src/renderer/hooks/useProjectPickerOptions': { partial: 'export const useProjectPickerOptions = () => [];' },
    'src/renderer/features/scheduler/hooks/useSessionReferences': 'export const useSessionReferences = () => new Map();',
    'src/renderer/lib/sessionService': 'export const resolveReferences = async () => [];',
    'src/renderer/features/scheduler/components/TemplateGallery': 'export const TemplateGallery = () => null;',
  },
  cases: {
    default: { about: 'Pick the shared source, then return to the local source' },
    speed: { about: 'Edit, save and reopen automation speed through the real modal', viewport: { width: 1100, height: 900 } },
    'shared-speed': { about: 'Edit and restore speed for a shared model source', viewport: { width: 1100, height: 900 } },
  },
  async check(page, ui) {
    if (ui.case.endsWith('speed')) {
      // Regression #6559: the portaled speed menu painted behind the editor.
      // Existing speed tests lacked the modal; jsdom cannot check hit testing.
      // Tier: Electron UI integration, with the actual form/picker and a fixture save boundary.
      const openConfiguration = async () => {
        await page.getByRole('button', { name: /Codex · GPT-6.1-Sol/ }).click();
        const row = page.locator('[data-unified-anchor]').filter({
          has: page.getByText('GPT-6.1-Sol', { exact: true }),
        });
        await row.hover();
        await row.locator('[data-row-customize]').click();
      };
      await openConfiguration();
      const speed = page.getByRole('button', { name: await ui.t('newChat.modelSelector.speed.label'), exact: true });
      for (const [mode, saved] of [['fast', 'true'], ['ultrafast', 'ultrafast'], ['standard', 'false']]) {
        await speed.click();
        const choice = page.getByRole('menuitemradio', { name: await ui.t(`newChat.modelSelector.speed.${mode}`), exact: true });
        await choice.waitFor();
        const reachable = await choice.evaluate(element => {
          const rect = element.getBoundingClientRect();
          return element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2));
        });
        await ui.capture(`${mode}-menu`);
        assert.ok(reachable, 'Speed menu is covered by the automation editor');
        await choice.click();
        assert.equal(await speed.getAttribute('title'), await ui.t(`newChat.modelSelector.speed.${mode}`));
        await speed.press('Escape');
        await page.keyboard.press('Escape');
        await page.getByRole('button', { name: await ui.t('scheduler.editor.promptDialog.saveAria'), exact: true }).click();
        const reopen = page.getByTestId('reopen-editor');
        await reopen.waitFor({ state: 'visible' });
        assert.equal(await reopen.getAttribute('data-saved-speed'), saved);
        await reopen.click();
        await openConfiguration();
        assert.equal(await speed.getAttribute('title'), await ui.t(`newChat.modelSelector.speed.${mode}`));
        await ui.capture(`${mode}-saved`);
      }
      return;
    }
    const trigger = page.getByTestId('automation-model').getByRole('button');
    await trigger.click();
    await page.getByRole('button', { name: 'Anthropic · Shared Anthropic', exact: true }).click();
    await ui.capture('shared-catalog');
    await page.getByText('Claude Sonnet 4.6', { exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="automation-model"]')?.getAttribute('data-device') === 'shared:fixture');
    assert.equal(await page.getByTestId('automation-model').getAttribute('data-provider'), 'anthropic');
    assert.equal(await trigger.locator('[data-remote-source-mark]').count(), 1);
    await ui.capture('shared-selected');
    await trigger.click();
    await page.getByRole('button', { name: 'Anthropic', exact: true }).click();
    await page.getByText('Claude Sonnet 4.6', { exact: true }).filter({ visible: true }).click();
    await page.waitForFunction(() => document.querySelector('[data-testid="automation-model"]')?.getAttribute('data-device') === '');
    assert.equal(await trigger.locator('[data-remote-source-mark]').count(), 0);
    await ui.capture('local-selected');
  },
};
