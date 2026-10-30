import assert from 'node:assert/strict';

const model = { id: 'claude-sonnet-4-6', name: 'Claude Sonnet 4.6', contextWindow: 200000,
  efforts: ['low', 'medium', 'high'], defaultEffort: 'high', icon: 'claude' };
const provider = { id: 'anthropic', name: 'Anthropic', connected: true, remoteInvocationEnabled: true,
  agents: ['claude-code'], source: 'builtin', auth: { method: 'oauth' },
  routing: { 'claude-code': { mode: 'direct', wireProtocol: 'anthropic-messages' } },
  models: { 'claude-code': [model] } };
const snapshot = JSON.stringify({ providers: [provider], providerOrder: [], loading: false, error: null, unsupported: false });
const caps = JSON.stringify({ availableModels: [{ ...model, displayName: model.name }],
  effortLevels: model.efforts.map(id => ({ id, displayName: id })) });

export default {
  name: 'scheduler-model',
  entry: './scheduler-model-fixture.tsx',
  viewport: { width: 720, height: 600 },
  real: 'Automation ModelEffortChip, unified model picker, selection callback, source icons, themes and translations',
  notCovered: 'Live device/share discovery, authorization, persistence and task execution; catalog hooks use fixture snapshots',
  stubs: {
    'src/renderer/hooks/useModelRouteDevices': `const devices = [{ deviceId: 'shared:fixture', name: 'Shared Anthropic' }]; export const useModelRouteDevices = ({ leadAgentDeviceId }) => ({ devices, leadAgentDeviceId: leadAgentDeviceId ?? null });`,
    'src/renderer/hooks/useProviders': { partial: `const snapshot = ${snapshot}; export const useProviders = () => snapshot;` },
    'src/renderer/hooks/useDeviceProviders': { partial: `const snapshot = ${snapshot}; export const useDeviceProviders = () => snapshot;` },
    'src/renderer/hooks/useDevicesProviders': { partial: `const snapshot = ${snapshot}; const devices = new Map([['shared:fixture', snapshot]]); export const useDevicesProviders = () => devices;` },
    'src/renderer/hooks/useAgentCapabilities': { partial: `const capabilities = ${caps}; export const useAgentCapabilities = () => ({ capabilities, loading: false, error: null });` },
    'src/renderer/hooks/useAvailableAgents': { partial: `const agents = ['claude-code']; export const useModelPickerAgents = () => agents;` },
  },
  cases: { default: { about: 'Pick the shared source, then return to the local source' } },
  async check(page, ui) {
    const trigger = page.getByTestId('automation-model').getByRole('button');
    await trigger.click();
    await page.getByRole('button', { name: /Shared Anthropic/ }).click();
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
