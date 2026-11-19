// @vitest-environment jsdom
import { useState } from 'react';
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Session } from '@/lib/ccAgent.types';
import { useBulkSessionArchive } from '../useBulkSessionArchive';
import { discardDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import * as sessionService from '@/lib/sessionService';
const mocks = vi.hoisted(() => ({ confirm: vi.fn(), cleanupAttachments: vi.fn(), patchLocal: vi.fn(), navigate: vi.fn(), refresh: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sessionService', () => ({ resolveStatusWriteTarget: vi.fn(), setStatus: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/lib/worktreeRemovalWarning', () => ({ countDirtyWorktreesForRemoval: vi.fn(async () => 0) }));
vi.mock('@/features/scheduler/lib/archiveScheduleWarning', () => ({ archiveScheduleWarningMany: vi.fn(async () => '') }));
vi.mock('@/lib/toast', () => ({ toast: { warning: vi.fn(), success: vi.fn(), error: vi.fn() } }));
const session = (id: string) => ({ id, title: id, status: 'active' } as Session);
const draft = { text: plainTextToTiptapDoc('unsent selection text'), attachments: [{
  id: 'attachment', name: 'notes.txt', path: 'synthetic-9794-selection.bin', ext: 'txt', size: 5,
  category: 'text' as const, mimeType: 'text/plain',
}] };
function mount(sessions = [session('selected')], runningSessionIds = new Set<string>()) {
  return renderHook(() => {
    const [pending, setBulkActionPending] = useState<'archive' | 'delete' | null>(null);
    const [selected, setSelectedSessionIds] = useState(new Set(sessions.map(s => s.id)));
    const [anchor, setSelectionAnchorSessionId] = useState<string | null>('selected');
    const archive = useBulkSessionArchive({ bulkActionPending: pending, selectedSessions: sessions,
      runningSessionIds, confirmDialog: mocks.confirm, patchLocal: mocks.patchLocal,
      refreshSessions: mocks.refresh, viewedSessionId: 'selected', navigate: mocks.navigate,
      setBulkActionPending, setSelectedSessionIds, setSelectionAnchorSessionId });
    return { archive, selected, anchor, pending };
  });
}
beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    binding: { resolveSession: vi.fn(async () => ({ attached: false })) },
    cleanupStagedChatAttachments: mocks.cleanupAttachments.mockResolvedValue(undefined),
  } });
  for (const id of ['selected', 'other']) discardDraft(id);
  mocks.cleanupAttachments.mockClear();
  mocks.confirm.mockResolvedValue(true); mocks.refresh.mockResolvedValue(undefined);
  vi.mocked(sessionService.resolveStatusWriteTarget).mockResolvedValue({ kind: 'local' });
  vi.mocked(sessionService.setStatus).mockImplementation(async (id, status) => ({ ...session(id), status }));
});
afterEach(() => { for (const id of ['selected', 'other']) discardDraft(id); cleanup(); });
// #9794: exercise the exact callback used by SidebarUpper (extracted unchanged
// before the fix), real draft store; old source-count checks missed data loss.
// Unit. One selected draft with an attachment is the minimal failing input.
describe('sidebar multi-selection archive', () => {
  it.each(['local', 'device-link', 'cancel', 'failure'] as const)('keeps drafts on %s', async (mode) => {
    saveDraft('selected', draft);
    if (mode === 'device-link') vi.mocked(sessionService.resolveStatusWriteTarget).mockResolvedValue({ kind: 'device-link', deviceId: 'peer' });
    if (mode === 'cancel') mocks.confirm.mockResolvedValue(false);
    if (mode === 'failure') vi.mocked(sessionService.setStatus).mockRejectedValueOnce(new Error('write failed'));
    const { result } = mount();
    await act(async () => { await result.current.archive(); });
    expect(getDraft('selected')).toEqual(draft);
    expect(mocks.cleanupAttachments).not.toHaveBeenCalled();
    expect(result.current.pending).toBeNull();
    if (mode === 'cancel') expect(sessionService.setStatus).not.toHaveBeenCalled();
    else expect(sessionService.setStatus).toHaveBeenCalledWith('selected', 'archived',
      mode === 'device-link' ? { kind: 'device-link', deviceId: 'peer' } : { kind: 'local' });
    if (mode === 'local') expect(mocks.patchLocal).toHaveBeenCalledWith('selected', { status: 'archived', pinnedAt: null });
    else expect(mocks.patchLocal).not.toHaveBeenCalled();
    expect(result.current.selected.has('selected')).toBe(mode === 'cancel' || mode === 'failure');
    if (mode === 'local' || mode === 'device-link') expect(mocks.navigate).toHaveBeenCalledWith('/cc-agent');
    else expect(mocks.navigate).not.toHaveBeenCalled();
  });
  it('only clears successful selection rows after a partial write failure', async () => {
    saveDraft('selected', draft); saveDraft('other', draft);
    vi.mocked(sessionService.setStatus).mockRejectedValueOnce(new Error('write failed'));
    const { result } = mount([session('selected'), session('other')]);
    await act(async () => { await result.current.archive(); });
    expect([...result.current.selected]).toEqual(['selected']);
    expect(getDraft('selected')).toEqual(draft); expect(getDraft('other')).toEqual(draft);
    expect(mocks.cleanupAttachments).not.toHaveBeenCalled();
  });
  it('leaves a running selection untouched without confirmation or writes', async () => {
    saveDraft('selected', draft);
    const { result } = mount([session('selected')], new Set(['selected']));
    await act(async () => { await result.current.archive(); });
    expect(mocks.confirm).not.toHaveBeenCalled(); expect(sessionService.setStatus).not.toHaveBeenCalled();
    expect(getDraft('selected')).toEqual(draft);
  });
});
