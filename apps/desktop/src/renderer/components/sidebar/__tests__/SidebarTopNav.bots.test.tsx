// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MainViewHistoryProvider } from '@/contexts/MainViewHistoryContext';
import { SidebarTopNav } from '../SidebarTopNav';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({ 'sidebar.tabs.bots': '伙伴', 'sidebar.backToSessions': '返回任务' })[key] ?? key,
  }),
}));
vi.mock('@/cindy-brain/ghostUnreadStore', () => ({ useAnyGhostUnread: () => false }));
vi.mock('@/cindy-brain/GhostPanelRestoreEntry', () => ({ GhostPanelRestoreEntry: () => null }));
vi.mock('../GhostMainViewNavEntries', () => ({ GhostMainViewNavEntries: () => null }));
vi.mock('@/features/cc-agent/sidebar/SidebarInlineSearch', () => ({ SidebarInlineSearch: () => null }));
vi.mock('@/features/cc-agent/sidebar/conversationSearchContext', () => ({
  useConversationSearchContext: () => ({ search: { query: '' }, allKnownProjects: [] }),
}));

afterEach(cleanup);

function NavigationHarness() {
  const location = useLocation();
  const navigate = useNavigate();
  const isTask = location.pathname.startsWith('/cc-agent');
  return (
    <>
      <SidebarTopNav section={isTask ? 'pinned' : 'all'} />
      {isTask && <SidebarTopNav section="scrollable" />}
      <output data-testid="location">{location.pathname + location.search + location.hash}</output>
      <button onClick={() => navigate('/bots/teammate-2')}>Open teammate</button>
      <button onClick={() => navigate('/plugins')}>Open plugins</button>
      <button onClick={() => navigate('/cc-agent/new-owner-session?remoteHostId=new-host#message-3')}>Open task</button>
    </>
  );
}

function Harness({ initialPath, owner = 'one' }: { initialPath: string; owner?: string }) {
  return (
    <MainViewHistoryProvider key={owner}>
      <MemoryRouter initialEntries={[initialPath]}>
        <NavigationHarness />
      </MemoryRouter>
    </MainViewHistoryProvider>
  );
}

describe('Sidebar teammate return action', () => {
  it('keeps the previous task when visiting automations before teammates', () => {
    const sessionPath = '/cc-agent/session-1?remoteHostId=host-1#message-2';
    render(<Harness initialPath={sessionPath} />);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.layout.automations' }));
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).getAttribute('aria-current')).toBe('page');
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(sessionPath);
    expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
  });

  it.each(['/cc-agent/scheduled', '/cc-agent/scheduled/?filter=enabled#schedule-1'])(
    'returns to the task index after entering teammates from %s without a previous task',
    (initialPath) => {
      render(<Harness initialPath={initialPath} />);
      fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
      fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
      expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
      expect(screen.getByRole('button', { name: 'ccAgent.layout.automations' }).hasAttribute('aria-current')).toBe(false);
    },
  );

  it('does not seed a new owner from the unchanged router entry', () => {
    const oldPath = '/cc-agent/old-owner-session?remoteHostId=old-host#message-2';
    function OwnerRouter({ owner }: { owner: string }) {
      const location = useLocation();
      return (
        <MainViewHistoryProvider ownerKey={owner} locationKey={location.key}>
          <NavigationHarness key={owner} />
        </MainViewHistoryProvider>
      );
    }
    function PersistentRouter({ owner }: { owner: string }) {
      return <MemoryRouter initialEntries={[oldPath]}><OwnerRouter owner={owner} /></MemoryRouter>;
    }
    const view = render(<PersistentRouter owner="one" />);
    view.rerender(<PersistentRouter owner="two" />);
    expect(screen.getByTestId('location').textContent).toBe(oldPath);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');

    const newPath = '/cc-agent/new-owner-session?remoteHostId=new-host#message-3';
    fireEvent.click(screen.getByRole('button', { name: 'Open task' }));
    view.rerender(<PersistentRouter owner="two" />);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(newPath);
  });

  it('changes the existing entry and restores both destinations across sidebar remounts', () => {
    const sessionPath = '/cc-agent/session-1?remoteHostId=host-1#message-2';
    render(<Harness initialPath={sessionPath} />);
    const initialButtonCount = screen.getAllByRole('button').length;
    const entry = screen.getByRole('button', { name: '伙伴' });
    expect(entry.querySelector('.lucide-bot')).not.toBeNull();
    fireEvent.click(entry);

    const back = screen.getByRole('button', { name: '返回任务' });
    expect(back.textContent).toBe('返回任务');
    expect(back.querySelector('.lucide-arrow-left')).not.toBeNull();
    expect(back.hasAttribute('aria-current')).toBe(false);
    expect(back.hasAttribute('aria-pressed')).toBe(false);
    expect(back.className).not.toContain('bg-sidebar-item-active');
    expect(screen.queryByRole('button', { name: '伙伴' })).toBeNull();
    expect(screen.getAllByRole('button')).toHaveLength(initialButtonCount);

    fireEvent.click(screen.getByRole('button', { name: 'Open teammate' }));
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe(sessionPath);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots/teammate-2');
  });

  it('returns a direct teammate entry to the session index, even after visiting plugins', () => {
    render(<Harness initialPath="/bots/teammate-2" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open plugins' }));
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    expect(screen.getByTestId('location').textContent).toBe('/bots/teammate-2');
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });

  it('discards remembered destinations when the account scope changes', () => {
    const view = render(<Harness initialPath="/cc-agent/private-session" />);
    fireEvent.click(screen.getByRole('button', { name: '伙伴' }));
    view.rerender(<Harness initialPath="/bots" owner="two" />);
    fireEvent.click(screen.getByRole('button', { name: '返回任务' }));
    expect(screen.getByTestId('location').textContent).toBe('/cc-agent');
  });
});
