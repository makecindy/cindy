// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Schedule, ScheduleTemplate } from '@cindy/maker-scheduler';
import type { ProviderView } from '@cindy/model-providers';
import { __resetForTest as resetDraft } from '@/state/newMakerDraft';

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
  remoteCatalogStatus: 'ready' as 'ready' | 'unsupported' | 'error',
  localLoading: false,
  rosterLoading: false,
  rosterFailed: false,
  localCapabilities: {} as Record<string, { id: string; efforts: string[]; defaultEffort?: string }[]>,
  pendingCapabilities: new Set<string>(),
  hiddenModels: new Set<string>(),
  claudeModels: [] as { id: string; defaultEnabled: boolean; efforts: string[] }[],
  alternativeProviders: [] as ProviderView[],
  vendors: new Set(['cc', 'codex', 'pi']),
  localModels: [{ id: 'shared', efforts: ['low'], defaultEffort: 'low', supportsFastMode: false }] as {
    id: string; efforts: string[]; defaultEffort: string; supportsFastMode: boolean; defaultEnabled?: boolean;
  }[],
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
  useAgentCapabilities: (agent: string | null, device?: string) => ({
    capabilities: { availableModels: device && !state.loading ? state.remoteModels
      : state.localCapabilities[agent ?? ''] ?? state.localModels, hasFastMode: true },
    loading: device ? state.loading : !!agent && state.pendingCapabilities.has(agent),
  }),
}));
vi.mock('@/hooks/useAvailableAgents', () => ({
  useAvailableAgents: () => ({ availableVendors: state.vendors,
    loaded: !state.localLoading && !state.rosterLoading && !state.rosterFailed,
    loading: state.localLoading || state.rosterLoading }),
}));
vi.mock('@/hooks/useProviders', () => ({
  useProviders: () => ({ providers: [{ id: 'source', auth: { method: 'oauth' }, source: 'builtin', access: { kind: 'subscription' }, connected: true, agents: ['codex', 'claude-code'], routing: { codex: {}, 'claude-code': {} },
    models: { codex: state.localModels, 'claude-code': state.claudeModels } }, ...state.alternativeProviders], loading: state.localLoading }),
}));
vi.mock('@/state/modelVisibilityPrefs', () => ({
  useModelVisibilityVersion: () => state.hiddenModels.size,
  isModelEnabled: (_agent: string, _provider: string, model: { id: string; defaultEnabled?: boolean }) =>
    model.defaultEnabled !== false && !state.hiddenModels.has(model.id),
}));
vi.mock('@/hooks/useDeviceProviders', () => ({
  useDeviceProviders: () => ({ providers: state.remoteCatalogStatus === 'ready' ? [{ id: 'source', auth: { method: 'oauth' }, source: 'builtin', access: { kind: 'subscription' }, connected: true, agents: ['codex'], routing: { codex: {} },
    models: { codex: state.loading ? state.localModels : state.remoteModels } }] : [], loading: state.loading,
    unsupported: state.remoteCatalogStatus === 'unsupported',
    error: state.remoteCatalogStatus === 'ready' ? null : 'catalog unavailable' }),
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
  ModelEffortChip: ({ onSelect, ...selection }: { onSelect: (choice: unknown) => void }) => (
    <button data-testid="model-selection" data-selection={JSON.stringify(selection)} onClick={() => onSelect({ engine: 'codex', modelId: 'remote-only', providerId: 'source',
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
  state.hiddenModels.clear();
  state.claudeModels = [];
  state.alternativeProviders = [];
  state.localModels = [{ id: 'shared', efforts: ['low'], defaultEffort: 'low', supportsFastMode: false }];
  state.loading = false;
  state.remoteCatalogStatus = 'ready';
  state.localLoading = false;
  state.rosterLoading = false;
  state.rosterFailed = false;
  state.localCapabilities = {};
  state.pendingCapabilities.clear();
  state.vendors = new Set(['cc', 'codex', 'pi']);
  localStorage.clear();
  vi.stubGlobal('electronAPI', { maker: { schedule: {
    webhookReceiver: async () => 'cloud', scriptCapabilityStatus: async () => ({ statuses: [] }),
  } } });
  resetDraft();
});
afterEach(cleanup);
afterEach(() => vi.unstubAllGlobals());

// User-requested form grouping / unit: inactive tabs unmount their fields. Existing
// model tests do not protect configured options during a save from another tab.
it('preserves configured options across tab switches and saving from content', async () => {
  const expireAt = new Date(2027, 4, 1, 18, 30).getTime();
  const h = mount(
    schedule({
      expireAt,
      persistentSession: true,
      silentWhenIdle: true,
      notify: { desktop: true, feishu: true },
      preRunHook: { command: 'node check.mjs' },
    }),
  );
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.optionsTab' }));
  expect(screen.getByPlaceholderText('scheduler.editor.preRunHook.commandPlaceholder').getAttribute('value')).toBe('node check.mjs');
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.contentTab' }));
  fireEvent.change(screen.getByPlaceholderText('scheduler.editor.promptDialog.namePlaceholder'), {
    target: { value: 'Renamed' },
  });
  h.save();
  await waitFor(() =>
    expect(h.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        name: 'Renamed',
        expireAt,
        persistentSession: true,
        silentWhenIdle: true,
        notify: expect.objectContaining({ feishu: true }),
        preRunHook: expect.objectContaining({ command: 'node check.mjs' }),
      }),
      true,
    ),
  );
});

// Unit: the optional deadline popover must update and clear the saved deadline,
// including after leaving the content tab (the popover is then unmounted).
it('edits and clears a deadline through its compact picker', async () => {
  const h = mount(schedule());
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.deadline.label' }));
  const input = await screen.findByLabelText('scheduler.deadline.label', { selector: 'input' });
  fireEvent.change(input, { target: { value: '2027-05-02T09:15' } });
  fireEvent.keyDown(input, { key: 'Escape' });
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.optionsTab' }));
  h.save();
  await waitFor(() => expect(h.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({
    expireAt: new Date(2027, 4, 2, 9, 15).getTime(),
  }), true));
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.contentTab' }));
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.deadline.label' }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduler.deadline.clear' }));
  fireEvent.keyDown(screen.getByLabelText('scheduler.deadline.label', { selector: 'input' }), { key: 'Escape' });
  h.save();
  await waitFor(() => expect(h.onSubmit).toHaveBeenLastCalledWith(expect.objectContaining({ expireAt: null }), true));
});

