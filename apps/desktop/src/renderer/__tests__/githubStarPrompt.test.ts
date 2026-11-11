// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGithubStarPrompt, installGithubStarPrompt, recordGithubStarPromptSend,
  recordGithubStarPromptCompletion,
} from '../lib/githubStarPrompt';
import { setDataOwnerGeneration } from '../contexts/dataOwnerGeneration';
import { getToastSnapshot, toast } from '../lib/toast';
import { makerChatStore } from '../lib/makerChatStore';
import { createGithubStarPromptEnvironment } from '../lib/githubStarPromptHost';
import { createMemoryRouter } from 'react-router-dom';
import { saveDraft, clearDraft } from '../lib/composerDraftStore';
vi.mock('@/i18n', () => ({ default: { t: (key: string) => key } }));

// Unit: production controller/installer. A send plus idle used to interrupt active work,
// queue behind other notices and repeat after restart. Toast rendering tests cannot cover
// these eligibility races. Minimal input: accepted send, matching completion, quiet landing,
// then one intervening activity/state change (including during the GitHub request).
let cleanups: Array<() => void> = [];
beforeEach(() => {
  vi.useFakeTimers(); vi.setSystemTime(new Date('2026-11-09T00:00:00Z')); localStorage.clear();
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  vi.spyOn(document, 'hidden', 'get').mockReturnValue(false);
});
afterEach(() => {
  cleanups.forEach(fn => fn()); cleanups = [];
  document.body.replaceChildren();
  toast.dismissAll(); vi.runOnlyPendingTimers(); vi.restoreAllMocks(); vi.useRealTimers();
});
function setup(checkValue: boolean | null = false, ownerId = 'user') {
  const show = vi.fn((_dismiss: () => void) => vi.fn());
  const check = vi.fn(async (): Promise<boolean | null> => checkValue);
  const isCurrent = vi.fn(() => true);
  const isQuiet = vi.fn(() => true);
  const isEligiblePage = vi.fn(() => true);
  const isEditing = vi.fn(() => false);
  const controller = createGithubStarPrompt({ storage: localStorage, ownerId, check, isCurrent, show, isQuiet, isEligiblePage, isEditing });
  cleanups.push(controller.dispose);
  return { ...controller, show, check, isCurrent, isQuiet, isEligiblePage, isEditing };
}
const TWO_DAYS = 48 * 60 * 60 * 1000;
function eligible(h: ReturnType<typeof setup>) {
  h.record('task', 'first');
  vi.setSystemTime(Date.now() + TWO_DAYS);
  h.record('task', 'latest');
  h.complete('task', 'latest');
}
describe('GitHub Star prompt', () => {
  it('requires 48 hours, a matched successful turn and a full minute on the eligible task page', async () => {
    const h = setup(); h.isEligiblePage.mockReturnValue(false);
    h.record('task', 'first'); h.complete('task', 'first');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
    vi.setSystemTime(Date.now() + TWO_DAYS);
    h.record('task', 'latest');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
    h.complete('task', 'latest');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
    h.isEligiblePage.mockReturnValue(true); h.environmentChanged(true);
    await vi.advanceTimersByTimeAsync(59_999); expect(h.show).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1); expect(h.show).toHaveBeenCalledOnce();
  });
  it.each([null, 'another-input'])('does not turn failed/foreign completion (%s) into eligibility', async id => {
    const h = setup(); h.record('task', 'first'); vi.setSystemTime(Date.now() + TWO_DAYS);
    h.record('task', 'latest'); h.complete('task', id);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
  });
  it('keeps a queued turn eligible when the earlier turn completes first', async () => {
    const h = setup(); h.record('task', 'first'); vi.setSystemTime(Date.now() + TWO_DAYS);
    h.record('task', 'a'); h.record('task', 'b');
    h.complete('task', null); h.complete('task', 'a');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
    h.complete('task', 'b');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).toHaveBeenCalledOnce();
  });
  it('remembers actual presentation even when the app exits without dismissing', async () => {
    const h = setup(); eligible(h); await vi.advanceTimersByTimeAsync(60_000); h.dispose();
    const next = setup(); next.record('task', 'next'); next.complete('task', 'next');
    await vi.advanceTimersByTimeAsync(60_000); expect(next.check).not.toHaveBeenCalled();
    expect(localStorage.getItem('cindy:github-star:user:shown')).toBe('true');
    const other = setup(false, 'other'); eligible(other);
    await vi.advanceTimersByTimeAsync(60_000); expect(other.show).toHaveBeenCalledOnce();
  });
  it.each(['bad-time', '', String(Date.UTC(2026, 11, 1))])('suppresses corrupt or future first-use time (%s)', async value => {
    localStorage.setItem('cindy:github-star:user:first-used-at', value);
    const h = setup(); h.record('task', 'input'); h.complete('task', 'input');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
  });
  it('does not infer two days from the old message count', async () => {
    localStorage.setItem('cindy:github-star:user:sent', '100');
    const h = setup(); h.record('task', 'input'); h.complete('task', 'input');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
  });
  it.each([true, null])('does not show for an existing Star or unknown login (%s), and does not retry', async value => {
    const h = setup(value); eligible(h); await vi.advanceTimersByTimeAsync(60_000);
    h.record('task', 'retry'); h.complete('task', 'retry');
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.check).toHaveBeenCalledOnce(); expect(h.show).not.toHaveBeenCalled();
  });
  it.each(['keydown', 'pointerdown', 'wheel', 'input', 'focusin', 'blur', 'visibilitychange'])('abandons, rather than postpones, on %s', async event => {
    const h = setup(); eligible(h); await vi.advanceTimersByTimeAsync(20_000);
    (event === 'visibilitychange' ? document : window).dispatchEvent(new Event(event));
    window.dispatchEvent(new Event('focus'));
    await vi.advanceTimersByTimeAsync(120_000); expect(h.show).not.toHaveBeenCalled();
    expect(h.check).not.toHaveBeenCalled();
  });
  it.each(['work', 'route', 'send'])('cancels on new %s and never resurrects the old opportunity', async change => {
    const h = setup(); eligible(h);
    if (change === 'work') h.isQuiet.mockReturnValue(false);
    if (change === 'route') h.isEligiblePage.mockReturnValue(false);
    if (change === 'send') h.record('other', 'new');
    h.environmentChanged(change === 'route');
    h.isQuiet.mockReturnValue(true); h.isEligiblePage.mockReturnValue(true); h.environmentChanged();
    await vi.advanceTimersByTimeAsync(120_000); expect(h.show).not.toHaveBeenCalled();
  });
  it('waits for an draft to clear before arming, but cancels if a draft appears after arming', async () => {
    const h = setup(); h.isEligiblePage.mockReturnValue(false); eligible(h);
    h.isEligiblePage.mockReturnValue(true); h.isEditing.mockReturnValue(true); h.environmentChanged(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
    h.isEditing.mockReturnValue(false); window.dispatchEvent(new Event('focusout'));
    await vi.advanceTimersByTimeAsync(20_000);
    h.isEditing.mockReturnValue(true); h.environmentChanged();
    h.isEditing.mockReturnValue(false); h.environmentChanged();
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
  });
  it('expires an unused completion opportunity instead of popping up much later', async () => {
    const h = setup(); h.isEligiblePage.mockReturnValue(false); eligible(h);
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    h.isEligiblePage.mockReturnValue(true); h.environmentChanged(true);
    await vi.advanceTimersByTimeAsync(60_000); expect(h.check).not.toHaveBeenCalled();
  });
  it('does not query or show an expired opportunity after system sleep', async () => {
    const h = setup(); eligible(h);
    vi.setSystemTime(Date.now() + 10 * 60_000);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.check).not.toHaveBeenCalled(); expect(h.show).not.toHaveBeenCalled();
  });
  it.each(['owner', 'interaction', 'busy'])('discards the GitHub response if %s changes while checking', async change => {
    let resolve!: (value: boolean) => void;
    const h = setup(); h.check.mockImplementation(() => new Promise(r => { resolve = r; }));
    eligible(h); await vi.advanceTimersByTimeAsync(60_000);
    if (change === 'owner') h.isCurrent.mockReturnValue(false);
    if (change === 'interaction') window.dispatchEvent(new Event('keydown'));
    // The final safety check also covers state changes whose subscription has not fired yet.
    if (change === 'busy') h.isQuiet.mockReturnValue(false);
    resolve(false); await vi.advanceTimersByTimeAsync(0); expect(h.show).not.toHaveBeenCalled();
  });
  it.each(['shown', 'dismissed'])('honors %s from another window', async key => {
    const h = setup(); eligible(h);
    localStorage.setItem(`cindy:github-star:user:${key}`, 'true');
    window.dispatchEvent(new StorageEvent('storage', { key: `cindy:github-star:user:${key}` }));
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
  });
  it('does not show if the presentation receipt cannot be persisted', async () => {
    const h = setup(); eligible(h);
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('denied'); });
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
  });
});
function install(starred = true) {
  setDataOwnerGeneration('user');
  const starCindy = vi.fn(async () => starred);
  const openExternal = vi.fn(async () => ({ success: true }));
  window.electronAPI = { gitContext: { checkCindyStar: async () => false, starCindy }, openExternal } as unknown as typeof window.electronAPI;
  cleanups.push(installGithubStarPrompt({ isQuiet: () => true, isEligiblePage: () => true, isEditing: () => false, subscribe: () => () => {} }));
  recordGithubStarPromptSend('task', 'first');
  vi.setSystemTime(Date.now() + TWO_DAYS);
  recordGithubStarPromptSend('task', 'latest'); recordGithubStarPromptCompletion('task', 'latest');
  return { starCindy, openExternal };
}
describe('production notification admission', () => {
  it('drops the invitation instead of queueing behind other notifications', async () => {
    install();
    for (let i = 0; i < 5; i++) toast.info(`Important ${i}`);
    await vi.advanceTimersByTimeAsync(60_000); toast.dismissAll();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getToastSnapshot().some(t => t.icon === 'star')).toBe(false);
  });
  it('cancels when a dialog appears without a pointer event', async () => {
    install();
    const dialog = document.createElement('div'); dialog.setAttribute('role', 'dialog');
    vi.spyOn(dialog, 'getClientRects').mockReturnValue([{}] as unknown as DOMRectList);
    document.body.append(dialog); await vi.advanceTimersByTimeAsync(0);
    dialog.remove(); await vi.advanceTimersByTimeAsync(60_000);
    expect(getToastSnapshot().some(t => t.icon === 'star')).toBe(false);
  });
  it('keeps working after a same-owner repair advances the generation', async () => {
    install();
    setDataOwnerGeneration('user', 99);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getToastSnapshot().some(t => t.icon === 'star')).toBe(true);
  });
  it.each([true, false])('stars only on click and retains opt-out on success/browser fallback (%s)', async starred => {
    const { starCindy, openExternal } = install(starred);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(starCindy).not.toHaveBeenCalled();
    const item = getToastSnapshot().find(t => t.icon === 'star')!;
    const point = { x: 230, y: 110 };
    item.action!.onClick(point);
    point.x = 900; item.action!.onClick(point);
    await vi.advanceTimersByTimeAsync(0);
    expect(starCindy).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledTimes(starred ? 0 : 1);
    expect(localStorage.getItem('cindy:github-star:user:dismissed')).toBe('true');
    expect(getToastSnapshot().find(t => t.id === item.id)?.celebrate === true).toBe(starred);
    if (starred) expect(getToastSnapshot().find(t => t.id === item.id)?.celebrationOrigin).toEqual({ x: 230, y: 110 });
  });
});

