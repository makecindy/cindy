// @vitest-environment jsdom
/**
 * Production entry: ApprovalsInbox, issue #7695. The single-session PermissionPrompt tests do not
 * cover a queue of requests from several sessions: explicit selection, a stable list while requests
 * arrive and leave, host reconciliation, account switches or the honest "first seen" clock. Every
 * case here is a minimal in-memory scenario through the real inbox with a fake makerChatStore.
 * Tier: unit (jsdom, fake timers). The real PermissionPrompt is covered in ApprovalsInbox.prompt.test.tsx.
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { setDataOwnerGeneration, __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import {
  addRequest, advance, clearRequest, fake, flush, installLayout, publish, resetFake, setActivities,
} from './approvalsKit';

vi.mock('react-i18next', async () => {
  const kit = await import('./approvalsKit');
  const value = { t: kit.t };
  return { useTranslation: () => value };
});
vi.mock('@/features/cc-agent/useRegisterCCAgentSidebar', () => ({ useRegisterCCAgentSidebar: vi.fn() }));
vi.mock('@/components/layout/windowDrag', () => ({ InvisibleWindowDragStrip: () => null }));
vi.mock('@/lib/makerChatStore', async () => ({ makerChatStore: (await import('./approvalsKit')).store }));
vi.mock('@/lib/makerTransport', async () => await import('./approvalsKit').then((kit) => kit.transport));
vi.mock('@/lib/orcaSessionIdentity', async () => {
  const kit = await import('./approvalsKit');
  return { resolveSessionRoute: (...args: unknown[]) => kit.fake.resolveSessionRoute(...args) };
});
vi.mock('@/state/agentIslandActivity', async () => {
  const kit = await import('./approvalsKit');
  const { useSyncExternalStore } = await import('react');
  return { useAgentIslandActivityMap: () => useSyncExternalStore(kit.subscribe, () => kit.fake.activities) };
});
vi.mock('@/components/new-chat/PermissionPrompt', () => ({
  PermissionPrompt: ({ permission, onRespond, enableKeyboardShortcuts }: {
    permission: { requestId: string; submitting?: boolean };
    onRespond: (result: { behavior: string }) => void;
    enableKeyboardShortcuts?: boolean;
  }) => {
    promptCallbacks.set(permission.requestId, onRespond);
    return (
      <div data-testid="prompt" data-shortcuts={String(enableKeyboardShortcuts)}>
        <button disabled={permission.submitting} onClick={() => onRespond({ behavior: 'allow' })}>
          {'Allow ' + permission.requestId}
        </button>
        <button disabled={permission.submitting} onClick={() => onRespond({ behavior: 'deny' })}>
          {'Deny ' + permission.requestId}
        </button>
      </div>
    );
  },
}));
const promptCallbacks = new Map<string, (result: { behavior: string }) => void>();

import { ApprovalsInbox } from '../ApprovalsInbox';
import { invalidateWorkerIdentity } from '../useWorkerIdentity';

let restoreLayout: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  resetFake();
  invalidateWorkerIdentity();
  promptCallbacks.clear();
  ownerTesting.reset();
  restoreLayout = installLayout();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { orcaWorkflows: { projectLabel: (...a: unknown[]) => fake.projectLabel(...a) } },
  };
});
afterEach(() => {
  cleanup();
  restoreLayout();
  vi.useRealTimers();
});

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname + useLocation().search}</output>;
}
async function mount() {
  const view = render(
    <MemoryRouter initialEntries={['/approvals']}>
      <ApprovalsInbox />
      <LocationProbe />
    </MemoryRouter>,
  );
  await flush();
  return view;
}
const listbox = () => screen.getByRole('listbox', { name: 'Waiting requests' });
const options = () => within(listbox()).queryAllByRole('option');
const optionFor = (name: RegExp | string) => within(listbox()).getByRole('option', { name });
const selected = () => options().filter((option) => option.getAttribute('aria-selected') === 'true');
const allowButton = (requestId: string) => screen.queryByRole('button', { name: 'Allow ' + requestId });
async function select(name: RegExp | string, armed = true) {
  fireEvent.click(optionFor(name));
  if (armed) await advance(600);
}

describe('explicit selection', () => {
  it('starts idle: nothing selected, no decision control, rows hold no buttons or command text', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    expect(options()).toHaveLength(2);
    expect(selected()).toHaveLength(0);
    expect(screen.getByText('Select a request to review')).toBeTruthy();
    expect(screen.queryByTestId('prompt')).toBeNull();
    expect(within(listbox()).queryAllByRole('button')).toHaveLength(0);
    expect(listbox().textContent).not.toMatch(/secret|echo|Allow|Deny/);
    expect(screen.getByRole('heading', { level: 1, name: 'Approvals' })).toBeTruthy();
    expect(screen.getByText('2 waiting')).toBeTruthy();
  });

  it('selects on click, Enter and Space only; selecting never decides', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    fireEvent.click(optionFor(/Session a/));
    expect(selected().map((o) => o.getAttribute('aria-label'))).toEqual([expect.stringContaining('Session a')]);
    expect(screen.getByTestId('prompt')).toBeTruthy();
    fireEvent.keyDown(optionFor(/Session b/), { key: 'Enter' });
    expect(selected().map((o) => o.getAttribute('aria-label'))).toEqual([expect.stringContaining('Session b')]);
    fireEvent.keyDown(optionFor(/Session a/), { key: ' ' });
    expect(selected().map((o) => o.getAttribute('aria-label'))).toEqual([expect.stringContaining('Session a')]);
    expect(fake.respond).not.toHaveBeenCalled();
  });

  it('selects nothing after a decision: the request leaves a placeholder and the inspector goes idle', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    await select(/Session a/);
    fireEvent.click(allowButton('req-a')!);
    expect(fake.respond).toHaveBeenCalledExactlyOnceWith('a', { behavior: 'allow' });
    act(() => { clearRequest('a'); }); publish();
    expect(selected()).toHaveLength(0);
    expect(screen.queryByTestId('prompt')).toBeNull();
    expect(screen.getByText('Select a request to review')).toBeTruthy();
    const ended = within(listbox()).getAllByRole('option').find((o) => o.getAttribute('aria-disabled') === 'true')!;
    expect(ended.textContent).toContain('No longer waiting');
    expect(optionFor(/Session b/).getAttribute('aria-selected')).toBe('false');
  });

  it('keeps the selection on the same request when others leave or arrive (by id, never by index)', async () => {
    addRequest('a'); addRequest('b'); addRequest('c');
    await mount();
    await select(/Session b/);
    act(() => { clearRequest('a'); }); publish();
    addRequest('d'); publish();
    expect(selected().map((o) => o.getAttribute('aria-label'))).toEqual([expect.stringContaining('Session b')]);
    await advance(6000);
    expect(selected().map((o) => o.getAttribute('aria-label'))).toEqual([expect.stringContaining('Session b')]);
    expect(options().map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual(['Session b', 'Session c', 'Session d']);
  });

  it('clears the selection when the selected request is replaced; the replacement is not selected', async () => {
    addRequest('a', 'old');
    await mount();
    await select(/Session a/);
    expect(allowButton('old')).toBeTruthy();
    addRequest('a', 'new'); publish();
    expect(selected()).toHaveLength(0);
    expect(allowButton('new')).toBeNull();
    expect(screen.getByText('Select a request to review')).toBeTruthy();
    const names = options().map((o) => o.getAttribute('aria-label') ?? '');
    expect(names).toHaveLength(2);
    expect(names[0]).toContain('No longer waiting');
    expect(names[1]).toContain('Session a');
  });

  it('clears the selection when the selected request is dismissed by the host', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    await select(/Session a/);
    act(() => { clearRequest('a'); }); publish();
    expect(selected()).toHaveLength(0);
    expect(screen.queryByTestId('prompt')).toBeNull();
  });
});

describe('stable queue', () => {
  it('orders by first seen, appends arrivals and never re-sorts', async () => {
    addRequest('b'); addRequest('a');
    await mount();
    addRequest('c'); publish();
    await flush();
    expect(options().map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual(['Session b', 'Session a', 'Session c']);
    act(() => { clearRequest('b'); }); publish();
    addRequest('b', 'req-b-again'); publish();
    await flush();
    expect(options().map((o) => o.getAttribute('aria-label')?.split(',')[0])).toEqual([
      'Session b', 'Session a', 'Session c', 'Session b',
    ]);
  });

  it('leaves a non-interactive placeholder for 5 s, holds it while the pointer is in the list, then collapses', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    act(() => { clearRequest('a'); }); publish();
    const placeholder = () => options().find((o) => o.getAttribute('aria-disabled') === 'true')!;
    expect(placeholder().textContent).toContain('No longer waiting');
    expect(placeholder().hasAttribute('tabindex')).toBe(false);
    fireEvent.click(placeholder());
    expect(selected()).toHaveLength(0);
    expect(within(placeholder()).queryAllByRole('button')).toHaveLength(0);

    fireEvent.pointerEnter(listbox());
    await advance(20_000);
    expect(options()).toHaveLength(2);
    fireEvent.pointerLeave(listbox());
    await advance(0);
    expect(placeholder().getAttribute('data-state')).toBe('leaving');
    await advance(400);
    expect(options()).toHaveLength(1);
  });

  it('uses a neutral placeholder for allow, deny and dismissal: never claims an outcome', async () => {
    addRequest('a'); addRequest('b'); addRequest('c');
    await mount();
    await select(/Session a/);
    fireEvent.click(allowButton('req-a')!);
    act(() => { clearRequest('a'); }); publish();
    await select(/Session b/);
    fireEvent.click(screen.getByRole('button', { name: 'Deny req-b' }));
    act(() => { clearRequest('b'); }); publish();
    act(() => { clearRequest('c'); }); publish();
    const placeholders = options().filter((o) => o.getAttribute('aria-disabled') === 'true');
    expect(placeholders).toHaveLength(3);
    for (const item of placeholders) {
      expect(item.textContent).toContain('No longer waiting');
      expect(item.textContent).not.toMatch(/allowed|denied|approved|rejected/i);
    }
  });
});

describe('decisions are bound to the displayed request', () => {
  it('ignores a retained callback after the session received a replacement request', async () => {
    addRequest('worker', 'old');
    await mount();
    await select(/Session worker/);
    const stale = promptCallbacks.get('old')!;
    addRequest('worker', 'new'); publish();
    act(() => { stale({ behavior: 'allow' }); });
    expect(fake.respond).not.toHaveBeenCalled();
    await select(/Session worker, Command/);
    fireEvent.click(allowButton('new')!);
    expect(fake.respond).toHaveBeenCalledExactlyOnceWith('worker', { behavior: 'allow' });
  });

  it('routes quick back-to-back decisions to their own sessions exactly once each', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    await select(/Session a/);
    fireEvent.click(allowButton('req-a')!);
    act(() => { clearRequest('a'); }); publish();
    await select(/Session b/);
    fireEvent.click(allowButton('req-b')!);
    expect(fake.respond.mock.calls).toEqual([['a', { behavior: 'allow' }], ['b', { behavior: 'allow' }]]);
  });

  it('does not decide again while the request is already being sent', async () => {
    addRequest('a');
    await mount();
    await select(/Session a/);
    const retained = promptCallbacks.get('req-a')!;
    fireEvent.click(allowButton('req-a')!);
    act(() => { retained({ behavior: 'allow' }); });
    expect(fake.respond).toHaveBeenCalledTimes(1);
  });
});

describe('reconciliation', () => {
  it('reconciles on mount and not on every id-set change or decision', async () => {
    addRequest('a');
    await mount();
    expect(fake.reconcile.mock.calls).toEqual([['a']]);
    addRequest('b'); publish();
    await select(/Session a/);
    fireEvent.click(allowButton('req-a')!);
    act(() => { clearRequest('a'); }); publish();
    await flush();
    expect(fake.reconcile.mock.calls).toEqual([['a']]);
  });

  it('reconciles again when the window regains focus or becomes visible', async () => {
    addRequest('a');
    await mount();
    fake.reconcile.mockClear();
    act(() => { window.dispatchEvent(new Event('focus')); });
    await flush();
    expect(fake.reconcile.mock.calls).toEqual([['a']]);
    fake.reconcile.mockClear();
    act(() => { document.dispatchEvent(new Event('visibilitychange')); });
    await flush();
    expect(fake.reconcile.mock.calls).toEqual([['a']]);
  });

  it('recovers only host-reported requests the store does not know when the host activity changes', async () => {
    addRequest('known');
    fake.activities = new Map([['known', { phase: 'needs-interaction', interactionKind: 'permission' }]]);
    await mount();
    fake.reconcile.mockClear();
    fake.reconcile.mockImplementation(async (id: string) => { addRequest(id); publish(); return 1; });
    setActivities(new Map([
      ['known', { phase: 'needs-interaction', interactionKind: 'permission' }],
      ['missed', { phase: 'needs-interaction', interactionKind: 'permission' }],
      ['question', { phase: 'needs-interaction', interactionKind: 'ask_user_question' }],
      ['busy', { phase: 'running' }],
    ]));
    await flush();
    expect(fake.reconcile.mock.calls).toEqual([['missed']]);
    expect(optionFor(/Session missed/)).toBeTruthy();
  });

  it('coalesces triggers that arrive while a reconcile is still running', async () => {
    addRequest('a');
    let release!: () => void;
    fake.reconcile.mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(0); }));
    await mount();
    for (let i = 0; i < 4; i += 1) act(() => { window.dispatchEvent(new Event('focus')); });
    expect(fake.reconcile).toHaveBeenCalledTimes(1);
    release();
    await flush();
    expect(fake.reconcile).toHaveBeenCalledTimes(2);
  });

  it('Refresh checks every visible and host-reported request and is disabled while checking', async () => {
    addRequest('a');
    fake.activities = new Map([['x', { phase: 'needs-interaction', interactionKind: 'permission' }]]);
    await mount();
    fake.reconcile.mockClear();
    const releases: Array<() => void> = [];
    fake.reconcile.mockImplementation(() => new Promise<number>((resolve) => { releases.push(() => resolve(0)); }));
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(true);
    expect(fake.reconcile.mock.calls.map(([id]) => id).sort()).toEqual(['a', 'x']);
    releases.forEach((release) => release());
    await flush();
    expect((screen.getByRole('button', { name: 'Refresh' }) as HTMLButtonElement).disabled).toBe(false);
  });

  it('a reconcile that finishes after the user decided does not bring the card back', async () => {
    addRequest('a');
    let release!: () => void;
    fake.reconcile.mockImplementationOnce(() => new Promise<number>((resolve) => { release = () => resolve(1); }));
    await mount();
    await select(/Session a/);
    fireEvent.click(allowButton('req-a')!);
    act(() => { clearRequest('a'); }); publish();
    release();
    await flush();
    expect(allowButton('req-a')).toBeNull();
    expect(selected()).toHaveLength(0);
    expect(options().every((o) => o.getAttribute('aria-disabled') === 'true')).toBe(true);
  });

  it('shows a failure without hiding the requests, then clears it after a successful refresh', async () => {
    addRequest('a');
    fake.reconcile.mockRejectedValueOnce(new Error('snapshot unavailable'));
    await mount();
    expect(screen.getByRole('alert').textContent).toContain('could not be loaded');
    expect(options()).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }));
    await flush();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('reports an unavailable snapshot instead of an empty inbox', async () => {
    fake.activities = new Map([['w', { phase: 'needs-interaction', interactionKind: 'permission' }]]);
    fake.reconcile.mockRejectedValueOnce(new Error('offline'));
    await mount();
    expect(screen.getByText(/could not be checked/)).toBeTruthy();
    expect(screen.queryByText('No requests are waiting')).toBeNull();
  });

  it('shows the empty state when nothing is waiting', async () => {
    await mount();
    expect(screen.getByText('No requests are waiting')).toBeTruthy();
    expect(screen.getByText('0 waiting')).toBeTruthy();
  });
});

describe('account switch', () => {
  it('drops the selection, placeholders and late lookups when the data owner changes', async () => {
    setDataOwnerGeneration('owner-a', 1);
    const lates: Array<(value: unknown) => void> = [];
    fake.getSessionFor.mockImplementation((id: string) => id === 'slow'
      ? new Promise((resolve) => { lates.push(resolve); })
      : Promise.resolve({ id, title: 'Session ' + id, workingDir: '/project/' + id }));
    addRequest('a'); addRequest('b'); addRequest('slow');
    await mount();
    await select(/Session a/);
    act(() => { clearRequest('b'); }); publish();
    expect(options().some((o) => o.getAttribute('aria-disabled') === 'true')).toBe(true);

    clearRequest('a'); clearRequest('slow'); publish();
    act(() => { setDataOwnerGeneration('owner-b', 2); });
    await advance(1000);
    expect(screen.queryByTestId('prompt')).toBeNull();
    expect(screen.queryByRole('listbox')).toBeNull();

    addRequest('slow', 'req-new'); publish();
    lates[0]({ id: 'slow', title: 'Old owner secret title', workingDir: '/old/owner' });
    await flush();
    expect(screen.queryByText(/Old owner secret title/)).toBeNull();
  });
});

describe('seen time', () => {
  it('shows first-seen age in s, m and h on one shared clock, with an honest hint', async () => {
    addRequest('a');
    await mount();
    const row = () => optionFor(/Session a/);
    expect(row().textContent).toContain('Seen 0s ago');
    await advance(7_000);
    expect(row().textContent).toContain('Seen 7s ago');
    await advance(53_000);
    expect(row().textContent).toContain('Seen 1m ago');
    await advance(59 * 60_000);
    expect(row().textContent).toContain('Seen 1h ago');
    const time = within(row()).getByText(/Seen 1h ago/);
    expect(time.getAttribute('title')).toContain('First seen by this window');
    expect(listbox().textContent).not.toMatch(/waiting since|requested/i);
  });

  it('measures from when this window first saw the request, not from when the page opened', async () => {
    addRequest('a');
    await mount();
    await advance(30_000);
    addRequest('b'); publish();
    await advance(5_000);
    expect(optionFor(/Session a/).textContent).toContain('Seen 35s ago');
    expect(optionFor(/Session b/).textContent).toContain('Seen 5s ago');
  });
});

describe('worker identity', () => {
  it('names the worker, its parent task and project through the orca lookups and caches per lead', async () => {
    for (const id of ['w1', 'w2']) {
      addRequest(id);
      fake.sessions.set(id, { id, title: 'Worker task ' + id, orcaRole: 'worker', workingDir: '/work/' + id });
      fake.teams.set(id, { leadSessionId: 'lead' });
    }
    fake.sessions.set('lead', { id: 'lead', title: 'Ship approval routing', orcaRole: 'lead', workingDir: '/work/lead' });
    fake.workers.set('lead', [
      { sessionId: 'w1', label: 'frontend', role: 'developer', session: { title: 'Worker task w1' } },
      { sessionId: 'w2', label: 'tests', role: 'tester', session: { title: 'Worker task w2' } },
    ]);
    fake.projectLabel.mockImplementation(async (id: string) => ({ name: 'proj-' + id, path: '/projects/' + id }));
    await mount();
    expect(optionFor(/developer #frontend/).textContent).toContain('proj-w1');
    expect(optionFor(/tester #tests/).textContent).toContain('proj-w2');
    expect(fake.listWorkersByLead).toHaveBeenCalledTimes(1);
    await select(/developer #frontend/);
    const inspector = screen.getByRole('region', { name: 'Request from developer #frontend' });
    expect(within(inspector).getByText('Ship approval routing')).toBeTruthy();
    expect(within(inspector).getByText('proj-w1')).toBeTruthy();
  });

  it('falls back to the session title when the lookups fail and still allows the decision', async () => {
    addRequest('w1');
    fake.sessions.set('w1', { id: 'w1', title: 'Fallback title', orcaRole: 'worker', workingDir: '/work/w1' });
    fake.getByWorkerSession.mockRejectedValue(new Error('offline'));
    fake.projectLabel.mockRejectedValue(new Error('offline'));
    await mount();
    expect(optionFor(/Fallback title/).textContent).toContain('w1');
    await select(/Fallback title/);
    expect(screen.getByRole('region', { name: 'Request from Fallback title' }).textContent).not.toContain('Ship');
    expect(allowButton('req-w1')).toBeTruthy();
  });

  it('uses the localized untitled name when the session has no title and no lookup answers', async () => {
    addRequest('x');
    fake.getSessionFor.mockRejectedValue(new Error('gone'));
    await mount();
    expect(options()[0].getAttribute('aria-label')).toContain('Untitled Session');
  });
});

describe('keyboard', () => {
  it('moves focus with the arrow keys and selects only on Enter or Space', async () => {
    addRequest('a'); addRequest('b'); addRequest('c');
    await mount();
    const [first, second, third] = options();
    first.focus();
    fireEvent.keyDown(first, { key: 'ArrowDown' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'End' });
    expect(document.activeElement).toBe(third);
    fireEvent.keyDown(third, { key: 'ArrowUp' });
    expect(document.activeElement).toBe(second);
    fireEvent.keyDown(second, { key: 'Home' });
    expect(document.activeElement).toBe(first);
    expect(selected()).toHaveLength(0);
    expect(options().map((o) => o.getAttribute('tabindex'))).toEqual(['0', '-1', '-1']);
  });

  it('Escape in the inspector returns focus to the queue and never decides', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    await select(/Session b/);
    const deny = screen.getByRole('button', { name: 'Deny req-b' });
    deny.focus();
    fireEvent.keyDown(deny, { key: 'Escape' });
    expect(document.activeElement).toBe(optionFor(/Session b/));
    expect(selected()).toHaveLength(1);
    expect(fake.respond).not.toHaveBeenCalled();
  });

  it('global Enter, Ctrl+Enter and Escape never decide a request', async () => {
    addRequest('a');
    await mount();
    await select(/Session a/);
    for (const init of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true }, { key: 'Escape' }]) {
      fireEvent.keyDown(window, init);
      fireEvent.keyDown(document.body, init);
    }
    expect(fake.respond).not.toHaveBeenCalled();
    expect(screen.getByTestId('prompt').getAttribute('data-shortcuts')).toBe('false');
  });
});

describe('layout and navigation', () => {
  it('shows queue and inspector side by side from 800 px wide and stacks below, with a Back control', async () => {
    addRequest('a'); addRequest('b');
    fake.layout.width = 780;
    await mount();
    expect(screen.queryByText('Select a request to review')).toBeNull();
    await select(/Session b/);
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(screen.getByRole('region', { name: 'Request from Session b' })).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Requests' }));
    expect(screen.getByRole('listbox')).toBeTruthy();
    expect(screen.queryByTestId('prompt')).toBeNull();
    expect(document.activeElement).toBe(optionFor(/Session b/));
  });

  it('Open session routes through resolveSessionRoute and is not part of the locked decision area', async () => {
    addRequest('w1');
    fake.sessions.set('w1', { id: 'w1', title: 'W1', orcaRole: 'worker', workingDir: '/work/w1' });
    fake.resolveSessionRoute.mockResolvedValue('/cc-agent/lead?worker=w1');
    await mount();
    fireEvent.click(optionFor(/W1/));
    const open = screen.getByRole('button', { name: 'Open session' });
    expect(open.closest('[inert]')).toBeNull();
    fireEvent.click(open);
    await flush();
    expect(fake.resolveSessionRoute).toHaveBeenCalledWith('w1', expect.objectContaining({ id: 'w1' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent/lead?worker=w1');
    expect(fake.respond).not.toHaveBeenCalled();
  });
});
