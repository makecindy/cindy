// @vitest-environment jsdom
import { transferableAbortController } from 'node:util';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import { createMemoryRouter, RouterProvider } from 'react-router-dom';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
import { BotsFeatureLayout } from '../BotsFeatureLayout';
import { BotsListView } from '../BotsListView';
import { refreshBotGroups, resetBotGroupStoreForTests } from '../botGroupStore';

// React Router uses Node's Request, so its signal must come from the same realm.
const NativeAbortController = transferableAbortController().constructor;

vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
// The layout registers the shared task sidebar (with the teammates section); not under test here.
vi.mock('../../cc-agent/useRegisterCCAgentSidebar', () => ({ useRegisterCCAgentSidebar: vi.fn() }));
vi.mock('../BotSettingsDrawer', () => ({ BotSettingsDrawer: () => null }));
vi.mock('../BotGroupSettingsDrawer', () => ({ BotGroupSettingsDrawer: () => null }));

let groups: BotGroupSummary[];
function group(id = 'room', archived = false): BotGroupSummary {
  return { id, name: id, archived, serverBacked: true, revision: 1, members: [],
    replyMode: 'all', speakingMode: 'auto', organizerBotId: '', projectDir: null,
    lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null, createdAt: 1, updatedAt: 1 };
}

beforeEach(() => {
  vi.stubGlobal('AbortController', NativeAbortController);
  resetBotGroupStoreForTests();
  groups = [group()];
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker: {
    chatServer: {},
    onBotGroupChanged: vi.fn(() => () => undefined),
    listBotGroups: vi.fn(async () => ({ ok: true, groups })),
  } } });
});
afterEach(() => {
  cleanup();
  resetBotGroupStoreForTests();
  vi.unstubAllGlobals();
});

async function refresh() {
  await act(async () => { refreshBotGroups(); });
}
async function mount(path = '/bots/groups/room') {
  const router = createMemoryRouter([{ path: '/bots', element: <BotsFeatureLayout />, children: [
    { path: 'list', element: <BotsListView /> },
    { path: 'groups/:groupId', element: <main data-testid="group-content">Selected group</main> },
    { path: ':botId', element: <main data-testid="private-chat">Private chat</main> },
  ] }], { initialEntries: ['/bots/one', path], initialIndex: 1 });
  render(<RouterProvider router={router} />);
  await refresh();
  return router;
}

it.each(['/bots/groups/room', '/bots/groups/room?groupSettings=1'])(
  'clears the selected group to the unselected pane after archiving at %s', async path => {
    const router = await mount(path);
    expect(screen.getByTestId('group-content')).toBeTruthy();
    groups = [group('room', true)];
    await refresh();
    await waitFor(() => expect(router.state.location.pathname).toBe('/bots/list'));
    expect(router.state.location.search).toBe('');
    expect(screen.queryByTestId('group-content')).toBeNull();
    expect(screen.queryByTestId('private-chat')).toBeNull();
    // Back must not reopen the group just removed from the selection.
    await act(async () => { await router.navigate(-1); });
    expect(router.state.location.pathname).toBe('/bots/one');
  },
);

it('keeps the current chat when another group is archived', async () => {
  groups = [group(), group('other')];
  const router = await mount();
  groups = [group(), group('other', true)];
  await refresh();
  expect(router.state.location.pathname).toBe('/bots/groups/room');
  expect(screen.getByTestId('group-content')).toBeTruthy();
});

it('keeps the selected group while its archive state is unchanged', async () => {
  const router = await mount('/bots/groups/room?groupSettings=1');
  groups = [{ ...group(), updatedAt: 2 }];
  await refresh();
  expect(router.state.location.pathname + router.state.location.search).toBe('/bots/groups/room?groupSettings=1');
});

it('does not leave a different chat when an earlier archive finishes', async () => {
  groups = [group(), group('other')];
  const router = await mount();
  await act(async () => { await router.navigate('/bots/groups/other'); });
  groups = [group('room', true), group('other')];
  await refresh();
  expect(router.state.location.pathname).toBe('/bots/groups/other');
  await act(async () => { await router.navigate('/bots/one'); });
  await refresh();
  expect(router.state.location.pathname).toBe('/bots/one');
});

it('opens an already archived history and keeps it open when restored', async () => {
  groups = [group('room', true)];
  const router = await mount();
  expect(router.state.location.pathname).toBe('/bots/groups/room');
  expect(screen.getByTestId('group-content')).toBeTruthy();
  groups = [group()];
  await refresh();
  expect(router.state.location.pathname).toBe('/bots/groups/room');
});

it('can switch directly from an active group to another archived history', async () => {
  groups = [group(), group('saved', true)];
  const router = await mount();
  await act(async () => { await router.navigate('/bots/groups/saved'); });
  await refresh();
  expect(router.state.location.pathname).toBe('/bots/groups/saved');
  expect(screen.getByTestId('group-content')).toBeTruthy();
});
