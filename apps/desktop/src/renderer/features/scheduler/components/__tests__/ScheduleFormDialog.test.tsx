// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleTemplate } from '@cindy/maker-scheduler';

// PR #6832: exercise the real form's save/effect path. Pure form-logic tests cannot
// catch the dialog wiring a remote choice to the local catalog. Minimal inputs:
// a remote-only model, or same-ID models with conflicting effort/Fast capabilities.
// Tier: unit/jsdom; separate from hook-only tests because this renders the dialog.
// Standalone Windows run: 3.14s Vitest / 4.21s process wall time (5 cases).
const state = vi.hoisted(() => ({
  warning: vi.fn(),
  error: vi.fn(),
  references: new Map<string, unknown>(),
  loading: false,
  localModels: [{ id: 'shared', efforts: ['low'], supportsFastMode: false }],
  remoteModels: [
    { id: 'shared', efforts: ['ultra'], supportsFastMode: true },
    { id: 'remote-only', efforts: ['ultra'], supportsFastMode: true },
  ],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { exists: () => true } }) }));
vi.mock('@/lib/toast', () => ({ toast: { warning: state.warning, success: vi.fn(), error: state.error } }));
vi.mock('@/hooks/useAgentCapabilities', () => ({
  getCachedCapabilities: () => null,
  useAgentCapabilities: (_agent: string, device?: string) => ({
    capabilities: { availableModels: device && !state.loading ? state.remoteModels : state.localModels, hasFastMode: true },
    loading: !!device && state.loading,
  }),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [{ id: 'source', connected: true, agents: ['codex'], routing: { codex: {} },
    models: { codex: state.localModels } }], loading: false }),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: [{ id: 'source', connected: true, agents: ['codex'], routing: { codex: {} },
    models: { codex: state.loading ? state.localModels : state.remoteModels } }], loading: state.loading }),
}));
vi.mock('@/hooks/useFeishuBot', () => ({ useFeishuBot: () => ({ status: 'disconnected' }) }));
vi.mock('@/hooks/useWecomGroupNotificationSettings', () => ({ useWecomGroupNotificationSettings: () => ({}) }));
vi.mock('@/hooks/useProjectPickerOptions', () => ({ useProjectPickerOptions: () => [] }));
vi.mock('../../hooks/useSessionReferences', () => ({ useSessionReferences: () => state.references }));
vi.mock('@radix-ui/react-dialog', () => {
  const Pass = ({ children }: { children?: ReactNode }) => <>{children}</>;
  return { Root: Pass, Portal: Pass, Overlay: () => null, Content: Pass, Title: Pass, Description: Pass, Close: Pass };
});
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children?: ReactNode }) => children }));
vi.mock('../TemplateGallery', () => ({ TemplateGallery: () => null }));
vi.mock('../TemplateParamForm', () => ({ TemplateParamForm: () => null }));
vi.mock('../BoundSessionCard', () => ({ BoundSessionCard: () => null }));
vi.mock('../ScheduleChips', () => ({
  ProjectChip: () => null, ScheduleChip: () => null, ScheduleSettingsButton: () => null, ThreadPickerInline: () => null,
  ModelEffortChip: ({ onSelect }: { onSelect: (choice: unknown) => void }) => (
    <button onClick={() => onSelect({ engine: 'codex', modelId: 'remote-only', providerId: 'source',
      effort: 'ultra', fast: true, agentDevice: { deviceId: 'studio' } })}>select remote</button>
  ),
}));

import { ScheduleFormDialog } from '../ScheduleFormDialog';