// Exercise the live Maker event ingress too: status/hydration and automatic turns must
// never count as a successful user task. Uses the existing IPC seam, not the reducer shortcut.
describe('live task completion admission', () => {
  it.each(['success', 'status-only', 'stopped', 'error', 'scheduler', 'im', 'continuation', 'silent-stop', 'older-input', 'missing-input'])('handles %s without mistaking it for a clean user completion', async outcome => {
    install(); // Cancel its synthetic completion and record a fresh, real task input below.
    recordGithubStarPromptSend('live', 'user-input');
    let emit!: (payload: unknown) => void;
    let messageCreated!: (payload: unknown) => void;
    const unsubscribe = () => () => {};
    Object.assign(window.electronAPI, {
      maker: {
        input: {}, onInputProjection: unsubscribe,
        onEvent: (handler: typeof emit) => { emit = handler; return () => {}; },
        onStatusChanged: unsubscribe, onInteractionRequest: unsubscribe,
        onInteractionDismissed: unsubscribe, listActive: async () => [],
      },
      localDb: { messages: {
        onCreated: (handler: typeof messageCreated) => { messageCreated = handler; return () => {}; },
        onDeleted: unsubscribe,
      } },
    });
    makerChatStore.initGlobalListeners();
    cleanups.push(() => { makerChatStore.__teardownGlobalListeners(); makerChatStore.purgeSession('live'); });
    makerChatStore.getSnapshot('live');
    messageCreated({ sessionId: 'live', message: {
      id: 'row-user', clientId: 'user-input', sessionId: 'live', role: 'user',
      content: 'Please help', toolUseId: null, agentMeta: null, createdAt: new Date().toISOString(),
    } });
    emit({ sessionId: 'live', event: { type: 'status', data: { isRunning: true, status: 'Working' } } });
    const origin = outcome === 'scheduler' ? { kind: 'scheduler' }
      : outcome === 'im' ? { kind: 'user', surface: 'im' } : { kind: 'user' };
    if (outcome === 'error') emit({ sessionId: 'live', event: {
      type: 'error', source: 'claude-code', turnOrigin: origin, data: { message: 'Failed' },
    } });
    emit({ sessionId: 'live', event: {
      type: outcome === 'status-only' ? 'status' : 'done', source: 'claude-code', turnOrigin: origin,
      agentMeta: outcome === 'missing-input' ? {}
        : { replyToClientId: outcome === 'older-input' ? 'previous-input' : 'user-input' },
      ...(outcome === 'continuation' ? { turnContinuationId: 1 } : {}),
      data: outcome === 'stopped' ? { cancelled: true }
        : outcome === 'silent-stop' ? { silentStop: true } : { isRunning: false, status: 'Done' },
    } });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(getToastSnapshot().some(item => item.icon === 'star')).toBe(outcome === 'success');
  });
});