// An invalid pre-run command on another tab must be reachable directly after Save fails.
it('selects the invalid tab and accepts its correction without losing the form', async () => {
  const h = mount(schedule({ preRunHook: { command: 'node check.mjs' } }));
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.optionsTab' }));
  fireEvent.change(await screen.findByPlaceholderText('scheduler.editor.preRunHook.commandPlaceholder'), { target: { value: '' } });
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.contentTab' }));
  h.save();
  expect(h.onSubmit).not.toHaveBeenCalled();
  expect(state.warning).toHaveBeenCalledWith(
    'scheduler.editor.validation.preRunHookCommandRequired',
  );
  const command = await screen.findByPlaceholderText(
    'scheduler.editor.preRunHook.commandPlaceholder',
  );
  fireEvent.change(command, { target: { value: 'node fixed.mjs' } });
  h.save();
  await waitFor(() =>
    expect(h.onSubmit).toHaveBeenCalledWith(
      expect.objectContaining({
        preRunHook: expect.objectContaining({ command: 'node fixed.mjs' }),
      }),
      true,
    ),
  );
});

// PR #8950 review: loaded=false also means a failed fail-open lookup. Previous
// fixtures coupled roster readiness to catalog readiness, missing this deadlock.
// Unit/jsdom: pending -> rejected roster, usable catalog, real form submission.
it('allows calibrated creation after a roster lookup fails, but waits while it is pending', async () => {
  state.rosterLoading = true;
  state.vendors = new Set();
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({ agentKind: 'codex',
    lastByAgent: { codex: { model: 'removed', providerId: 'source', effort: 'high' } },
  }));
  const onSubmit = vi.fn(async () => {});
  const initialValues = { name: 'New', prompt: 'Check work' };
  const element = () => <ScheduleFormDialog open initial={null} initialValues={initialValues}
    onOpenChange={() => {}} onSubmit={onSubmit} />;
  const view = render(element());
  const create = screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' });
  expect((create as HTMLButtonElement).disabled).toBe(true);
  state.rosterLoading = false;
  state.rosterFailed = true;
  view.rerender(element());
  expect((create as HTMLButtonElement).disabled).toBe(false);
  fireEvent.click(create);
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind: 'codex', model: 'shared', providerId: 'source', effort: 'low',
  }), false));
});

