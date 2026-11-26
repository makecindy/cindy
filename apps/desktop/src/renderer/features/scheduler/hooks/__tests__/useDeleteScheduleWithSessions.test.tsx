// @vitest-environment jsdom
import { act, cleanup, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useDeleteScheduleWithSessions } from '../useDeleteScheduleWithSessions';
import { discardDraft, getDraft, plainTextToTiptapDoc, saveDraft } from '@/lib/composerDraftStore';
import * as sessionService from '@/lib/sessionService';
import { toast } from '@/lib/toast';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/sessionService', () => ({ update: vi.fn() }));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { closeSessionQuery: vi.fn(), purgeSession: vi.fn() } }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), error: vi.fn() } }));
const cleanupAttachments = vi.fn();
const deleteSchedule = vi.fn();
// Opaque IPC fixture: no file exists or is deleted at this path.
const stagedPath = 'synthetic-9794-schedule.bin';
const draft = { text: plainTextToTiptapDoc('unsent schedule text'), attachments: [{
  id: 'attachment', name: 'notes.txt', path: stagedPath, ext: 'txt', size: 5,
  category: 'text' as const, mimeType: 'text/plain',
}] };

beforeEach(() => {
  vi.clearAllMocks();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    cleanupStagedChatAttachments: cleanupAttachments.mockResolvedValue(undefined),
    cleanupSessionImages: vi.fn(async () => undefined),
    maker: { schedule: {
      list: vi.fn(async () => []), listRuns: vi.fn(async () => [{ sessionId: 'generated' }]),
      getInflightCount: vi.fn(async () => 0), delete: deleteSchedule.mockResolvedValue(undefined),
    } },
  } });
  discardDraft('generated');
  cleanupAttachments.mockClear();
  vi.mocked(sessionService.update).mockResolvedValue(undefined as never);
});
afterEach(() => { discardDraft('generated'); cleanup(); });

// Issue 9794: the existing source-text guard never executed this hook's confirm path.
// Unit, real composerDraftStore; one generated task with text + staged attachment
// is the minimal failure input. Exercise the real returned dialog callbacks,
// not a duplicate of the disposition algorithm or a fake draft store.
describe('deleting automation with generated drafts', () => {
  it.each(['archive', 'delete', 'keep', 'failed archive'] as const)(
    'preserves drafts except on confirmed session deletion: %s', async (choice) => {
      saveDraft('generated', draft);
      const onDeleted = vi.fn();
      const { result } = renderHook(() => useDeleteScheduleWithSessions({ onDeleted }));
      await act(async () => { result.current.requestDeleteSchedule({ id: 'schedule', name: 'test' }); });
      const disposition = choice === 'failed archive' ? 'archive' : choice;
      await act(async () => { result.current.deleteScheduleDialog.props.onDispositionChange(disposition); });
      if (choice === 'failed archive') vi.mocked(sessionService.update).mockRejectedValueOnce(new Error('write failed'));
      await act(async () => { await result.current.deleteScheduleDialog.props.onConfirm(); });
      expect(deleteSchedule).toHaveBeenCalledWith('schedule');
      expect(onDeleted).toHaveBeenCalledWith(expect.objectContaining({
        disposition, failedSessionIds: choice === 'failed archive' ? ['generated'] : [],
      }));
      if (choice === 'delete') {
        expect(getDraft('generated')).toBeUndefined();
        expect(cleanupAttachments).toHaveBeenCalledWith([stagedPath]);
      } else {
        expect(getDraft('generated')).toEqual(draft);
        expect(cleanupAttachments).not.toHaveBeenCalled();
      }
      if (disposition === 'keep') expect(sessionService.update).not.toHaveBeenCalled();
      else expect(sessionService.update).toHaveBeenCalledWith('generated',
        disposition === 'archive' ? { status: 'archived', pinnedAt: null } : { status: 'deleted' });
    },
  );
  // Review #12717: a schedule failure must not hide session failures in other deleted
  // automations. Minimal input: 2 targets, first deletes but its archive fails, second's
  // delete fails. Unit tier, real hook confirm path.
  it('reports both schedule and session failures in a mixed batch', async () => {
    deleteSchedule.mockResolvedValueOnce(undefined).mockRejectedValueOnce(new Error('gone'));
    vi.mocked(sessionService.update).mockRejectedValueOnce(new Error('write failed'));
    const { result } = renderHook(() => useDeleteScheduleWithSessions());
    await act(async () => { result.current.requestDeleteSchedules([
      { id: 'a', name: 'a', targetSessionId: null }, { id: 'b', name: 'b', targetSessionId: null },
    ]); });
    await act(async () => { result.current.deleteScheduleDialog.props.onDispositionChange('archive'); });
    await act(async () => { await result.current.deleteScheduleDialog.props.onConfirm(); });
    expect(toast.error).toHaveBeenCalledWith('scheduler.deleteDialog.batchPartial');
    expect(toast.error).toHaveBeenCalledWith('scheduler.deleteDialog.sessionUpdatePartial');
    expect(toast.success).not.toHaveBeenCalled();
  });
  // Review #12717: a failed run read must surface as unknown, not as a complete 0.
  // One batch: list() read once, one listRuns failure -> failed count, not total.
  it('preview keeps failed reads unknown and lists schedules once per batch', async () => {
    const api = (window as unknown as { electronAPI: { maker: { schedule: Record<string, ReturnType<typeof vi.fn>> } } })
      .electronAPI.maker.schedule;
    api.listRuns.mockRejectedValueOnce(new Error('read failed'));
    const { result } = renderHook(() => useDeleteScheduleWithSessions());
    await act(async () => { result.current.requestDeleteSchedules([
      { id: 'a', name: 'a' }, { id: 'b', name: 'b' }, { id: 'c', name: 'c' },
    ]); });
    expect(api.list).toHaveBeenCalledTimes(1);
    expect(result.current.deleteScheduleDialog.props.sessionCount).toEqual({ known: 2, failed: 1 });
  });
  it('cancel leaves the automation and draft intact', async () => {
    saveDraft('generated', draft);
    const { result } = renderHook(() => useDeleteScheduleWithSessions());
    await act(async () => { result.current.requestDeleteSchedule({ id: 'schedule', name: 'test' }); });
    await act(async () => { result.current.deleteScheduleDialog.props.onCancel(); });
    expect(getDraft('generated')).toEqual(draft);
    expect(deleteSchedule).not.toHaveBeenCalled();
    expect(cleanupAttachments).not.toHaveBeenCalled();
  });
});