// The host adapter used by App must allow reading the completed task even when its
// composer retains focus. The former landing-only policy never offered that opportunity.
describe('desktop page and draft eligibility', () => {
  it('shows on the completed task with an empty focused composer, and never on unrelated pages', async () => {
    const router = createMemoryRouter([{ path: '*', element: null }], { initialEntries: ['/cc-agent/task'] });
    cleanups.push(() => router.dispose());
    const environment = createGithubStarPromptEnvironment(router);
    const h = setup();
    h.isEligiblePage.mockImplementation(() => environment.isEligiblePage('task'));
    h.isEditing.mockImplementation(environment.isEditing);
    const input = document.createElement('textarea'); document.body.append(input); input.focus();
    expect(environment.isEditing()).toBe(false);
    eligible(h); await vi.advanceTimersByTimeAsync(60_000);
    expect(h.show).toHaveBeenCalledOnce();
    for (const path of ['/cc-agent/other', '/settings', '/cc-agent/scheduled']) {
      await router.navigate(path); expect(environment.isEligiblePage('task')).toBe(false);
    }
    await router.navigate('/cc-agent/new'); expect(environment.isEligiblePage('task')).toBe(true);
  });
  it('observes the current task draft and cancels on navigation even between eligible pages', async () => {
    const router = createMemoryRouter([{ path: '*', element: null }], { initialEntries: ['/cc-agent/task'] });
    const environment = createGithubStarPromptEnvironment(router);
    const h = setup();
    h.isEligiblePage.mockImplementation(() => environment.isEligiblePage('task'));
    h.isEditing.mockImplementation(environment.isEditing);
    const stop = environment.subscribe(h.environmentChanged);
    cleanups.push(() => { stop(); router.dispose(); clearDraft('task'); });
    eligible(h);
    saveDraft('task', { text: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'unsent' }] }] }, attachments: [] });
    clearDraft('task');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
    h.record('task', 'again'); h.complete('task', 'again');
    await router.navigate('/cc-agent/new');
    await vi.advanceTimersByTimeAsync(60_000); expect(h.show).not.toHaveBeenCalled();
  });
});
