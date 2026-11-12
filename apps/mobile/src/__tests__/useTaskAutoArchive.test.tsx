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
  focused: true,
  pathname: '/sessions/s',
  gate: null as Promise<void> | null,
}));
vi.mock('expo-router', () => ({ useIsFocused: () => h.focused, usePathname: () => h.pathname }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/auth/authOwnerGeneration', () => ({ getMobileAuthOwner: () => ({}), isMobileAuthOwnerCurrent: () => true }));
vi.mock('@/device-link/remoteResources', () => ({
  getRemoteResource: async () => {
    await h.gate;
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
  Object.assign(h, { focused: true, pathname: '/sessions/s', gate: null, running: false, hostAuto: true, bound: [], draft: null, preview: { hasWorktree: true, dirty: false } });
  vi.clearAllMocks();
});

const patches: Array<{ session: Record<string, unknown>; patch: { status: string } }> = [];
const session = { id: 's', status: 'active', title: 'Fix login', source: 'cc', deviceLinkDeviceId: 'mac' };

/** Like the real list transaction: an archived task leaves the phone's active list. */
const patchSession = vi.fn(async (target: Record<string, unknown>, patch: { status: string }) => {
  patches.push({ session: target, patch });
  h.sessions = patch.status === 'active' ? [{ ...target, status: 'active' }] : [];
});
const invoke = vi.fn(async (_d: string, channel: string) => {
  if (channel === 'worktree:removal-preview') return h.preview;
  throw new Error(`unexpected ${channel}`);
});
const Page = ({ id, messages = [] }: { id: string; messages?: unknown[] }) => {
  useTaskAutoArchive({ session: { ...session, id } as never, deviceId: 'mac', invoke: invoke as never, enabled: true,
    historyLoaded: true, messages: messages as never, archive: () => {}, patchSession: patchSession as never });
  return null;
};
const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });

/** Opens the task page with the merged card on screen, then leaves it. Returns the archive writes. */
async function leaveAfterSeeing(): Promise<unknown[]> {
  patches.length = 0;
  h.sessions = [session];
  const root = createRoot(document.createElement('div'));
  await act(async () => root.render(createElement(Page, { id: 's' })));
  taskAutoArchive.setArmed('s', 'card', true);
  taskAutoArchive.markSeen('s');
  await act(async () => root.unmount());
  await settle();
  return patches.map(({ patch }) => patch);
}

describe('auto-archive when leaving the phone task page', () => {
  // Rule: same leave-time conditions as Desktop (useGhostCardTaskArchive); the phone had no auto-archive at all.
  it('archives silently and offers undo once the host still allows it and nothing would be lost', async () => {
    expect(await leaveAfterSeeing()).toEqual([{ status: 'archived' }]);
    expect(h.undo).toHaveBeenCalledWith('Fix login', expect.any(Function));
    // The archived task already left the list; undo restores it from the snapshot taken before archiving.
    expect(h.sessions).toEqual([]);
    h.undo.mock.calls[0][1]();
    expect(patches[1]).toMatchObject({ session: { id: 's' }, patch: { status: 'active' } });
  });

  // Bug (review of #9325): the task drawer switches A to B inside one mounted page; B's render ran before A's cleanup,
  // so A was never archived. Minimal input: re-render the same page with another task id.
  it('archives the task left by an in-place switch to another task', async () => {
    patches.length = 0;
    h.sessions = [session];
    const root = createRoot(document.createElement('div'));
    await act(async () => root.render(createElement(Page, { id: 's' })));
    taskAutoArchive.setArmed('s', 'card', true);
    taskAutoArchive.markSeen('s');
    await act(async () => root.render(createElement(Page, { id: 'other' })));
    await settle();
    expect(patches.map(({ session: target, patch }) => [target.id, patch.status])).toEqual([['s', 'archived']]);
    await act(async () => root.unmount());
  });

  // Bug (review of #9325): messages from other tasks, Orca and auto-resume were taken for the user typing, which
  // cancelled a pending auto-archive for good. Minimal input: one such row after the card became pending.
  it('keeps a pending auto-archive through internal messages and cancels it for a real one', async () => {
    const row = (clientId: string, agentMeta: Record<string, unknown> | null) => ({ role: 'user', clientId, agentMeta });
    const root = createRoot(document.createElement('div'));
    const render = (messages: unknown[]) => act(async () => root.render(createElement(Page, { id: 's', messages })));
    const before = [row('u1', null)];
    await render(before);
    taskAutoArchive.setArmed('s', 'card', true);
    for (const [i, meta] of [
      { origin: { kind: 'session', senderSessionId: 'other' } },
      { origin: { kind: 'orca', senderSessionId: 'lead' } },
      { origin: { kind: 'scheduler', scheduleId: 'daily' } },
      { autoResume: true },
      { parentToolUseId: 'toolu_01abc' },
      { sourcePlugin: { pluginId: 'cindy-github' } },
    ].entries()) {
      await render([...before, row(`internal-${i}`, meta)]);
      expect(taskAutoArchive.getState('s')).toBe('pending');
    }
    // A person's message through an IM hook counts, like one typed on the phone.
    await render([...before, row('hook', { origin: { kind: 'scheduler', scheduleId: 'hook:slack' } })]);
    expect(taskAutoArchive.getState('s')).toBe('cancelled');
    await act(async () => root.unmount());
  });

  // Bug (review of #9325): a task link or origin task opens with router.push, so the page blurs but stays mounted and
  // was never "left". Minimal input: blur the page while the focused route is another task, vs. a non-task route.
  it('treats a blur to another task as leaving, and a blur to a non-task screen as staying', async () => {
    const root = createRoot(document.createElement('div'));
    const render = () => act(async () => root.render(createElement(Page, { id: 's' })));
    patches.length = 0;
    h.sessions = [session];
    await render();
    taskAutoArchive.setArmed('s', 'card', true);
    taskAutoArchive.markSeen('s');
    Object.assign(h, { focused: false, pathname: '/files/s' });
    await render();
    await settle();
    expect(patches).toEqual([]);
    expect(taskAutoArchive.getState('s')).toBe('pending');
    Object.assign(h, { focused: false, pathname: '/sessions/other' });
    await render();
    await settle();
    expect(patches.map(({ patch }) => patch)).toEqual([{ status: 'archived' }]);
    await act(async () => root.unmount());
  });

  it('gives up the archive when the user comes back to the task during the checks', async () => {
    const root = createRoot(document.createElement('div'));
    const render = () => act(async () => root.render(createElement(Page, { id: 's' })));
    patches.length = 0;
    h.sessions = [session];
    await render();
    taskAutoArchive.setArmed('s', 'card', true);
    taskAutoArchive.markSeen('s');
    let release!: () => void;
    h.gate = new Promise<void>((resolve) => { release = resolve; });
    Object.assign(h, { focused: false, pathname: '/sessions/other' });
    await render();
    Object.assign(h, { focused: true, pathname: '/sessions/s' });
    await render();
    release();
    await settle();
    expect(patches).toEqual([]);
    expect(taskAutoArchive.getState('s')).toBe('pending');
    await act(async () => root.unmount());
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
