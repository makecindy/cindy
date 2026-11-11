// @vitest-environment jsdom
// W1-W3 regression: main-only badge mounting formerly also owned all list/outbox effects.
// Execute the production lifecycle boundary in both full-app windows, not a source-text check.
import { useEffect } from 'react';
import { cleanup, render } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const state = vi.hoisted(() => ({
  owner: { dataOwnerId: 'account-a' as string | null, generation: 1 },
  ready: true, secondary: false, sidebar: false,
  dbStatus: 'ready',
  events: [] as string[],
}));
vi.mock('@/contexts/AuthContext', () => ({ useAuth: () => ({ canEnterApp: state.ready, dataOwnerId: state.owner.dataOwnerId }) }));
vi.mock('@/contexts/AppShellCoverContext', () => ({ useAppShellCover: () => ({ localDbGateStatus: state.dbStatus }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => state.owner }));
vi.mock('@/lib/secondaryWindow', () => ({ isSecondaryWindow: () => state.secondary }));
vi.mock('@/lib/sidebarWindow', () => ({ isSidebarWindow: () => state.sidebar }));
vi.mock('@/features/bots/botReadState', () => ({ startBotReadStateSync: () => {
  state.events.push('read:start'); return () => { state.events.push('read:stop'); };
} }));
vi.mock('@/features/bots/botGroupOutbox', () => ({ startBotGroupOutbox: () => {
  state.events.push('outbox:start'); return () => { state.events.push('outbox:stop'); };
} }));
vi.mock('@/features/bots/useBotUnreadSync', () => ({ useBotUnreadSync: () => {
  useEffect(() => { state.events.push('local:start'); return () => { state.events.push('local:stop'); }; }, [state.owner]);
} }));
vi.mock('@/features/bots/useRemoteBots', () => ({ useRemoteBotSync: () => {
  useEffect(() => { state.events.push('remote:start'); return () => { state.events.push('remote:stop'); }; }, [state.owner]);
} }));
vi.mock('../components/layout/AppBadgeAttentionSync', () => ({ AppBadgeAttentionSync: () => <span data-testid="system-attention" /> }));
import { AppWindowSync } from '../components/layout/AppWindowSync';

beforeEach(() => {
  state.owner = { dataOwnerId: 'account-a', generation: 1 };
  state.ready = true; state.secondary = false; state.sidebar = false; state.events = [];
  state.dbStatus = 'ready';
});
afterEach(cleanup);

// 2026-11-10 startup regression, unit/jsdom: auth precedes the slow DB gate.
// Existing tests only delayed auth, so badge's two session queries ran too early.
it('waits for the owner database before mounting list consumers and resumes once ready', () => {
  state.dbStatus = 'pending';
  const view = render(<AppWindowSync />);
  expect(state.events).toEqual([]);
  expect(view.queryByTestId('system-attention')).toBeNull();
  state.dbStatus = 'ready';
  view.rerender(<AppWindowSync />);
  expect(view.queryByTestId('system-attention')).not.toBeNull();
  expect(state.events.filter(event => event.endsWith(':start'))).toHaveLength(4);
  state.dbStatus = 'pending';
  view.rerender(<AppWindowSync />);
  expect(view.queryByTestId('system-attention')).toBeNull();
  expect(state.events.filter(event => event.endsWith(':stop'))).toHaveLength(4);
});

it('starts list/read/outbox mirrors in each full window but publishes system attention only in main', () => {
  const main = render(<AppWindowSync />);
  expect(main.queryByTestId('system-attention')).not.toBeNull();
  expect(state.events).toEqual(['read:start', 'local:start', 'remote:start', 'outbox:start']);
  state.secondary = true;
  const secondary = render(<AppWindowSync />);
  expect(secondary.container.querySelector('[data-testid="system-attention"]')).toBeNull();
  expect(state.events.filter(event => event === 'outbox:start')).toHaveLength(2);
  main.unmount();
  // Closing main tears down only its effects: the other full window still owns its worker.
  expect(state.events.filter(event => event === 'outbox:stop')).toHaveLength(1);
  secondary.unmount();
  expect(state.events.filter(event => event === 'outbox:stop')).toHaveLength(2);
});

it('keeps workers alive across sibling routes and restarts them at an owner-generation boundary', () => {
  const view = render(<AppWindowSync />);
  window.history.replaceState(null, '', '/#/settings');
  view.rerender(<AppWindowSync />);
  expect(state.events.filter(event => event.endsWith(':start'))).toHaveLength(4);
  state.owner = { dataOwnerId: 'account-a', generation: 2 };
  view.rerender(<AppWindowSync />);
  expect(state.events.filter(event => event.endsWith(':stop'))).toHaveLength(4);
  expect(state.events.filter(event => event.endsWith(':start'))).toHaveLength(8);
  state.ready = false;
  view.rerender(<AppWindowSync />);
  expect(state.events.filter(event => event.endsWith(':stop'))).toHaveLength(8);
  expect(view.container.textContent).toBe('');
});

it.each(['not-ready', 'no-owner', 'sidebar'] as const)('does not start recovery or system publishers for %s', condition => {
  if (condition === 'not-ready') state.ready = false;
  if (condition === 'no-owner') state.owner = { dataOwnerId: null, generation: 2 };
  if (condition === 'sidebar') state.sidebar = true;
  const view = render(<AppWindowSync />);
  expect(state.events).toEqual([]);
  expect(view.container.childElementCount).toBe(0);
});
