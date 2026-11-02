// @vitest-environment jsdom
import { cleanup, fireEvent, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeammateSearchResults, useTeammateSearchMatches } from '../TeammateSearchResults';

const mocks = vi.hoisted(() => ({
  profiles: [] as unknown[],
  remoteBots: [] as unknown[],
  groups: [] as unknown[],
  navigate: vi.fn(),
  cloud: { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] } as import('../../../../shared/companionCloud').CompanionCloudSnapshot,
}));

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => mocks.cloud, getRetiredCompanionBotIds: () => new Set<string>() }));
vi.mock('../botGroupStore', () => ({ useBotGroupList: () => ({ groups: mocks.groups }) }));
vi.mock('../BotAvatar', () => ({ BotAvatar: () => <span data-testid="avatar" /> }));

function bot(id: string, name: string, extra: Record<string, unknown> = {}) {
  return { id, name, description: '', skills: [], status: 'active', sessions: [], createdAt: 1, ...extra };
}

beforeEach(() => {
  mocks.cloud = { enabled: false, selfDeviceId: null, humanActorId: null, actors: [], demotedBotIds: [] };
  mocks.profiles = [
    bot('steward', 'PR steward', { skills: ['web-research'] }),
    bot('hidden', 'Hidden release steward', { hiddenAt: 2 }),
    bot('stopped', 'Stopped release', { status: 'archived' }),
    bot('writer', 'Writer', { description: '写周报' }),
  ];
  mocks.remoteBots = [
    { id: 'cloud', deviceId: 'mac-mini', deviceName: 'Mac mini', name: 'Cloud helper', description: '', activityAt: 1 },
  ];
  mocks.groups = [
    { id: 'trip', name: '周末出游', members: [{ botId: 'mimi', name: '咪咪', avatar: '', avatarColor: '' }] },
  ];
});
afterEach(() => {
  cleanup();
  mocks.navigate.mockReset();
});

const names = (query: string) =>
  renderHook(() => useTeammateSearchMatches(query, null)).result.current.map((match) => match.name);

describe('teammates in the sidebar-wide search', () => {
  // Issue #6575 P1: task-ID filtering did not constrain the leading roster hits.
  // Existing global-query tests never lock a dialogue group. Unit regression:
  // one matching local bot, remote bot and group must disappear while locked,
  // then become navigable again after unlocking through the real hook/results.
  // Standalone: 3.02s including pnpm (Vitest 1.18s), no module resets.
  it('excludes teammates and group chats while search is locked to a dialogue group', () => {
    mocks.profiles = [bot('local', 'Needle local')];
    mocks.remoteBots = [{ id: 'remote', deviceId: 'mac', deviceName: 'Mac', name: 'Needle remote', description: '' }];
    mocks.groups = [{ id: 'group', name: 'Needle group', members: [] }];
    function Results({ groupName }: { groupName: string | null }) {
      const matches = useTeammateSearchMatches('needle', groupName);
      return <TeammateSearchResults matches={matches} />;
    }
    const view = render(<Results groupName="Chat" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
    view.rerender(<Results groupName={null} />);
    expect(screen.getAllByRole('button')).toHaveLength(3);
    fireEvent.click(screen.getByRole('button', { name: /Needle remote/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/remote/mac/remote');
    view.rerender(<Results groupName="Chat" />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });

  it('matches nothing for an empty query', () => {
    expect(names('  ')).toEqual([]);
  });

  it('matches names, descriptions and skills, keeps hidden teammates and leaves stopped ones out', () => {
    expect(names('release')).toEqual(['Hidden release steward']);
    expect(names('WEB-RESEARCH')).toEqual(['PR steward']);
    expect(names('周报')).toEqual(['Writer']);
  });

  it('finds archived group chats, which the teammates section no longer lists, and marks them', () => {
    mocks.groups = [
      { id: 'trip', name: '周末出游', members: [] },
      { id: 'saved', name: '已完成的旅行', archived: true, members: [{ botId: 'lead', name: 'Trip Planner', avatar: '', avatarColor: '' }] },
    ];
    expect(names('旅行')).toEqual(['已完成的旅行']);
    expect(names('  PLANNER  ')).toEqual(['已完成的旅行']);
    const matches = renderHook(() => useTeammateSearchMatches('旅行', null)).result.current;
    render(<TeammateSearchResults matches={matches} />);
    expect(screen.getByText('bots.archived')).toBeTruthy();
    fireEvent.click(screen.getByText('已完成的旅行'));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/saved');
  });

  it('leaves out local copies handed to another computer, like the teammates section', () => {
    mocks.cloud = { ...mocks.cloud, demotedBotIds: ['writer'] };
    expect(names('周报')).toEqual([]);
  });

  it('finds dissolved history by group or member name and opens its read-only chat route', () => {
    mocks.groups = [{ id: 'dissolved', name: '周末出游', archived: true,
      dissolvedAt: '2026-10-15T12:00:00Z', members: [{ botId: 'lead', name: 'Trip Planner' }] }];
    expect(names('planner')).toEqual(['周末出游']);
    const matches = renderHook(() => useTeammateSearchMatches('出游', null)).result.current;
    render(<TeammateSearchResults matches={matches} />);
    fireEvent.click(screen.getByRole('button', { name: /周末出游/ }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/dissolved');
    expect(screen.queryByRole('menuitem')).toBeNull();
  });

  it('finds remote teammates by their computer and group chats by member names', () => {
    expect(names('mac mini')).toEqual(['Cloud helper']);
    expect(names('出游')).toEqual(['周末出游']);
    expect(names('咪咪')).toEqual(['周末出游']);
  });

  it('opens the chosen chat and lets the popover close itself', () => {
    const onSelected = vi.fn();
    const { result } = renderHook(() => useTeammateSearchMatches('e', null));
    render(<TeammateSearchResults matches={result.current} onSelected={onSelected} />);

    fireEvent.click(screen.getByRole('button', { name: /Cloud helper/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/remote/mac-mini/cloud');
    fireEvent.click(screen.getByRole('button', { name: /Writer/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/writer');
    expect(onSelected).toHaveBeenCalledTimes(2);
  });

  it('labels group chats apart from teammates', () => {
    const { result } = renderHook(() => useTeammateSearchMatches('出游', null));
    render(<TeammateSearchResults matches={result.current} />);
    fireEvent.click(screen.getByRole('button', { name: /周末出游/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/groups/trip');
    expect(screen.getByText('bots.groupChat.sidebar.title')).toBeTruthy();
  });
});
