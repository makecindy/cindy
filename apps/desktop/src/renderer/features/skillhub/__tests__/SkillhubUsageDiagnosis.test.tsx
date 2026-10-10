// @vitest-environment jsdom
import path from 'node:path';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { AGENT_OPTIONS } from '@/components/new-chat/agentOptions';
import type { ProviderView } from '@cindy/model-providers';

const state = vi.hoisted(() => {
  const prefs = () => ({ model: 'selected', providerId: 'byom', effort: 'high', permissionMode: 'ask', planMode: true });
  return {
    available: new Set(['cc', 'codex', 'pi']), loaded: true, providers: [] as ProviderView[],
    providersLoading: false, capabilitiesLoading: false,
    capabilitiesError: null as string | null, providersFailed: false, refetch: vi.fn(),
    draft: { vendor: 'pi', lastByVendor: { cc: prefs(), codex: prefs(), pi: prefs(), orca: prefs() },
      modelChosenByVendor: { cc: true, codex: true, pi: true, orca: true } },
    createSession: vi.fn(), context: vi.fn(), summary: vi.fn(), saveDraft: vi.fn(), toastError: vi.fn(),
    plainTextToTiptapDoc: vi.fn((text: string) => ({ text })), refreshComparison: vi.fn(),
  };
});
vi.mock('react-i18next', () => ({ useTranslation: () => ({ i18n: { resolvedLanguage: 'en', language: 'en' }, t: (key: string, opts?: Record<string, unknown>) =>
  key === 'newChat.agentSelect.trigger.aria' ? `engine:${opts?.agent}` : key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' } }) }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ createSession: state.createSession }) }));
vi.mock('@/hooks/useAvailableAgents', () => ({ useAvailableAgents: () => ({ availableVendors: state.available, loaded: state.loaded }) }));
vi.mock('@/hooks/useProviders', () => ({ useProviders: () => ({ providers: state.providers, loading: state.providersLoading,
  loadFailed: state.providersFailed, refetch: state.refetch }) }));
vi.mock('@/hooks/useAgentCapabilities', () => ({ useAgentCapabilities: () => ({
  capabilities: state.capabilitiesError ? null : { hasFastMode: true }, loading: state.capabilitiesLoading,
  error: state.capabilitiesError,
}) }));
vi.mock('@/state/newMakerDraft', () => ({ getDraft: () => state.draft, getFastModeForModel: () => false }));
vi.mock('@/state/providerModelMemory', () => ({ getProviderModelEffort: () => 'low', getProviderModelFast: () => true }));
vi.mock('@/lib/composerDraftStore', () => ({ saveDraft: state.saveDraft, plainTextToTiptapDoc: state.plainTextToTiptapDoc }));
vi.mock('@/lib/toast', () => ({ toast: { error: state.toastError } }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({ MarkdownRenderer: () => null }));
vi.mock('@/components/markdown/PlaintextEditor', () => ({ PlaintextEditor: () => null }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => vi.fn() }));
vi.mock('@/components/ui/morph-popover', () => ({ MorphPopover: () => { throw new Error('Dialog must use the Radix selector'); } }));
vi.mock('../hooks/useSkillhubIdentityPolicy', () => ({ useSkillhubIdentityPolicy: () => ({ canWrite: true }) }));
vi.mock('../hooks/useSkillhub', () => ({ useSkillhub: () => ({ skills: [], bootstrapped: true, loading: false }),
  refresh: vi.fn(), clearHistory: vi.fn(), clearLastEntryId: vi.fn(), setLastEntryId: vi.fn() }));
vi.mock('../hooks/useMetaColumnResize', () => ({ useMetaColumnResize: () => ({ width: 280, isDragging: false }) }));
vi.mock('../hooks/useSkillFolderHash', () => ({ useSkillFolderHash: () => ({ folderHash: null, loading: false }), invalidateHash: vi.fn() }));
vi.mock('../hooks/useSkillPublishComparison', () => ({ useSkillPublishComparison: () => ({ comparison: { status: 'not-owner' }, refresh: state.refreshComparison }) }));
vi.mock('../lib/infoDedupe', () => ({ getCachedInfo: () => null, refreshInfo: async () => null,
  invalidate: vi.fn(), isMarketDeleted: () => false }));
vi.mock('../hooks/useRejectionFeedback', () => ({ usePublicationFeedback: () => ({ result: null, setResult: vi.fn() }),
  useRejectionFeedback: () => ({ result: null, dismiss: vi.fn(), open: vi.fn() }) }));
vi.mock('../PublishDialog', () => ({ PublishDialog: () => null }));
vi.mock('../ScanResultDialog', () => ({ ScanResultDialog: () => null }));
vi.mock('../SkillhubDiffPanel', () => ({ SkillhubDiffPanel: () => null }));
vi.mock('../components/LocalSkillControls', () => ({ LocalSkillControls: () => null }));

import { DiagnosisAgentPickerDialog, SkillhubDetailView } from '../SkillhubDetailView';

const skillDirectory = (name: string) => path.resolve('test-skills', name);
const entry = (name = 'demo'): SkillhubSkill => ({ id: name, name, kind: 'skill', engine: 'pi', scope: 'global',
  sourceKey: 'pi', urlKey: name, registryEntry: null,
  absolutePath: skillDirectory(name), mdPath: path.join(skillDirectory(name), 'SKILL.md'), files: [], linkedEngines: [],
} as SkillhubSkill);
const summary: SkillUsageSummary = {
  skillName: 'demo', currentDocumentHash: null, totalUseCount: 1, currentDocumentVersionUseCount: 0,
  unversionedUseCount: 1, documentVersionCoverageRate: 0, latestSeenAt: null,
  agentBreakdown: { claude: 0, codex: 0, pi: 1 }, sourceBreakdown: { strongActive: 1, semiActive: 0, passive: 0 },
  readObservation: { fileReadCount: 0, sessionsWithFileRead: 0, averageFileReadsPerSession: 0,
    extraFileReadCount: 0, shortWindowRereadSessionCount: 0, shortWindowRereadRate: null },
  currentDocumentSize: null, documentVersions: [], currentDocumentVersion: null, trend: [],
};
const completedRefreshStatus: SkillUsageRefreshStatus = {
  phase: 'complete', scanned: 1, total: 1, lastSuccessAt: 1_700_000_000_000,
  hasSnapshot: true, incomplete: false, missingCount: 0, error: null,
};
type ContextResult = { success: true; context: { prompt: string; summary: SkillUsageSummary }; refreshStatus: SkillUsageRefreshStatus };
function Location() { const location = useLocation(); return <span data-testid="location">{location.pathname}</span>; }
function Page({ skill = entry() }: { skill?: SkillhubSkill }) {
  return <MemoryRouter initialEntries={['/skillhub/detail']}><Location /><SkillhubDetailView entryOverride={skill} /></MemoryRouter>;
}
function pending<T>() {
  let resolve!: (result: T) => void;
  return { promise: new Promise<T>((done) => { resolve = done; }), resolve: (result: T) => resolve(result) };
}
async function openPicker() { fireEvent.click(await screen.findByRole('button', { name: 'skillhub.detail.usageDiagnose' })); }

beforeEach(() => {
  setDataOwnerGeneration('owner', 1);
  state.available = new Set(['cc', 'codex', 'pi']); state.loaded = true;
  state.providersLoading = false; state.capabilitiesLoading = false; state.draft.vendor = 'pi';
  state.capabilitiesError = null; state.providersFailed = false; state.refetch.mockReset().mockResolvedValue(true);
  state.providers = [{ id: 'byom', source: 'user', connected: true, agents: ['claude-code', 'codex', 'pi'],
    routing: Object.fromEntries(['claude-code', 'codex', 'pi'].map((agent) => [agent, { upstream: 'https://example.test', authStrategy: 'none' }])),
    models: Object.fromEntries(['claude-code', 'codex', 'pi'].map((agent) => [agent, [{ id: 'selected', name: 'Selected', status: 'active',
      group: 'test', contextWindow: 100_000, efforts: ['low', 'high'], defaultEffort: 'low', supportsFastMode: true }]])),
  } as unknown as ProviderView];
  state.createSession.mockReset().mockResolvedValue({ id: 'diagnosis' });
  state.context.mockReset().mockResolvedValue({ success: true, context: { prompt: 'diagnose this Skill', summary }, refreshStatus: completedRefreshStatus });
  state.summary.mockReset().mockResolvedValue({ success: true, summary, refreshing: false, refreshStatus: completedRefreshStatus });
  state.saveDraft.mockReset(); state.toastError.mockReset(); state.plainTextToTiptapDoc.mockClear();
  vi.stubGlobal('electronAPI', { skillhub: {
    getUsageDiagnosisContext: state.context, getUsageSummary: state.summary,
    onUsageAnalyticsRefreshed: () => () => {}, onPublishProgress: () => () => {},
    listChildren: async () => ({ success: true, entries: [] }), readSkill: async () => ({ success: true, content: '' }),
  } });
});
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

describe('diagnosis picker', () => {
  it('uses the standard field selector, official agents and an elevated Radix menu; selecting does not create', async () => {
    const onAgentChange = vi.fn(); const onCreate = vi.fn();
    render(<DiagnosisAgentPickerDialog open loading={false} agentKind="pi" hiddenVendors={[]} createDisabled={false}
      onOpenChange={vi.fn()} onAgentChange={onAgentChange} onCreate={onCreate} />);
    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('modal-panel');
    const trigger = screen.getByRole('button', { name: 'engine:Pi' });
    await waitFor(() => expect(document.activeElement).toBe(trigger));
    fireEvent.click(trigger);
    expect(screen.getAllByRole('option').map((option) => option.textContent)).toEqual(AGENT_OPTIONS.map((agent) => agent.label));
    expect(screen.getByRole('listbox').closest('[data-radix-popper-content-wrapper]')?.firstElementChild?.className).toContain('z-[10001]');
    await waitFor(() => expect(document.activeElement).toBe(screen.getByTestId('agent-select-option-pi')));
    fireEvent.click(screen.getByTestId('agent-select-option-codex'));
    expect(onAgentChange).toHaveBeenCalledWith('codex'); expect(onCreate).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it('allows Cancel and Escape while idle and blocks both during creation', async () => {
    const onOpenChange = vi.fn();
    const props = { open: true, loading: false, agentKind: 'cc' as const, hiddenVendors: [], createDisabled: false,
      onOpenChange, onAgentChange: vi.fn(), onCreate: vi.fn() };
    const view = render(<DiagnosisAgentPickerDialog {...props} />);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCancel' }));
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onOpenChange).toHaveBeenCalledTimes(2);
    onOpenChange.mockClear(); view.rerender(<DiagnosisAgentPickerDialog {...props} loading />);
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCancel' }));
    expect(onOpenChange).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', true);
  });
});

describe('diagnosis draft creation', () => {
  it('shows zero usage only for a completed snapshot and keeps its diagnosis entry hidden', async () => {
    state.summary.mockResolvedValue({ success: true, summary: { ...summary, totalUseCount: 0 }, refreshing: false,
      refreshStatus: completedRefreshStatus });
    render(<Page />);
    await screen.findByText('skillhub.detail.usageEmpty');
    expect(screen.queryByRole('button', { name: 'skillhub.detail.usageDiagnose' })).toBeNull();
  });

  it('keeps diagnosis available after a summary request fails', async () => {
    state.summary.mockRejectedValue(new Error('unavailable'));
    render(<Page />);
    await screen.findByText('skillhub.detail.usageFailed');
    expect(screen.queryByText('skillhub.detail.usageEmpty')).toBeNull();
    await openPicker();
    expect(screen.getByRole('dialog')).toBeTruthy();
  });

  it.each(AGENT_OPTIONS.map((agent) => [agent.vendor, agent.label] as const))('creates a local %s task with normal preferences and fills an unsent draft', async (vendor, label) => {
    state.draft.vendor = vendor;
    const originalDraft = structuredClone(state.draft);
    render(<Page />); await openPicker();
    expect(screen.getByRole('button', { name: `engine:${label}` })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await waitFor(() => expect(state.saveDraft).toHaveBeenCalled());
    expect(state.createSession).toHaveBeenCalledExactlyOnceWith({ agentKind: vendor, workingDir: skillDirectory('demo'), workspaceKind: 'project',
      model: 'selected', providerId: 'byom', effort: 'low', permissionMode: 'ask', planModeEnabled: true, fastMode: true });
    expect(state.saveDraft).toHaveBeenCalledWith('diagnosis', { text: { text: 'diagnose this Skill' }, attachments: [] });
    await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/cc-agent/diagnosis'));
    expect(state.draft).toEqual(originalDraft);
  });

  it('locally falls back from unavailable or Orca engines and disables creation while config is loading', async () => {
    state.available = new Set(['pi']); state.draft.vendor = 'orca'; state.providersLoading = true;
    const view = render(<Page />); await openPicker();
    expect(screen.getByRole('button', { name: 'engine:Pi' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', true);
    state.providersLoading = false; view.rerender(<Page />);
    fireEvent.click(screen.getByRole('button', { name: 'engine:Pi' }));
    expect(screen.getAllByRole('option')).toHaveLength(1);
    expect(state.draft.vendor).toBe('orca');
  });

  it.each(['capabilities', 'providers'] as const)('explains %s failures and retries the shared configuration', async (source) => {
    if (source === 'capabilities') state.capabilitiesError = 'network error';
    else { state.providersLoading = true; state.providersFailed = true; }
    const view = render(<Page />); await openPicker();
    expect(screen.getByRole('alert').textContent).toContain('skillhub.detail.usageDiagnosisConfigFailed');
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', true);
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisRetry' }));
    await waitFor(() => expect(state.refetch).toHaveBeenCalledTimes(1));
    state.capabilitiesError = null; state.providersFailed = false; state.providersLoading = false;
    view.rerender(<Page />);
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', false);
  });

  it('allows cancelling the index wait and ignores its delayed result', async () => {
    const context = pending<ContextResult>();
    state.context.mockReturnValue(context.promise);
    render(<Page />); await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCancel' }));
    await act(async () => { context.resolve({ success: true, context: { prompt: 'cancelled', summary }, refreshStatus: completedRefreshStatus }); });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.saveDraft).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('waits for the initial snapshot with progress before creating', async () => {
    const refreshStatus: SkillUsageRefreshStatus = { phase: 'indexing', scanned: 1, total: 2,
      lastSuccessAt: null, hasSnapshot: false, incomplete: false, missingCount: 0, error: null };
    state.summary.mockResolvedValue({ success: true, summary: { ...summary, totalUseCount: 0 }, refreshing: true, refreshStatus });
    state.context.mockResolvedValueOnce({ success: true, context: { prompt: 'not ready', summary }, refreshStatus })
      .mockResolvedValueOnce({ success: true, context: { prompt: 'ready', summary },
        refreshStatus: { ...refreshStatus, phase: 'complete', hasSnapshot: true, scanned: 2, lastSuccessAt: Date.now() } });
    render(<Page />);
    await screen.findByText('skillhub.detail.usageLoading');
    expect(screen.queryByText('skillhub.detail.usageEmpty')).toBeNull();
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await screen.findByText('skillhub.detail.usageDiagnosisIndexing');
    expect(state.createSession).not.toHaveBeenCalled();
    await waitFor(() => expect(state.saveDraft).toHaveBeenCalled(), { timeout: 2_000 });
    expect(state.plainTextToTiptapDoc).toHaveBeenCalledWith('ready');
  });

  it('does not create a diagnosis when the initial scan completes with zero usage', async () => {
    const emptySummary = { ...summary, totalUseCount: 0 };
    const refreshStatus: SkillUsageRefreshStatus = { ...completedRefreshStatus, phase: 'indexing',
      hasSnapshot: false, lastSuccessAt: null };
    state.summary.mockResolvedValue({ success: true, summary: emptySummary, refreshing: true, refreshStatus });
    state.context.mockResolvedValueOnce({ success: true, context: { prompt: 'pending', summary: emptySummary }, refreshStatus })
      .mockResolvedValueOnce({ success: true, context: { prompt: 'no usage', summary: emptySummary }, refreshStatus: completedRefreshStatus });
    render(<Page />);
    await screen.findByText('skillhub.detail.usageLoading');
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await screen.findByText('skillhub.detail.usageDiagnosisIndexing');
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('skillhub.detail.usageEmpty'), { timeout: 2_000 });
    expect(state.createSession).not.toHaveBeenCalled();
    expect(state.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/skillhub/detail');
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', false);
  });

  it('uses a disclosed existing snapshot while its background refresh continues', async () => {
    state.summary.mockResolvedValue({ success: true, summary, refreshing: true,
      refreshStatus: { ...completedRefreshStatus, phase: 'indexing', scanned: 1, total: 2 } });
    state.context.mockResolvedValue({ success: true, context: { prompt: 'snapshot with freshness', summary },
      refreshStatus: { phase: 'indexing', scanned: 1, total: 2, lastSuccessAt: Date.now(), hasSnapshot: true,
        incomplete: false, missingCount: 0, error: null } });
    render(<Page />);
    await screen.findByText('skillhub.detail.usageTotalCount');
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnose' })).toHaveProperty('disabled', false);
    await openPicker();
    expect(screen.getByText('skillhub.detail.usageDiagnosisSnapshotNotice')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await waitFor(() => expect(state.saveDraft).toHaveBeenCalled());
    expect(state.context).toHaveBeenCalledTimes(1);
  });

  it('keeps the picker retryable when an initial refresh fails without a snapshot', async () => {
    state.summary.mockResolvedValue({ success: true, summary: { ...summary, totalUseCount: 0 }, refreshing: false,
      refreshStatus: { ...completedRefreshStatus, phase: 'incomplete', hasSnapshot: false, lastSuccessAt: null,
        incomplete: true, error: 'read_failed' } });
    state.context.mockResolvedValue({ success: true, context: { prompt: 'not ready', summary },
      refreshStatus: { phase: 'incomplete', scanned: 1, total: 2, lastSuccessAt: null, hasSnapshot: false,
        incomplete: true, missingCount: 0, error: 'read_failed' } });
    render(<Page />);
    await screen.findByText('skillhub.detail.usageDiagnosisRefreshFailed');
    expect(screen.queryByText('skillhub.detail.usageEmpty')).toBeNull();
    await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledWith('skillhub.detail.usageDiagnosisRefreshFailed'));
    expect(state.createSession).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', false);
  });

  it('locks duplicate creation synchronously and freezes preferences before awaiting context', async () => {
    const context = pending<ContextResult>(); state.context.mockReturnValue(context.promise);
    render(<Page />); await openPicker();
    const button = screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' });
    act(() => { button.click(); button.click(); });
    expect(state.context).toHaveBeenCalledTimes(1);
    const previous = state.draft.lastByVendor.pi.model;
    state.draft.lastByVendor.pi.model = 'changed-while-awaiting';
    await act(async () => { context.resolve({ success: true, context: { prompt: 'frozen request', summary }, refreshStatus: completedRefreshStatus }); });
    expect(state.createSession).toHaveBeenCalledTimes(1);
    expect(state.createSession.mock.calls[0]?.[0].model).toBe('selected');
    state.draft.lastByVendor.pi.model = previous;
  });

  it.each(['owner', 'entry', 'unmount'] as const)('discards context after the %s changes', async (change) => {
    const context = pending<ContextResult>(); state.context.mockReturnValue(context.promise);
    const view = render(<Page />); await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    if (change === 'owner') setDataOwnerGeneration('other', 2);
    if (change === 'entry') view.rerender(<Page skill={entry('other')} />);
    if (change === 'unmount') view.unmount();
    await act(async () => { context.resolve({ success: true, context: { prompt: 'stale', summary }, refreshStatus: completedRefreshStatus }); });
    expect(state.createSession).not.toHaveBeenCalled(); expect(state.saveDraft).not.toHaveBeenCalled();
  });

  it.each(['owner', 'entry'] as const)('does not save or navigate after %s changes during session creation', async (change) => {
    const session = pending<{ id: string }>(); state.createSession.mockReturnValue(session.promise);
    const view = render(<Page />); await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await waitFor(() => expect(state.createSession).toHaveBeenCalledTimes(1));
    if (change === 'owner') setDataOwnerGeneration('other', 2);
    else view.rerender(<Page skill={entry('other')} />);
    await act(async () => { session.resolve({ id: 'old-owner-session' }); });
    expect(state.saveDraft).not.toHaveBeenCalled();
    expect(screen.getByTestId('location').textContent).toBe('/skillhub/detail');
  });

  it.each(['context', 'create'] as const)('keeps the picker retryable after %s failure', async (failure) => {
    if (failure === 'context') state.context.mockResolvedValueOnce({ success: false, error: 'failed' });
    else state.createSession.mockResolvedValueOnce(null);
    render(<Page />); await openPicker();
    fireEvent.click(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' }));
    await waitFor(() => expect(state.toastError).toHaveBeenCalledTimes(1));
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'skillhub.detail.usageDiagnosisCreate' })).toHaveProperty('disabled', false);
    expect(state.saveDraft).not.toHaveBeenCalled();
  });
});
