// @vitest-environment jsdom
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  sessions: [] as Array<Record<string, unknown>>,
  running: false,
  hostAuto: true as boolean | 'error',
  bound: [] as string[] | null,
  draft: null as string | null,
  preview: { hasWorktree: true, dirty: false } as unknown,
  undo: vi.fn(),
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => true }));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: async () => {
    if (h.hostAuto === 'error') throw new Error('NOT_CONNECTED');
    return { blocks: [{ primitive: 'plugin-card-actions', data: { taskArchive: { auto: h.hostAuto } } }] };
  },
}));
vi.mock('@/session/archiveScheduleConfirm', () => ({ loadConfirmedActiveBoundScheduleNames: async () => h.bound }));
vi.mock('@/session/composerDraftStore', () => ({ readComposerDraft: async () => h.draft, readComposerDocumentDraft: async () => null }));
vi.mock('@/session/remoteSessionStore', () => ({
  remoteSessionStore: { getSessions: () => h.sessions, isSessionRunning: () => h.running },
}));
vi.mock('@/session/TaskArchiveUndoNotice', () => ({ showTaskArchiveUndo: (...args: unknown[]) => h.undo(...args) }));

import { taskAutoArchive } from '../plugins/taskAutoArchive';
import { useTaskAutoArchive } from '../session/useTaskAutoArchive';

(globalThis as Record<string, unknown>).IS_REACT_ACT_ENVIRONMENT = true;
afterEach(() => {
  taskAutoArchive.setArmed('s', 'card', false);
  Object.assign(h, { running: false, hostAuto: true, bound: [], draft: null, preview: { hasWorktree: true, dirty: false } });
  vi.clearAllMocks();
});

/** Opens the task page with the merged card on screen, then leaves it. Returns the archive writes. */
async function leaveAfterSeeing(): Promise<unknown[]> {
  const session = { id: 's', status: 'active', title: 'Fix login', source: 'cc' };
  h.sessions = [session];
  const patchSession = vi.fn(async (_s: unknown, patch: { status: string }) => { h.sessions = [{ ...session, status: patch.status }]; });
  const invoke = vi.fn(async (_d: string, channel: string) => {
    if (channel === 'worktree:removal-preview') return h.preview;
    throw new Error(`unexpected ${channel}`);
  });
  const Page = () => {
    useTaskAutoArchive({ session: session as never, deviceId: 'mac', invoke: invoke as never, enabled: true,
      historyLoaded: true, messages: [], archive: () => {}, patchSession: patchSession as never });
    return null;
  };
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Page)));
  taskAutoArchive.setArmed('s', 'card', true);
  taskAutoArchive.markSeen('s');
  await act(async () => root.unmount());
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  return patchSession.mock.calls.map(([, patch]) => patch);
}

describe('auto-archive when leaving the phone task page', () => {
  // Rule: same leave-time conditions as Desktop (useGhostCardTaskArchive); the phone had no auto-archive at all.
  it('archives silently and offers undo once the host still allows it and nothing would be lost', async () => {
    expect(await leaveAfterSeeing()).toEqual([{ status: 'archived' }]);
    expect(h.undo).toHaveBeenCalledWith('Fix login', expect.any(Function));
    // Undo restores the task.
    h.undo.mock.calls[0][1]();
    expect(h.sessions[0].status).toBe('active');
  });

  it.each([
    ['the host no longer allows it (another PR reopened, IM took over)', () => { h.hostAuto = false; }],
    ['the card cannot be read again', () => { h.hostAuto = 'error'; }],
    ['bound automations are unconfirmed', () => { h.bound = null; }],
    ['an automation is bound', () => { h.bound = ['Daily']; }],
    ['the composer has a draft', () => { h.draft = 'half a reply'; }],
    ['the worktree is dirty', () => { h.preview = { hasWorktree: true, dirty: true }; }],
    ['the worktree check fails', () => { h.preview = null; }],
    ['the task is running', () => { h.running = true; }],
  ])('keeps the task when %s', async (_case, arrange) => {
    arrange();
    expect(await leaveAfterSeeing()).toEqual([]);
    expect(h.undo).not.toHaveBeenCalled();
  });
});