// PR #6830, unit/jsdom: a bound remote task must not hide an explicit local
// model-only selection from the real hook-generation IPC request.
it('sends the explicit local Harness and location when generating a bound hook', async () => {
  const generatePreRunHook = vi.fn(async () => ({ ok: false, reason: 'no_candidate', attempts: [] }));
  vi.stubGlobal('electronAPI', { maker: { schedule: { generatePreRunHook, webhookReceiver: async () => 'cloud' } } });
  state.references.set('bound', { id: 'bound', state: 'available', status: 'active', agentKind: 'claude-code', agentDeviceId: 'studio' });
  mount(schedule({ targetSessionId: 'bound', modelAgentKind: 'codex', modelAgentDeviceId: '', providerId: '',
    preRunHook: { command: 'node check.mjs' } }));
  fireEvent.click(screen.getByRole('tab', { name: 'scheduler.editor.layout.optionsTab' }));
  fireEvent.click(await screen.findByRole('button', { name: 'scheduler.editor.preRunHook.aiModify' }));
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

// PR #8950 P1: old peers explicitly lacking provider:list still expose model
// capabilities. Prior remote fixtures always returned a provider catalog.
// Unit/jsdom: real edit/save must accept a supported legacy model, while rejecting
// a missing capability or a modern catalog failure; saved routing stays unchanged.
it.each([
  { status: 'unsupported' as const, model: 'remote-only', saves: true },
  { status: 'unsupported' as const, model: 'removed', saves: false },
  { status: 'error' as const, model: 'remote-only', saves: false },
])('uses capabilities-only validation for legacy peers: $status / $model', async ({ status, model, saves }) => {
  state.remoteCatalogStatus = status;
  const form = mount(schedule({ agentDeviceId: 'studio', model, effort: 'ultra', fastMode: true }));
  fireEvent.change(screen.getByDisplayValue('Test'), { target: { value: 'Renamed automation' } });
  form.save();
  if (saves) {
    await waitFor(() => expect(form.onSubmit).toHaveBeenCalledWith(expect.objectContaining({
      name: 'Renamed automation', agentDeviceId: 'studio', model,
      providerId: 'source', effort: 'ultra', fastMode: true,
    }), true));
    expect(screen.queryByText('scheduler.editor.validation.modelUnavailable')).toBeNull();
  } else {
    expect(form.onSubmit).not.toHaveBeenCalled();
    expect(state.warning).toHaveBeenCalledWith('scheduler.editor.validation.modelUnavailable');
  }
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

// Reported stale automation default: real dialog effects must validate remembered
// engine/source/model together after loading. Existing tests only cover explicit
// remote selections. Minimal input: removed model or source, high effort vs low.
// Tier: unit/jsdom; assertions cover displayed selection and submitted values.
// Standalone final run: 4.10s Vitest, 384ms test execution (13 cases).
it.each([
  { agentKind: 'codex', model: 'removed', providerId: 'source' },
  { agentKind: 'codex', model: 'shared', providerId: 'removed-source' },
  { agentKind: 'pi', model: 'shared', providerId: 'source' },
])('calibrates stale new defaults after catalog loading: %j', async (remembered) => {
  state.localLoading = true;
  state.vendors = new Set(['codex']);
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({
    agentKind: remembered.agentKind,
    lastByAgent: { [remembered.agentKind]: { ...remembered, effort: 'high', fastMode: true } },
  }));
  const onSubmit = vi.fn(async (_input: unknown, _edit: boolean) => {});
  const initialValues = { name: 'New automation', prompt: 'Check work' };
  const element = () => <ScheduleFormDialog open initial={null} initialValues={initialValues}
    onOpenChange={() => {}} onSubmit={onSubmit} />;
  const view = render(element());
  expect(screen.getByTestId('model-selection').getAttribute('data-selection')).toContain(remembered.model);
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  expect(onSubmit).not.toHaveBeenCalled();
  state.localLoading = false;
  view.rerender(element());
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind: 'codex', model: 'shared', providerId: 'source',
  }), false));
  expect(onSubmit.mock.calls[0][0]).toMatchObject({ effort: 'low' });
});

