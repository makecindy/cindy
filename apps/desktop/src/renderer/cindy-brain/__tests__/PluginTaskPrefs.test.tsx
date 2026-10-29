// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { PluginTaskPrefs } from '../PluginTaskPrefs';

const state = vi.hoisted(() => ({
  config: {} as Record<string, unknown>,
  auxiliaryModelLabel: 'Grok 4.6' as string | null | undefined,
  save: vi.fn(),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, string>) =>
      values?.model ? `${key}:${values.model}` : key,
  }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({ useModelPickerAgents: () => [] }));
vi.mock('@/state/newMakerDraft', () => ({
  getEffortForModel: () => undefined, getFastModeForModel: () => false,
}));
vi.mock('@/components/new-chat/ModelSelector', () => ({ ModelSelector: (props: any) => (
  <>
  <button disabled={props.disabled} data-testid="model" onClick={() => props.onUnifiedSelect({ engine: 'codex', providerId: 'openai', modelId: 'chosen', effort: 'high', fast: false })}>
    {props.fallbackOption?.active ? props.fallbackOption.label : `${props.vendorKey}/${props.currentProviderId}/${props.modelId}`}
  </button>
  <button data-testid="follow" onClick={() => props.fallbackOption?.onSelect()}>follow</button>
  <button data-testid="fast" onClick={() => props.onFastModeChange(true)}>Fast</button>
  </>
) }));
vi.mock('@/components/new-chat/PermissionSelector', () => ({ PermissionSelector: (props: any) => (
  <>
  <button disabled={props.disabled} data-testid="permission" data-legacy-label={props.fallbackModeLabel}
    onClick={() => props.onPermissionModeChange('ask')}>{props.permissionMode}</button>
  {(props.allowedModes ?? ['ask', 'acceptEdits', 'auto', 'bypassPermissions']).map((mode: string) =>
    <button key={mode} data-testid={`permission-mode-${mode}`} disabled={props.disabled || !!props.disabledModes?.[mode]}
      onClick={() => props.onPermissionModeChange(mode)}>{mode}</button>)}
  </>
) }));

