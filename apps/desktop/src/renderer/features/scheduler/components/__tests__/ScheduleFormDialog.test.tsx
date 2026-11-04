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
vi.mock('../WebhookAccountManager', () => ({ WebhookAccountManager: () => null }));
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
  vi.stubGlobal('electronAPI', { maker: { schedule: {
    webhookReceiver: async () => 'cloud', scriptCapabilityStatus: async () => ({ statuses: [] }),
  } } });
});
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

// PR #6830, unit/jsdom: a bound remote task must not hide an explicit local
// model-only selection from the real hook-generation IPC request.
it('sends the explicit local Harness and location when generating a bound hook', async () => {
  const generatePreRunHook = vi.fn(async () => ({ ok: false, reason: 'no_candidate', attempts: [] }));
  vi.stubGlobal('electronAPI', { maker: { schedule: { generatePreRunHook, webhookReceiver: async () => 'cloud' } } });
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

// A saved Webhook remains visible but cannot be configured while signed out.
// Saving unrelated fields must preserve it so receiving resumes after signing in.
it('keeps the saved Webhook trigger while signed out', async () => {
  vi.stubGlobal('electronAPI', { maker: { schedule: { webhookReceiver: async () => 'signed-out' } } });
  const form = mount(schedule({ webhookTrigger: { endpointId: 'endpoint', events: ['check_suite'] } }));
  expect(screen.getByRole('radio', { name: 'scheduler.cell.tagWebhook' }).hasAttribute('disabled')).toBe(true);
  form.save();
  // 没有保存过发送方的任务按默认的 GitHub 写回，接收行为不变。
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    webhookTrigger: { events: ['check_suite'], source: { preset: 'github' } },
  }), true));
});

// 2026-11-04 product decision, unit/jsdom: Webhook and timed triggering are separate
// choices. Exercise the real form in both execution modes; saving an existing
// trigger alone cannot catch the removed combined-trigger UI or mode switching.
it.each(['agent', 'script'] as const)('keeps Webhook and timed triggering separate for %s execution', async (executionMode) => {
  const form = mount(schedule({ executionMode,
    ...(executionMode === 'script' ? { workspaceKind: 'project' as const, workingDir: '/test-project', scriptConfig: { command: 'node check.cjs', capabilities: [] } } : {}),
  }));
  fireEvent.click(await screen.findByRole('radio', { name: 'scheduler.cell.tagWebhook' }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    manual: true, webhookTrigger: expect.objectContaining({ source: { preset: 'github' } }), executionMode,
  }), true));
  fireEvent.click(screen.getByRole('button', { name: 'routines.advancedSettings' }));
  expect(screen.queryByRole('switch', { name: 'scheduler.editor.webhook.timedFallback' })).toBeNull();
  fireEvent.click(screen.getByRole('radio', { name: 'scheduler.editor.trigger.timed' }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    manual: false, recurring: true, cronExpr: '0 9 * * *', webhookTrigger: null,
  }), true));
  fireEvent.click(screen.getByRole('radio', { name: 'scheduler.editor.fields.manually' }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    manual: true, webhookTrigger: null,
  }), true));
});

it('preserves both triggers when editing an existing timed Webhook', async () => {
  const form = mount(schedule({ webhookTrigger: { endpointId: 'existing', events: ['issues.opened'], source: { preset: 'github' } } }));
  await screen.findByRole('button', { name: 'routines.advancedSettings' });
  expect(screen.getByRole('radio', { name: 'scheduler.cell.tagWebhook' }).getAttribute('aria-checked')).toBe('true');
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    manual: false, recurring: true, cronExpr: '0 9 * * *', webhookTrigger: { events: ['issues.opened'], source: { preset: 'github' } },
  }), true));
});

// Event picker, unit/jsdom: real form submission must retain filters outside the
// suggestion catalog and serialize a clicked action. Prior cases only saved
// existing text; a catalog-only picker could silently drop the unknown filter.
// Standalone Windows run including the 14 dialog cases: 4.76s Vitest, 832ms tests.
it('selects an event by label while preserving an unlisted saved filter', async () => {
  const picker = 'scheduler.editor.webhook.eventPicker';
  const form = mount(schedule({ manual: true, webhookTrigger: {
    endpointId: 'existing', events: ['issues.opened', 'future_event.changed'], source: { preset: 'github' },
  } }));
  fireEvent.click(await screen.findByRole('button', { name: `${picker}.choose` }));
  fireEvent.change(screen.getByRole('textbox', { name: `${picker}.search` }), { target: { value: 'pull_request.closed' } });
  fireEvent.click(screen.getByRole('checkbox', { name: `${picker}.groups.pullRequests · ${picker}.actions.closed` }));
  fireEvent.click(screen.getByRole('button', { name: `${picker}.apply` }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    webhookTrigger: { events: ['issues.opened', 'future_event.changed', 'pull_request.closed'], source: { preset: 'github' } },
  }), true));
});

// Removing the last tag must not broaden receiving to all events implicitly.
// The minimal failure is a saved one-event filter; cancel retains it, and only
// the explicit All choice serializes an empty list (the scheduler's all contract).
it('requires an explicit all-events choice before clearing the last filter', async () => {
  const picker = 'scheduler.editor.webhook.eventPicker';
  const form = mount(schedule({ manual: true, webhookTrigger: {
    endpointId: 'existing', events: ['issues.opened'], source: { preset: 'github' },
  } }));
  fireEvent.click(await screen.findByRole('button', { name: `${picker}.remove` }));
  expect(screen.getByRole('button', { name: `${picker}.apply` }).hasAttribute('disabled')).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: `${picker}.cancel` }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    webhookTrigger: { events: ['issues.opened'], source: { preset: 'github' } },
  }), true));
  fireEvent.click(screen.getByRole('button', { name: `${picker}.choose` }));
  fireEvent.click(screen.getByRole('checkbox', { name: `${picker}.all` }));
  fireEvent.click(screen.getByRole('button', { name: `${picker}.apply` }));
  form.save();
  await waitFor(() => expect(form.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    webhookTrigger: { events: [], source: { preset: 'github' } },
  }), true));
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
