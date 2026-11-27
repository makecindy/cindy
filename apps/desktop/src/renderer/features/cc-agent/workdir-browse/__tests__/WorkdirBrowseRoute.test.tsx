// @vitest-environment jsdom
import { act, cleanup, render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WorkdirBrowseRoute } from '../WorkdirBrowseRoute';
import { discardDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import { resetDirtyWorktreePreflightCache } from '@/lib/worktreeRemovalWarning';

const state = vi.hoisted(() => ({
  onClose: null as null | ((id: string, neighbor: string | null) => Promise<void>),
  confirm: vi.fn(), confirmWithCheckbox: vi.fn(), worktreeRemovalPreview: vi.fn(),
  setStatus: vi.fn(), navigate: vi.fn(), cleanupAttachments: vi.fn(),
  sessions: [{ id: 'file-task', title: 'file-task', status: 'active', workingDir: '/synthetic-project', workspaceKind: 'project' }],
  empty: [] as never[],
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => state.navigate, useParams: () => ({ sessionId: 'file-task' }), useSearchParams: () => [new URLSearchParams(), vi.fn()] }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/hooks/useCCSessions', () => ({ useCCSessions: () => ({ sessions: state.sessions, patchLocal: vi.fn(), refreshSessions: vi.fn() }) }));
vi.mock('@/lib/sessionService', () => ({ setStatus: state.setStatus }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { getRunningSnapshot: () => new Map(), closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: state.confirm, confirmWithCheckbox: state.confirmWithCheckbox, confirmThree: vi.fn() }) }));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), warning: vi.fn() } }));
vi.mock('@/features/scheduler/lib/archiveScheduleWarning', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/features/scheduler/lib/archiveScheduleWarning')>(),
  loadActiveBoundScheduleNames: vi.fn(async () => new Map()),
}));
vi.mock('@/hooks/useAgentIslandSettings', () => ({ isAgentIslandSupported: () => false }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ getSessionDeviceId: () => null, remoteProjectsStore: { subscribe: () => () => {}, getVisibleMergedRemoteSessions: () => state.empty } }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => null }));
vi.mock('@/features/cc-agent/CindyMakeSessionGate', () => ({ CindyMakeSessionGate: ({ children }: { children: ReactNode }) => children }));
vi.mock('@/features/cc-agent/OrcaSplitView', () => ({ OrcaSplitView: () => null }));
vi.mock('@/components/interaction-portal', () => ({ InteractionPromptSlot: () => null }));
vi.mock('../hooks/useFileContent', () => ({ useFileContent: () => ({ content: null, setLocal: vi.fn() }) }));
vi.mock('../hooks/useChatRailResize', () => ({ useChatRailResize: () => ({ width: 400 }) }));
vi.mock('../hooks/useChatRailCollapsed', () => ({ useChatRailCollapsed: () => ({ collapsed: false }) }));
vi.mock('../hooks/useConfirmSwitchAwayIfDirty', () => ({ useConfirmSwitchAwayIfDirty: () => vi.fn() }));
vi.mock('../FileBodyView', () => ({ FileBodyView: () => null }));
vi.mock('../FileTabsBar', () => ({ FileTabsBar: () => null }));
vi.mock('../SessionTabsBar', () => ({ SessionTabsBar: ({ onClose }: { onClose: typeof state.onClose }) => { state.onClose = onClose; return null; } }));
const draft = { text: plainTextToTiptapDoc('unsent file-view text'), attachments: [{
  id: 'attachment', name: 'notes.txt', path: 'synthetic-9794-files.bin', ext: 'txt', size: 5,
  category: 'text' as const, mimeType: 'text/plain',
}] };
beforeEach(() => {
  vi.clearAllMocks();
  resetDirtyWorktreePreflightCache();
  state.confirm.mockResolvedValue(true);
  state.confirmWithCheckbox.mockResolvedValue({ ok: true, checked: true });
  state.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: false, dirty: false });
  state.setStatus.mockResolvedValue({ status: 'archived' });
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    binding: { resolveSession: vi.fn(async () => ({ attached: false })) },
    worktreeRemovalPreview: state.worktreeRemovalPreview,
    cleanupStagedChatAttachments: state.cleanupAttachments.mockResolvedValue(undefined),
  } });
  discardDraft('file-task'); state.cleanupAttachments.mockClear(); state.onClose = null;
});
afterEach(() => { discardDraft('file-task'); cleanup(); });
// #9794: previous tests only scanned source. Render the real route and invoke
// the session tab's actual close callback. Unit; one draft is the minimum input.
// Unrelated file/chat views are stubs, composerDraftStore and callback are real.
describe('file-view session tab archive', () => {
  it.each(['archive', 'cancel', 'failure', 'archive-discard', 'cancel-discard', 'failure-discard'] as const)('keeps unsent content after %s', async (outcome) => {
    saveDraft('file-task', draft);
    const discard = outcome.endsWith('-discard');
    const cancelled = outcome.startsWith('cancel');
    if (discard) state.worktreeRemovalPreview.mockResolvedValue({ hasWorktree: true, dirty: true, canDiscardChanges: true });
    if (cancelled) {
      state.confirm.mockResolvedValue(false);
      state.confirmWithCheckbox.mockResolvedValue({ ok: false, checked: true });
    }
    if (outcome.startsWith('failure')) state.setStatus.mockRejectedValueOnce(new Error('write failed'));
    render(<WorkdirBrowseRoute />);
    expect(state.onClose).toBeTypeOf('function');
    await act(async () => { await state.onClose!('file-task', 'neighbor'); });
    expect(getDraft('file-task')).toEqual(draft);
    expect(state.cleanupAttachments).not.toHaveBeenCalled();
    if (discard) expect(state.confirmWithCheckbox).toHaveBeenCalledOnce();
    else expect(state.confirm).toHaveBeenCalledOnce();
    if (cancelled) expect(state.setStatus).not.toHaveBeenCalled();
    else if (discard) expect(state.setStatus).toHaveBeenCalledWith('file-task', 'archived', undefined, true);
    else expect(state.setStatus).toHaveBeenCalledWith('file-task', 'archived');
    if (outcome.startsWith('archive')) expect(state.navigate).toHaveBeenCalledWith('/cc-agent/files/neighbor', { replace: true });
    else expect(state.navigate).not.toHaveBeenCalled();
  });
});