it('preserves a saved invalid source and effort while showing the failure before save', () => {
  mount(schedule({ providerId: 'removed-source', effort: 'high', fastMode: true }));
  expect(screen.getByText('scheduler.editor.validation.modelUnavailable')).toBeTruthy();
  const selection = JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!);
  expect(selection).toMatchObject({ providerId: 'removed-source', modelValue: 'shared', effortValue: 'high' });
});

// PR #8950 P1: provider membership alone can pick a model rejected by the settled
// Harness capabilities. Earlier fixtures used identical catalog/capability lists.
// Unit/jsdom: exercise real default calibration and submit after capability loading.
// Standalone run: 26 cases, 5.12s Vitest / 634ms test execution.
it.each([true, false])('filters stale catalog defaults through capabilities (remembered=%s)', async (remembered) => {
  state.localModels.push({ id: 'supported', efforts: ['low'], defaultEffort: 'low', supportsFastMode: false });
  state.localCapabilities.codex = [{ id: 'shared', efforts: ['high'] }];
  state.pendingCapabilities.add('codex');
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({ agentKind: 'codex',
    lastByAgent: { codex: { model: remembered ? 'shared' : '', providerId: 'source', effort: 'high' } },
  }));
  const onSubmit = vi.fn(async () => {});
  const initialValues = { name: 'New', prompt: 'Check' };
  const element = () => <ScheduleFormDialog open initial={null} initialValues={initialValues}
    onOpenChange={() => {}} onSubmit={onSubmit} />;
  const view = render(element());
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  expect(onSubmit).not.toHaveBeenCalled();
  state.localCapabilities.codex = [{ id: 'supported', efforts: ['low'], defaultEffort: 'low' }];
  state.pendingCapabilities.clear();
  view.rerender(element());
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind: 'codex', model: 'supported', providerId: 'source', effort: 'low',
  }), false));
});

it.each([true, false])('tries another Agent when all preferred models lack capabilities (alternative=%s)', async (alternative) => {
  state.localCapabilities.codex = [];
  state.localCapabilities['claude-code'] = [{ id: 'claude-supported', efforts: ['low'] }];
  if (alternative) state.claudeModels = [{ id: 'claude-supported', defaultEnabled: true, efforts: ['low'] }];
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({ agentKind: 'codex',
    lastByAgent: { codex: { model: 'shared', providerId: 'source' } },
  }));
  const onSubmit = vi.fn(async () => {});
  render(<ScheduleFormDialog open initial={null} initialValues={{ name: 'New', prompt: 'Check' }}
    onOpenChange={() => {}} onSubmit={onSubmit} />);
  const selection = JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!);
  expect(selection).toMatchObject(alternative
    ? { agentKind: 'claude-code', modelValue: 'claude-supported' }
    : { modelValue: '' });
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  if (alternative) await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind: 'claude-code', model: 'claude-supported', providerId: 'source',
  }), false));
  else expect(onSubmit).not.toHaveBeenCalled();
});

it('clears an implicit default when no runtime is available, but preserves an explicit remote choice', () => {
  state.vendors = new Set();
  const onSubmit = vi.fn(async () => {});
  render(<ScheduleFormDialog open initial={null} initialValues={{ name: 'New', prompt: 'Check' }}
    onOpenChange={() => {}} onSubmit={onSubmit} />);
  expect(JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!)).toMatchObject({ modelValue: '' });
  expect(screen.getByText('scheduler.editor.validation.modelUnavailable')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.click(screen.getByText('select remote'));
  expect(JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!)).toMatchObject({
    modelValue: 'remote-only', effortValue: 'ultra', agentDeviceId: 'studio',
  });
});

// Acceptance caught a default-hidden Claude bridge selected outside the picker.
// Unit/jsdom: real create form, unlike prior fixtures where every model was visible.
it.each([false, true])('uses a visible route for a model-less template (user hidden=%s)', async (userHidden) => {
  state.claudeModels = [{ id: 'chatgpt/shared', defaultEnabled: userHidden, efforts: ['low'] }];
  if (userHidden) state.hiddenModels.add('chatgpt/shared');
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({agentKind:'claude-code',
    lastByAgent:{'claude-code':{model:'chatgpt/shared',providerId:'source',effort:'high'}}}));
  const onSubmit = vi.fn(async () => {});
  const initialTemplate: ScheduleTemplate = {id:'weekly',name:'Weekly',prompt:'Summarize work',
    description:'',category:'office-docs',source:'builtin',agentKind:'claude-code'};
  render(<ScheduleFormDialog open initial={null} initialTemplate={initialTemplate}
    onOpenChange={() => {}} onSubmit={onSubmit} />);
  expect(JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!)).toMatchObject({
    agentKind:'codex', modelValue:'shared', providerId:'source', effortValue:'low',
  });
  fireEvent.click(screen.getByRole('button', {name:'scheduler.editor.promptDialog.createAria'}));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind:'codex',model:'shared',providerId:'source',effort:'low',
  }),false));
});

