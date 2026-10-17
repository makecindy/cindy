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
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => mocks.cloud }));
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
  renderHook(() => useTeammateSearchMatches(query)).result.current.map((match) => match.name);

describe('teammates in the sidebar-wide search', () => {
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
    const matches = renderHook(() => useTeammateSearchMatches('旅行')).result.current;
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
    const matches = renderHook(() => useTeammateSearchMatches('出游')).result.current;
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
    const { result } = renderHook(() => useTeammateSearchMatches('e'));
    render(<TeammateSearchResults matches={result.current} onSelected={onSelected} />);

    fireEvent.click(screen.getByRole('button', { name: /Cloud helper/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/remote/mac-mini/cloud');
    fireEvent.click(screen.getByRole('button', { name: /Writer/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/writer');
    expect(onSelected).toHaveBeenCalledTimes(2);
  });

  it('labels group chats apart from teammates', () => {
    const { result } = renderHook(() => useTeammateSearchMatches('出游'));
    render(<TeammateSearchResults matches={result.current} />);
    fireEvent.click(screen.getByRole('button', { name: /周末出游/ }));
    expect(mocks.navigate).toHaveBeenLastCalledWith('/bots/groups/trip');
    expect(screen.getByText('bots.groupChat.sidebar.title')).toBeTruthy();
  });
});
