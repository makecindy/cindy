// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginTaskPrefs } from '../PluginTaskPrefs';

const state = vi.hoisted(() => ({ config: {} as Record<string, unknown>, save: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useModelPickerAgents: () => [] }));
vi.mock('@/state/newMakerDraft', () => ({
  useNewMakerDraft: () => ({ vendor: 'codex', lastByVendor: { codex: { model: 'gpt-6-astra', providerId: 'openai', effort: 'high' } } }),
  getEffortForModel: () => undefined, getFastModeForModel: () => false,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ModelSelector: (props: any) => (
  <>
  <button disabled={props.disabled} data-testid="model" onClick={() => props.onUnifiedSelect({ engine: 'codex', providerId: 'openai', modelId: 'chosen', effort: 'high', fast: false })}>
    {props.vendorKey}/{props.currentProviderId}/{props.modelId}
  </button>
  <button data-testid="fast" onClick={() => props.onFastModeChange(true)}>Fast</button>
  </>
) }));
vi.mock('@/components/new-chat/PermissionSelector', () => ({ PermissionSelector: (props: any) => (
  <button disabled={props.disabled} data-testid="permission" data-legacy-label={props.fallbackModeLabel}
    onClick={() => props.onPermissionModeChange('ask')}>{props.permissionMode}</button>
) }));

beforeEach(() => {
  state.config = {};
  state.save.mockReset().mockImplementation(async (_id, config) => ({ config }));
  (window as any).electronAPI = { ghosts: { errandPrefsSync: () => ({ config: state.config }), setErrandConfig: state.save } };
});
afterEach(cleanup);
it.each([undefined, 'medium'])('changing Fast preserves only the configured effort (%s), never the display fallback', async effort => {
  state.config = {agentKind:'codex',providerId:'openai',model:'configured-model',effort};
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByTestId('fast'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', {...state.config, fastMode:true}));
});
it('previews the complete current panel route and uses ordinary task permissions independently', () => {
  render(<PluginTaskPrefs ghostId="plugin" />);
  expect(screen.getByTestId('model').textContent).toBe('codex/openai/gpt-6-astra');
  expect(screen.getByTestId('permission').textContent).toBe('ask');
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.sourceDefault')).toBeTruthy();
});
it('preserves legacy permissions until the user explicitly chooses an ordinary mode', async () => {
  render(<PluginTaskPrefs ghostId="plugin" legacyDefault />);
  expect(screen.getByTestId('permission').textContent).toBe('plan');
  expect(screen.getByTestId('permission').getAttribute('data-legacy-label')).toBe('settings.ghosts.detail.errandPrefs.legacyPermission');
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('permission'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', { permissionMode: 'ask' }));
});
it('resetting the model preserves explicitly selected permissions and directory', async () => {
  state.config = { agentKind: 'codex', model: 'old', providerId: 'old-connection', permissionMode: 'auto', workingDir: '/selected' };
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByText('settings.ghosts.detail.errandPrefs.restoreModel'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', { permissionMode: 'auto', workingDir: '/selected' }));
  expect(screen.getByTestId('model').textContent).toBe('codex/openai/gpt-6-astra');
});
it('shows actionable host validation errors and restores the saved selection', async () => {
  state.save.mockRejectedValue(new Error('[INVALID_PARAMS] 供应商未连接，请修复连接后重试'));
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByTestId('model'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('修复连接'));
  expect(screen.getByTestId('model').textContent).toBe('codex/openai/gpt-6-astra');
  expect((screen.getByTestId('model') as HTMLButtonElement).disabled).toBe(false);
});