// Review P1: history without a source passed visibility checks via B but was
// later resolved back to hidden source A. Prior fixtures had only one source.
// Unit/jsdom: real form submission must pin B and use B's effort capabilities.
it.each(['schedule', 'chat'])('pins the visible source for source-less %s history', async (history) => {
  state.localModels = [{ id: 'shared', defaultEnabled: false, efforts: ['high'], defaultEffort: 'high', supportsFastMode: false }];
  state.alternativeProviders = [{
    id: 'visible-source', name: 'Visible source', source: 'user', connected: true, agents: ['codex'],
    auth: { method: 'apiKey' }, routing: { codex: { upstream: 'https://example.test', authStrategy: 'api-key-header' } },
    models: { codex: [{ id: 'shared', name: 'Shared', contextWindow: 100000, defaultEnabled: true,
      efforts: ['low'], defaultEffort: 'low' }] },
  }];
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({ agentKind: 'codex',
    lastByAgent: { codex: { model: history === 'schedule' ? 'shared' : '', providerId: '', effort: 'high' } },
  }));
  if (history === 'chat') localStorage.setItem('xdt:newMakerDraft:v1', JSON.stringify({ vendor: 'codex',
    lastByVendor: { codex: { model: 'shared', providerId: '', effort: 'high' } }, modelChosenByVendor: { codex: true },
  }));
  const onSubmit = vi.fn(async () => {});
  render(<ScheduleFormDialog open initial={null} initialValues={{ name: 'New', prompt: 'Check work' }}
    onOpenChange={() => {}} onSubmit={onSubmit} />);
  expect(JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!)).toMatchObject({
    agentKind: 'codex', modelValue: 'shared', providerId: 'visible-source', effortValue: 'low',
  });
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith(expect.objectContaining({
    agentKind: 'codex', model: 'shared', providerId: 'visible-source', effort: 'low',
  }), false));
});

// Review P1: filtering a hidden Auto copy can resemble a catalog relocation.
// Unit/jsdom: a template's explicit source must still constrain the saved route.
it('does not relocate hidden Auto history outside a template source constraint', () => {
  state.localModels = [];
  state.alternativeProviders = ['xd', 'pool'].map((id): ProviderView => ({
    id, name: id, source: id === 'xd' ? 'builtin' : 'organization', connected: true, agents: ['codex'],
    auth: { method: 'managed' }, access: { kind: 'managed' },
    routing: { codex: { upstream: 'https://example.test', authStrategy: 'api-key-header' } },
    models: { codex: [{ id: 'auto/group-1', name: 'Auto', contextWindow: 100000,
      defaultEnabled: id === 'pool', efforts: [], defaultEffort: null }] },
  }));
  localStorage.setItem('xdt:scheduleFormPrefs:v1', JSON.stringify({ agentKind: 'codex',
    lastByAgent: { codex: { model: 'auto/group-1', providerId: 'xd' } },
  }));
  const initialTemplate: ScheduleTemplate = { id: 'pinned-source', name: 'Pinned', prompt: 'Check work',
    description: '', category: 'office-docs', source: 'builtin', agentKind: 'codex', providerId: 'xd' };
  const onSubmit = vi.fn(async () => {});
  render(<ScheduleFormDialog open initial={null} initialTemplate={initialTemplate}
    onOpenChange={() => {}} onSubmit={onSubmit} />);
  expect(JSON.parse(screen.getByTestId('model-selection').getAttribute('data-selection')!)).toMatchObject({
    modelValue: '', providerId: 'xd',
  });
  fireEvent.click(screen.getByRole('button', { name: 'scheduler.editor.promptDialog.createAria' }));
  expect(onSubmit).not.toHaveBeenCalled();
});