beforeEach(() => {
  state.config = {};
  state.auxiliaryModelLabel = 'Grok 4.6';
  state.save.mockReset().mockImplementation(async (_id, config) => ({ config }));
  (window as unknown as { electronAPI: unknown }).electronAPI = { ghosts: {
    errandPrefsSync: () => ({ config: state.config, auxiliaryModelLabel: state.auxiliaryModelLabel }),
    setErrandConfig: state.save,
  } };
});
afterEach(cleanup);
// unit: the shared picker must expose and persist the ordinary three modes,
// without silently changing a retained legacy setting just by opening the page.
it('offers full access and saves only after the user changes the legacy choice', async () => {
  state.config = { permissionMode: 'acceptEdits' };
  render(<PluginTaskPrefs ghostId="plugin" />);
  expect(screen.getByTestId('permission').textContent).toBe('acceptEdits');
  expect(screen.getByTestId('permission').getAttribute('data-legacy-label')).toBeTruthy();
  expect(screen.queryByTestId('permission-mode-acceptEdits')).toBeNull();
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('permission-mode-bypassPermissions'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', { permissionMode: 'bypassPermissions' }));
});
it.each([undefined, 'medium'])('changing Fast preserves only the configured effort (%s), never the display fallback', async effort => {
  state.config = {agentKind:'codex',providerId:'openai',model:'configured-model',effort};
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByTestId('fast'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', {...state.config, fastMode:true}));
});
it('follows the system auxiliary model by default, without previewing a new-task draft', () => {
  render(<PluginTaskPrefs ghostId="plugin" />);
  expect(screen.getByTestId('model').textContent).toBe('settings.ghosts.detail.errandPrefs.followAuxiliary:Grok 4.6');
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.title')).toBeTruthy();
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.desc')).toBeTruthy();
  expect(screen.queryByText('settings.ghosts.detail.errandPrefs.restoreModel')).toBeNull();
  expect(screen.getByTestId('permission').textContent).toBe('ask');
  // Following the default is already the state; selecting it again writes nothing.
  fireEvent.click(screen.getByTestId('follow'));
  expect(state.save).not.toHaveBeenCalled();
});
it('names the follow-default row even when no auxiliary model is configured (older hosts omit the label)', () => {
  state.auxiliaryModelLabel = undefined;
  render(<PluginTaskPrefs ghostId="plugin" />);
  expect(screen.getByTestId('model').textContent).toBe('settings.ghosts.detail.errandPrefs.followAuxiliaryUnset');
});
it('saves the complete selected combination as the plugin model', async () => {
  state.config = { permissionMode: 'auto' };
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByTestId('model'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', {
    permissionMode: 'auto', agentKind: 'codex', providerId: 'openai', model: 'chosen', effort: 'high', fastMode: false,
  }));
  expect(screen.getByTestId('model').textContent).toBe('codex/openai/chosen');
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.restoreModel')).toBeTruthy();
});
it('quick-answer-only plugins show just the model row', () => {
  render(<PluginTaskPrefs ghostId="plugin" showTaskRows={false} />);
  expect(screen.getByTestId('model')).toBeTruthy();
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.descModelOnly')).toBeTruthy();
  expect(screen.queryByTestId('permission')).toBeNull();
  expect(screen.queryByText('settings.ghosts.detail.errandPrefs.workdir')).toBeNull();
});
it('keeps the label column outside the full-width picker so its tooltip cannot cover the label', () => {
  render(<PluginTaskPrefs ghostId="plugin" />);
  const label = screen.getByText('settings.ghosts.detail.errandPrefs.model');
  expect(label.className).toContain('shrink-0');
  expect(label.contains(screen.getByTestId('model'))).toBe(false);
  expect(label.closest('[data-plugin-task-row="model"]')).toBeTruthy();
});
it('preserves legacy permissions until the user explicitly chooses an ordinary mode', async () => {
  render(<PluginTaskPrefs ghostId="plugin" legacyDefault />);
  expect(screen.getByTestId('permission').textContent).toBe('plan');
  expect(screen.getByTestId('permission').getAttribute('data-legacy-label')).toBe('settings.ghosts.detail.errandPrefs.legacyPermission');
  expect(screen.getByText('settings.ghosts.detail.errandPrefs.legacyPermissionHint')).toBeTruthy();
  expect(state.save).not.toHaveBeenCalled();
  fireEvent.click(screen.getByTestId('permission'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', { permissionMode: 'ask' }));
  expect(screen.queryByText('settings.ghosts.detail.errandPrefs.legacyPermissionHint')).toBeNull();
});
it.each(['restoreModel', 'follow'])('resetting the model via %s preserves explicitly selected permissions and directory', async (control) => {
  state.config = { agentKind: 'codex', model: 'old', providerId: 'old-connection', permissionMode: 'auto', workingDir: '/selected' };
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(control === 'follow'
    ? screen.getByTestId('follow')
    : screen.getByText('settings.ghosts.detail.errandPrefs.restoreModel'));
  await waitFor(() => expect(state.save).toHaveBeenCalledWith('plugin', { permissionMode: 'auto', workingDir: '/selected' }));
  expect(screen.getByTestId('model').textContent).toBe('settings.ghosts.detail.errandPrefs.followAuxiliary:Grok 4.6');
});
it('shows actionable host validation errors and restores the saved selection', async () => {
  state.save.mockRejectedValue(new Error('[INVALID_PARAMS] 供应商未连接，请修复连接后重试'));
  render(<PluginTaskPrefs ghostId="plugin" />);
  fireEvent.click(screen.getByTestId('model'));
  await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('修复连接'));
  expect(screen.getByTestId('model').textContent).toBe('settings.ghosts.detail.errandPrefs.followAuxiliary:Grok 4.6');
  expect((screen.getByTestId('model') as HTMLButtonElement).disabled).toBe(false);
});