function schedule(patch: Partial<Schedule> = {}): Schedule {
  return { id: 'schedule', name: 'Test', prompt: 'Check work', agentKind: 'codex',
    model: 'shared', providerId: 'source', cronExpr: '0 9 * * *', timezone: 'UTC',
    recurring: true, manual: false, workspaceKind: 'dialogue', useWorktree: false,
    notify: { desktop: true, feishu: false }, status: 'active', kind: 'cron', source: 'user',
    jobType: 'prompt', createdAt: 1, updatedAt: 1, ...patch };
}
function mount(initial: Schedule) {
  const onSubmit = vi.fn(async () => {});
  const element = () => <ScheduleFormDialog open initial={initial} onOpenChange={() => {}} onSubmit={onSubmit} />;
  const view = render(element());
  return { onSubmit, refresh: () => view.rerender(element()),
    save: () => fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.saveAria' })) };
}

// Saving an SSH override used to expose an English exception in a transient toast.
// Exercise the real submit rejection: curated guidance stays visible, diagnostic
// details are available on demand and the form remains editable. Unit/jsdom tier.
it('keeps localized switch guidance and redacted diagnostics after a rejected save', async () => {
  const h = mount(schedule());
  h.onSubmit.mockRejectedValueOnce(new Error('[SSH_HARNESS_SWITCH_UNSUPPORTED] technical diagnostic api_key=private-value'));
  h.save();
  await waitFor(() => expect(screen.getByText('chat.remoteError.SSH_HARNESS_SWITCH_UNSUPPORTED')).toBeTruthy());
  // The notice can be above the viewport when saving a long form. Keep the
  // shared alert toast, with curated copy rather than the diagnostic/secret.
  expect(state.error).toHaveBeenCalledExactlyOnceWith('chat.remoteError.SSH_HARNESS_SWITCH_UNSUPPORTED');
  expect(screen.queryByText(/technical diagnostic/)).toBeNull();
  fireEvent.click(screen.getByText('chat.errorBanner.networkShowRaw'));
  expect(screen.getByText(/technical diagnostic/).textContent).toContain('[REDACTED]');
  expect(screen.queryByText(/private-value/)).toBeNull();
  h.save();
  await waitFor(() => expect(h.onSubmit).toHaveBeenCalledTimes(2));
  expect(screen.queryByText('chat.remoteError.SSH_HARNESS_SWITCH_UNSUPPORTED')).toBeNull();
});
beforeEach(() => {
  vi.clearAllMocks();
  state.references.clear();
  state.loading = false;
  localStorage.clear();
});
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

// PR #6830, unit/jsdom: a bound remote task must not hide an explicit local
// model-only selection from the real hook-generation IPC request.
it('sends the explicit local Harness and location when generating a bound hook', async () => {
  const generatePreRunHook = vi.fn(async () => ({ ok: false, reason: 'no_candidate', attempts: [] }));
  vi.stubGlobal('electronAPI', { maker: { schedule: { generatePreRunHook } } });
  state.references.set('bound', { id: 'bound', state: 'available', status: 'active', agentKind: 'claude-code', agentDeviceId: 'studio' });
  mount(schedule({ targetSessionId: 'bound', modelAgentKind: 'codex', modelAgentDeviceId: '', providerId: '',
    preRunHook: { command: 'node check.mjs' } }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.preRunHook.aiModify' }));
  fireEvent.change(screen.getByPlaceholderText('scheduler.editor.preRunHook.aiPlaceholder'), { target: { value: 'check changes' } });
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.preRunHook.aiGenerate' }));
  await waitFor(() => expect(generatePreRunHook).toHaveBeenCalledWith(expect.objectContaining({
    targetSessionId: 'bound', modelAgentDeviceId: '', agentKind: 'codex', model: 'shared', resolveBoundSessionRoute: true,
  })));
});

it('saves a selected remote-only model against its own catalog', async () => {
  const form = mount(schedule());
  fireEvent.click(screen.getByText('select remote'));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    modelAgentDeviceId: 'studio', model: 'remote-only', providerId: 'source', effort: 'ultra', fastMode: true,
  }), true));
});

it('validates an override at the bound task location even without a saved device', async () => {
  state.references.set('bound', { id: 'bound', state: 'available', status: 'active', agentKind: 'codex', agentDeviceId: 'studio' });
  const form = mount(schedule({ targetSessionId: 'bound', model: 'remote-only', modelAgentKind: 'codex' }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    targetSessionId: 'bound', model: 'remote-only',
  }), true));
});

it('keeps legacy remote effort and Fast when the local same-ID copy differs', async () => {
  const form = mount(schedule({ agentDeviceId: 'studio', effort: 'ultra', fastMode: true }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    effort: 'ultra', fastMode: true,
  }), true));
});

it('rejects a model missing from the selected remote catalog', () => {
  const form = mount(schedule({ agentDeviceId: 'studio', model: 'removed', modelAgentKind: 'codex' }));
  form.save();
  expect(form.onSubmit).not.toHaveBeenCalled();
  expect(state.warning).toHaveBeenCalledWith('scheduler.editor.validation.modelUnavailable');
});

it('preserves remote preferences while its catalog refresh is still loading', async () => {
  state.loading = true;
  const form = mount(schedule({ agentDeviceId: 'studio', effort: 'ultra', fastMode: true }));
  state.loading = false;
  form.refresh();
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    effort: 'ultra', fastMode: true,
  }), true));
});

// Merge review, unit/jsdom: providers refresh with a new array while a template
// draft is open. The real initialization effect must not replay over user edits.
it('keeps edited template fields across catalog refreshes and reapplies on reopening', () => {
  const template: ScheduleTemplate = { id: 'initial', name: 'Template title', prompt: 'Template prompt',
    description: '', category: 'code-quality', source: 'builtin', agentKind: 'codex', model: 'shared', providerId: 'source' };
  const element = (open = true) => <ScheduleFormDialog open={open} initial={null} initialTemplate={template}
    onOpenChange={() => {}} onSubmit={async () => {}} />;
  const view = render(element());
  fireEvent.change(screen.getByDisplayValue('Template title'), { target: { value: 'Edited title' } });
  fireEvent.change(screen.getByDisplayValue('Template prompt'), { target: { value: 'Edited prompt' } });
  // The useProviders fixture returns a fresh catalog array on each render.
  view.rerender(element());
  expect(screen.getByDisplayValue('Edited title')).toBeTruthy();
  expect(screen.getByDisplayValue('Edited prompt')).toBeTruthy();
  view.rerender(element(false));
  view.rerender(element());
  expect(screen.getByDisplayValue('Template title')).toBeTruthy();
  expect(screen.getByDisplayValue('Template prompt')).toBeTruthy();
});
