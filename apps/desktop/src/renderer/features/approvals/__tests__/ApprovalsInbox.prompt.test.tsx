// @vitest-environment jsdom
/**
 * Production entry: ApprovalsInbox with the real PermissionPrompt (issue #7695). The mocked-prompt
 * suite cannot prove the arming lock, the absence of global approval keys, or that rapid clicks on
 * the real Allow control reach the store once. Minimal input: one or two pending Bash requests.
 * Tier: unit (jsdom, fake timers, in-memory store).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { __testing as ownerTesting } from '@/contexts/dataOwnerGeneration';
import {
  addRequest, advance, clearRequest, fake, flush, installLayout, publish, resetFake,
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
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: vi.fn(async () => '/cc-agent') }));
vi.mock('@/state/agentIslandActivity', async () => {
  const kit = await import('./approvalsKit');
  const { useSyncExternalStore } = await import('react');
  return { useAgentIslandActivityMap: () => useSyncExternalStore(kit.subscribe, () => kit.fake.activities) };
});
// Radix tooltip portals are irrelevant here; the prompt itself stays real.
vi.mock('@/components/ui/tooltip', () => ({ Tip: ({ children }: { children: React.ReactNode }) => <>{children}</> }));

import { ApprovalsInbox } from '../ApprovalsInbox';
import { invalidateWorkerIdentity } from '../useWorkerIdentity';

let restoreLayout: () => void;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-28T12:00:00Z'));
  resetFake();
  invalidateWorkerIdentity();
  ownerTesting.reset();
  restoreLayout = installLayout();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    localDb: { orcaWorkflows: { projectLabel: async () => null } },
  };
});
afterEach(() => {
  cleanup();
  restoreLayout();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

async function mount() {
  render(<MemoryRouter><ApprovalsInbox /></MemoryRouter>);
  await flush();
}
const row = (name: RegExp) => within(screen.getByRole('listbox')).getByRole('option', { name });
const gate = () => screen.getByTestId('decision-gate');
const allow = () => screen.getByRole('button', { name: 'Allow once' });

describe('arming lock', () => {
  it('keeps the decision controls inert for 600 ms after selection, announces it, and Allow does not move', async () => {
    addRequest('a');
    await mount();
    fireEvent.click(row(/Session a/));
    expect(gate().hasAttribute('inert')).toBe(true);
    expect(screen.getByTestId('gate-status').textContent).toBe('Unlocking decisions…');
    const band = screen.getByTestId('arming-band');
    expect(band.getAttribute('data-visible')).toBe('true');
    await advance(599);
    expect(gate().hasAttribute('inert')).toBe(true);
    await advance(1);
    expect(gate().hasAttribute('inert')).toBe(false);
    expect(screen.getByTestId('arming-band')).toBe(band);
    expect(band.getAttribute('data-visible')).toBe('false');
    expect(band.className).toContain('h-5');
    expect(screen.getByTestId('gate-status').textContent).toBe('Ready to decide');
    expect(allow()).toBeTruthy();
  });

  it('arms again whenever another request is selected, including one that was selected before', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(600);
    expect(gate().hasAttribute('inert')).toBe(false);
    fireEvent.click(row(/Session b/));
    expect(gate().hasAttribute('inert')).toBe(true);
    await advance(600);
    fireEvent.click(row(/Session a/));
    expect(gate().hasAttribute('inert')).toBe(true);
    await advance(600);
    fireEvent.click(row(/Session a/));
    expect(gate().hasAttribute('inert')).toBe(false);
  });

  it('still waits the full 600 ms when the user prefers reduced motion', async () => {
    vi.stubGlobal('matchMedia', (query: string) => ({
      matches: query.includes('prefers-reduced-motion'), media: query, addEventListener() {}, removeEventListener() {},
      addListener() {}, removeListener() {}, dispatchEvent: () => false, onchange: null,
    }));
    addRequest('a');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(599);
    expect(gate().hasAttribute('inert')).toBe(true);
    await advance(1);
    expect(gate().hasAttribute('inert')).toBe(false);
  });
});

describe('decisions with the real prompt', () => {
  it('shows no shortcut keycaps and ignores global Enter, Ctrl+Enter and Escape', async () => {
    addRequest('a');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(600);
    expect(screen.queryByText('Esc')).toBeNull();
    expect(screen.queryByText('Ctrl')).toBeNull();
    expect(document.querySelector('kbd')).toBeNull();
    for (const init of [{ key: 'Enter' }, { key: 'Enter', ctrlKey: true }, { key: 'Enter', metaKey: true }, { key: 'Escape' }]) {
      fireEvent.keyDown(window, init);
      fireEvent.keyDown(document.body, init);
    }
    expect(fake.respond).not.toHaveBeenCalled();
  });

  it('delivers two rapid clicks on Allow once as exactly one decision', async () => {
    addRequest('a');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(600);
    const button = allow();
    fireEvent.click(button);
    fireEvent.click(button);
    expect(fake.respond).toHaveBeenCalledExactlyOnceWith('a', { behavior: 'allow' });
    expect((allow() as HTMLButtonElement).disabled).toBe(true);
    expect(row(/Session a/).textContent).toContain('Sending…');
  });

  it('approving A then B quickly sends each decision once to its own session', async () => {
    addRequest('a'); addRequest('b');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(600);
    fireEvent.click(allow());
    clearRequest('a'); publish();
    fireEvent.click(row(/Session b/));
    await advance(600);
    fireEvent.click(allow());
    clearRequest('b'); publish();
    expect(fake.respond.mock.calls).toEqual([['a', { behavior: 'allow' }], ['b', { behavior: 'allow' }]]);
  });

  it('keeps the card usable for a retry after a failed delivery and says so in the row', async () => {
    addRequest('a', 'req-a', { submissionFailed: true });
    await mount();
    expect(row(/Session a/).textContent).toContain('Not sent');
    fireEvent.click(row(/Session a/));
    await advance(600);
    expect((allow() as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(allow());
    expect(fake.respond).toHaveBeenCalledTimes(1);
  });

  it('lays the prompt actions out compactly inside the inspector', async () => {
    addRequest('a');
    await mount();
    fireEvent.click(row(/Session a/));
    await advance(600);
    expect(within(screen.getByRole('region', { name: 'Request from Session a' })).getByTestId('decision-gate')
      .querySelector('[data-compact-actions]')).toBeTruthy();
    act(() => { clearRequest('a'); });
  });
});
