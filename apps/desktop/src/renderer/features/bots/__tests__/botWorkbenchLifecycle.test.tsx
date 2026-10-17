// @vitest-environment jsdom

import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { _resetStore, closeTab, getBucket } from '@/features/right-sidebar/store';
import { openBotWorkbenchTab } from '@/features/right-sidebar/lib/openBotWorkbenchTab';
import { _resetSidebarCommandsForTests, onRequestRightSidebarVisibility } from '@/features/right-sidebar/lib/sidebarCommands';
import { readPanelCollapsedRecord, writePanelCollapsed } from '@/layout/collapsePrefs';
import { BotSessionView } from '../BotSessionView';

// Keep the real Bot route gate, workbench initializer, tab store and preferences.
// The model/chat surface and host database are isolated; no Electron app is started.
vi.mock('react-router-dom', () => ({
  useParams: () => ({ botId: 'bot', sessionId: 'chat' }),
  useNavigate: () => vi.fn(), Navigate: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useBotIslandVisibleSession', () => ({ useBotIslandVisibleSession: () => {} }));
vi.mock('../botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({ CCAgentSessionView: () => <div>chat</div> }));
vi.mock('@/features/right-sidebar/lib/detachedSidebarRouting', () => ({ routeSidebarCommand: async () => 'attached' }));

const visibility = vi.fn();
const listTabs = vi.fn(async () => ({ tabs: [], activeTabId: null, persistable: false }));
beforeEach(() => {
  _resetStore(); _resetSidebarCommandsForTests(); localStorage.clear(); visibility.mockClear(); listTabs.mockClear();
  onRequestRightSidebarVisibility(visibility);
  window.electronAPI = {
    localDb: {
      bots: { list: async () => [], get: async () => ({ id: 'bot', name: 'Cindy', status: 'active', sessions: [
        { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
      ] }) },
      rightSidebarTabs: { list: listTabs },
    },
  } as unknown as Window['electronAPI'];
});
afterEach(() => { cleanup(); _resetStore(); _resetSidebarCommandsForTests(); });

it('the actual Bot view respects a closed workbench through remount and a fresh store, until explicitly reopened', async () => {
  const first = render(<BotSessionView />);
  await waitFor(() => expect(getBucket('chat').tabs).toHaveLength(1));
  await act(async () => { await closeTab('chat', getBucket('chat').tabs[0]!.id); });
  writePanelCollapsed('right-tabs', { sessionId: 'chat' }, true);
  visibility.mockClear(); first.unmount();
  const second = render(<BotSessionView />);
  await waitFor(() => expect(second.getByText('chat')).toBeTruthy());
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();
  second.unmount(); _resetStore();
  const third = render(<BotSessionView />);
  await waitFor(() => expect(third.getByText('chat')).toBeTruthy());
  expect(visibility).not.toHaveBeenCalled();
  expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'chat' })).toBe(true);
  await act(async () => { await openBotWorkbenchTab('chat', 'bot'); });
  expect(getBucket('chat').tabs[0]?.kind).toBe('bot-workbench');
  expect(visibility).toHaveBeenCalledOnce();
});

it('unmounting the actual Bot view cancels late first-visit hydration', async () => {
  let release!: () => void;
  listTabs.mockImplementationOnce(async () => {
    await new Promise<void>((resolve) => { release = resolve; });
    return { tabs: [], activeTabId: null, persistable: false };
  });
  const view = render(<BotSessionView />);
  await waitFor(() => expect(listTabs).toHaveBeenCalledOnce());
  view.unmount();
  await act(async () => { release(); });
  expect(getBucket('chat').tabs).toEqual([]);
  expect(visibility).not.toHaveBeenCalled();
  expect(readPanelCollapsedRecord('right-tabs', { sessionId: 'chat' })).toBeNull();
});
