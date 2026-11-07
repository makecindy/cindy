// @vitest-environment jsdom

import { act, cleanup, render, renderHook, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const h = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, unknown>>,
  remote: [] as Array<Record<string, unknown>>,
  cindyIds: new Set<string>(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { names?: string }) => `${key}:${options?.names ?? ''}`,
    i18n: { language: 'en' },
  }),
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => h.profiles,
  hasLoadedBotProfiles: () => true,
  ensureBotProfilesLoaded: vi.fn(async () => h.profiles),
}));

vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => h.remote, useRemoteCindyIds: () => h.cindyIds }));

import { BotFollowMark, useSessionFollowers } from '../BotFollowMark';
import { __testing, useSessionDelegatingBot, useTaskCreatorIndex, useTaskCreatorOptions, matchesTaskCreators, taskBotKey } from '../botFollowScopes';
import { resetCompanionCloudStoreForTests } from '../companionCloudStore';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';

function Row({ session: value }: { session: Session }) {
  return <BotFollowMark followers={useSessionFollowers(value)} />;
}

const bot = (id: string, name: string, patch: Record<string, unknown> = {}) => ({
  id, name, avatar: '', avatarColor: 'blue', enabled: true, status: 'active', hiddenAt: null, ...patch,
});
const session = (patch: Partial<Session> = {}) => ({
  id: 's1', status: 'active', source: 'desktop', workingDir: '/Users/me/repo/packages/app', ...patch,
}) as Session;

let changed: (() => void) | null = null;
const followScopes = vi.fn(async (): Promise<Array<{ botId: string; sessionIds?: string[]; delegatedSessionIds?: string[] }>> =>
  [{ botId: 'bot-1', sessionIds: ['s1', 's2'] }]);

beforeEach(() => {
  __testing.reset();
  resetCompanionCloudStoreForTests();
  h.remote = [];
  h.cindyIds = new Set();
  h.profiles = [bot('bot-1', 'Dash'), bot('bot-2', 'Lizi')];
  followScopes.mockClear();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    platform: 'darwin',
    localDb: { bots: { workbench: { followScopes } } },
    maker: { onBotWorkbenchChanged: (cb: () => void) => { changed = cb; return () => { changed = null; }; } },
  };
});
afterEach(() => {
  cleanup();
  delete (window as unknown as { electronAPI?: unknown }).electronAPI;
});

describe('BotFollowMark', () => {
  it('marks an exact responsible task with its Bot, loading the scopes once for all rows', async () => {
    await act(async () => {
      render(<><Row session={session()} /><Row session={session({ id: 's2' })} /></>);
    });
    const marks = screen.getAllByTestId('bot-follow-mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]!.getAttribute('aria-label')).toBe('bots.workbench.followingMark:Dash');
    expect(followScopes).toHaveBeenCalledTimes(1);
  });

  it('stays empty for unrelated tasks, for Bot-owned or remote tasks, and for hidden Bots', async () => {
    await act(async () => {
      render(<>
        <Row session={session({ id: 'unrelated', workingDir: '/Users/me/repo' })} />
        <Row session={session({ source: 'bot' })} />
        <Row session={session({ remoteHostId: 'ssh-1' })} />
      </>);
    });
    expect(screen.queryByTestId('bot-follow-mark')).toBeNull();

    cleanup();
    h.profiles = [bot('bot-1', 'Dash', { hiddenAt: 1 })];
    await act(async () => { render(<Row session={session()} />); });
    expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
  });

  it('retries a failed first load instead of leaving the marker missing', async () => {
    vi.useFakeTimers();
    try {
      followScopes.mockRejectedValueOnce(new Error('host not ready'));
      await act(async () => { render(<Row session={session()} />); });
      expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
      await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
      expect(screen.getByTestId('bot-follow-mark')).toBeTruthy();
      expect(followScopes).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('reloads when a workbench changes', async () => {
    await act(async () => { render(<Row session={session()} />); });
    followScopes.mockResolvedValueOnce([
      { botId: 'bot-1', sessionIds: ['s1', 's2'] },
      { botId: 'bot-2', sessionIds: ['s1'] },
    ]);
    await act(async () => { changed?.(); });
    expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label'))
      .toBe('bots.workbench.followingMark:Dash and Lizi');
  });
});

it('never marks same-directory bystanders, but marks a responsible task after a project move', async () => {
  await act(async () => render(<><Row session={session({ id: 'unrelated' })} /><Row session={session({ workingDir: '/moved' })} /></>));
  expect(screen.getAllByTestId('bot-follow-mark')).toHaveLength(1);
});
it('does not infer responsibility from an older host directory-only payload', async () => {
  followScopes.mockResolvedValueOnce([{ botId: 'bot-1', directories: ['/Users/me/repo'] }] as any);
  await act(async () => render(<Row session={session()} />));
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
});
describe('useSessionDelegatingBot', () => {
  function Owner({ session: value }: { session: Session }) {
    const bot = useSessionDelegatingBot(value);
    return <span data-testid="owner">{bot ? bot.name : 'none'}</span>;
  }

  it("names the Bot only for its own background task, not for an ordinary task it took over", async () => {
    followScopes.mockResolvedValueOnce([
      { botId: 'bot-1', sessionIds: ['s1', 's2'], delegatedSessionIds: ['s2'] },
      { botId: 'bot-2', sessionIds: ['s1'], delegatedSessionIds: [] },
    ]);
    await act(async () => render(<><Owner session={session()} /><Owner session={session({ id: 's2' })} /></>));
    // s1 is the owner's task both Bots follow; s2 is Dash's background task.
    expect(screen.getAllByTestId('owner').map((node) => node.textContent)).toEqual(['none', 'Dash']);
    expect(followScopes).toHaveBeenCalledTimes(1);
  });

  it('keeps the creator avatar after archiving but does not carry over a mere follow relationship', async () => {
    followScopes.mockResolvedValueOnce([{ botId: 'bot-1', sessionIds: ['s2', 's3'], delegatedSessionIds: ['s2'] }]);
    const archived = session({ id: 's2', status: 'archived' });
    await act(async () => render(<><Owner session={archived} /><Row session={archived} /><Row session={session({id: 's3', status: 'archived'})} /></>));
    expect(screen.getByTestId('owner').textContent).toBe('Dash');
    expect(screen.getAllByTestId('bot-follow-mark')).toHaveLength(1);
    expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label')).toBe('bots.workbench.createdMark:Dash');
  });

  it('does not guess from an older host that only lists responsibilities', async () => {
    await act(async () => render(<Owner session={session()} />));
    expect(screen.getByTestId('owner').textContent).toBe('none');
  });
});

it('removes marks when a task is released', async () => {
  await act(async () => render(<Row session={session()} />));
  expect(screen.getByTestId('bot-follow-mark')).toBeTruthy();
  followScopes.mockResolvedValueOnce([]);
  await act(async () => changed?.());
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
});


it('keeps different companions on their own task IDs, including directory-free tasks', async () => {
  followScopes.mockResolvedValueOnce([{ botId: 'bot-1', sessionIds: ['s1'] }, { botId: 'bot-2', sessionIds: ['s2'] }]);
  await act(async () => render(<><Row session={session({ workingDir: null })} /><Row session={session({ id: 's2' })} /><Row session={session({ deviceLinkDeviceId: 'remote' })} /></>));
  expect(screen.getAllByTestId('bot-follow-mark').map(mark => mark.getAttribute('aria-label'))).toEqual(['bots.workbench.followingMark:Dash', 'bots.workbench.followingMark:Lizi']);
});
it('ignores a late responsibility snapshot after switching owners', async () => {
  let finish!: (value: Array<{ botId: string; sessionIds: string[] }>) => void;
  followScopes.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const view = render(<Row session={session()} />);
  await act(async () => { setDataOwnerGeneration('next-owner'); view.rerender(<Row session={session()} />); });
  followScopes.mockResolvedValueOnce([]);
  await act(async () => { finish([{ botId: 'bot-1', sessionIds: ['s1'] }]); changed?.(); });
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
});

// Regression: Desktop ignored advertised remote following links and excluded remote rows.
it('uses the remote computer identity for marks and never borrows a same-ID local Bot', async () => {
  h.remote = [{ ...bot('bot-1', 'Remote Dash'), deviceId: 'laptop', followingSessionIds: ['s1'] }];
  const view = render(<Row session={session({ deviceLinkDeviceId: 'laptop' })} />);
  await act(async () => {});
  expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label')).toContain('Remote Dash');
  view.rerender(<Row session={session({ deviceLinkDeviceId: 'other-computer' })} />);
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
  h.remote = [];
  view.rerender(<Row session={session({ deviceLinkDeviceId: 'laptop' })} />);
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
});

it('shows the remote creator mark when an older host only provides task-card attribution', async () => {
  h.remote = [{ ...bot('bot-1', 'Remote Dash'), deviceId: 'laptop', followingSessionIds: [], delegatedSessionIds: ['s1'] }];
  const view = render(<Row session={session({ deviceLinkDeviceId: 'laptop' })} />);
  await act(async () => {});
  expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label')).toContain('Remote Dash');
  view.rerender(<Row session={session({ deviceLinkDeviceId: 'laptop', status: 'archived' })} />);
  expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label')).toBe('bots.workbench.createdMark:Remote Dash');
  view.rerender(<Row session={session({ deviceLinkDeviceId: 'other' })} />);
  expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
});

it('filters single and multiple creators, including archived tasks, independently of follow responsibility', async () => {
  followScopes.mockResolvedValueOnce([
    { botId: 'bot-1', sessionIds: ['s1'], delegatedSessionIds: ['s2'] },
    { botId: 'bot-2', sessionIds: ['s3'], delegatedSessionIds: ['s3'] },
  ]);
  h.remote = [{ ...bot('bot-1', 'Remote Dash'), deviceId: 'laptop', delegatedSessionIds: ['s2'] }];
  const { result } = renderHook(useTaskCreatorIndex);
  await act(async () => {});
  const local = taskBotKey({ id: 'bot-1' });
  const remote = taskBotKey({ id: 'bot-1', deviceId: 'laptop' });
  const tasks = [session(), session({ id: 's2', status: 'archived' }), session({ id: 's3' }),
    session({ id: 's2', deviceLinkDeviceId: 'laptop' }), session({ id: 's2', deviceLinkDeviceId: 'other' })];
  const matching = (selection: 'all' | string[]) => tasks.filter(task => matchesTaskCreators(task, selection, result.current));
  expect(matching('all')).toEqual(tasks);
  expect(matching([local])).toEqual([tasks[1]]);
  expect(matching([remote])).toEqual([tasks[3]]);
  expect(matching([local, remote])).toEqual([tasks[1], tasks[3]]);
});

// User regression: one built-in Cindy must filter local and remote creations together.
it('offers one Cindy across computers without merging a custom namesake or unrelated same-ID bots', async () => {
  h.profiles = [bot('cindy-default', 'Cindy'), bot('custom', 'Cindy')];
  h.remote = [
    { ...bot('remote-cindy', 'Renamed', { templateId: 'cindy' }), deviceId: 'laptop', deviceName: 'Laptop', delegatedSessionIds: ['remote-child'] },
    { ...bot('custom', 'Cindy'), deviceId: 'laptop', delegatedSessionIds: ['custom-child'] },
  ];
  followScopes.mockResolvedValueOnce([{ botId: 'cindy-default', delegatedSessionIds: ['local-child'] }]);
  const { result, rerender } = renderHook(() => ({ options: useTaskCreatorOptions(), index: useTaskCreatorIndex() }));
  await act(async () => {});
  expect(result.current.options).toHaveLength(3);
  const cindy = result.current.options.find(bot => bot.id === 'cindy-default')!;
  expect(cindy.filterMemberKeys).toEqual([taskBotKey({ id: 'cindy-default' }), taskBotKey({ id: 'remote-cindy', deviceId: 'laptop' })]);
  expect(cindy.deviceName).toBeUndefined();
  const { taskCreatorFilterKey } = await import('../cindyDeviceRoster');
  const selected = [taskCreatorFilterKey(cindy)];
  const tasks = [session({ id: 'local-child' }), session({ id: 'remote-child', deviceLinkDeviceId: 'laptop', status: 'archived' }),
    session({ id: 'custom-child', deviceLinkDeviceId: 'laptop' }), session()];
  expect(tasks.filter(task => matchesTaskCreators(task, selected, result.current.index))).toEqual(tasks.slice(0, 2));
  expect(tasks.filter(task => matchesTaskCreators(task, 'none', result.current.index))).toEqual([tasks[3]]);
  h.remote = [...h.remote, { ...bot('new-cindy', 'Cindy', { templateId: 'cindy' }), deviceId: 'new-host', delegatedSessionIds: ['new-child'] }];
  rerender();
  expect(result.current.options).toHaveLength(3);
  expect(matchesTaskCreators(session({ id: 'new-child', deviceLinkDeviceId: 'new-host' }), selected, result.current.index)).toBe(true);
});

// The filter must reuse the main roster's retired-copy rules, not resurrect a demoted local Cindy.
it('hides retired copies and filters one cloud companion across its old and current computers', async () => {
  h.profiles = [bot('cindy-default', 'Cindy'), bot('cloud-bot', 'Cindy')];
  h.remote = [{ ...bot('cloud-bot', 'Cindy'), deviceId: 'laptop', delegatedSessionIds: ['remote-child'] }];
  resetCompanionCloudStoreForTests({ enabled: true, selfDeviceId: 'desktop', humanActorId: 'human', demotedBotIds: ['cindy-default'],
    actors: [{ id: 'actor', externalId: 'cloud-bot', name: 'Cindy', avatar: null, homeDeviceId: 'laptop', homeDevice: { deviceId: 'laptop', name: 'Mac Studio', online: true, isSelf: false } }] });
  followScopes.mockResolvedValueOnce([{ botId: 'cloud-bot', delegatedSessionIds: ['local-child'] }]);
  const { result } = renderHook(() => ({ options: useTaskCreatorOptions(), index: useTaskCreatorIndex() }));
  await act(async () => {});
  expect(result.current.options).toHaveLength(1);
  const option = result.current.options[0]!;
  expect(option.id).toBe('cloud-bot');
  expect(option.deviceName).toBeUndefined();
  expect(option.filterMemberKeys).toContain(taskBotKey({ id: 'cloud-bot' }));
  const { taskCreatorFilterKey } = await import('../cindyDeviceRoster');
  const selection = [taskCreatorFilterKey(option)];
  expect(matchesTaskCreators(session({ id: 'local-child', status: 'archived' }), selection, result.current.index)).toBe(true);
  expect(matchesTaskCreators(session({ id: 'remote-child', deviceLinkDeviceId: 'laptop' }), selection, result.current.index)).toBe(true);
});

// Unit: the same bot id on another device must not steal ownership; archived lanes retain their avatar.
it.each(['routine', 'channel'])('uses exact local/remote ownership for %s avatars and filtering', async role => {
  h.remote = [bot('bot-1', 'Remote Dash', { deviceId: 'remote', deviceName: 'Mac' })];
  const local = session({ source: 'bot', companion: { id: 'bot-1', role }, status: 'archived' });
  const remote = session({ ...local, deviceLinkDeviceId: 'remote' });
  await act(async () => render(<><Row session={local} /><Row session={remote} /></>));
  expect(screen.getAllByTestId('bot-follow-mark').map(mark => mark.getAttribute('aria-label')))
    .toEqual(['bots.workbench.ownedMark:Dash', 'bots.workbench.ownedMark:Remote Dash']);
  const { result } = renderHook(useTaskCreatorIndex);
  const localKey = taskBotKey({ id: 'bot-1' });
  const remoteKey = taskBotKey({ id: 'bot-1', deviceId: 'remote' });
  expect(matchesTaskCreators(local, [localKey], result.current)).toBe(true);
  expect(matchesTaskCreators(remote, [localKey], result.current)).toBe(false);
  expect(matchesTaskCreators(remote, [remoteKey], result.current)).toBe(true);
  expect(matchesTaskCreators(local, [localKey, remoteKey], result.current)).toBe(true);
  expect(matchesTaskCreators(local, 'none', result.current)).toBe(false);
  expect(matchesTaskCreators(remote, 'none', new Map())).toBe(false);
});

// Unit / review4390134785: existing coverage starts with a real roster, missing
// the cloud-only -> known-Cindy -> online transition and saved companion alias.
it('keeps a cloud-only Cindy selection valid when identity and its home roster arrive', async () => {
  resetCompanionCloudStoreForTests({ enabled: true, selfDeviceId: 'desktop', humanActorId: 'human', demotedBotIds: [],
    actors: [{ id: 'actor', externalId: 'cloud-cindy', name: 'Cindy', avatar: null, homeDeviceId: 'laptop' }] });
  const { normalizeTaskCreators } = await import('../../cc-agent/hooks/helpers/sidebarFilterCore');
  const { result, rerender } = renderHook(() => ({ options: useTaskCreatorOptions(), index: useTaskCreatorIndex() }));
  const old = [JSON.stringify(['companion', 'cloud-cindy'])];
  expect(result.current.options.find(b => b.id === 'cloud-cindy')?.filterKey).toBe(old[0]);
  h.cindyIds = new Set(['cloud-cindy']);
  rerender();
  const known = result.current.options.find(b => b.id === 'cloud-cindy')!;
  const cindyKey = JSON.stringify(['teammate', 'cindy']);
  expect(known.filterKey).toBe(cindyKey);
  expect(known.deviceName).toBeUndefined();
  expect(normalizeTaskCreators(old, result.current.options)).toEqual([cindyKey]);
  h.remote = [{ ...bot('cloud-cindy', 'Renamed', { templateId: 'cindy' }), deviceId: 'laptop', delegatedSessionIds: ['child'] }];
  rerender();
  const selected = normalizeTaskCreators(old, result.current.options);
  expect(matchesTaskCreators(session({ id: 'child', deviceLinkDeviceId: 'laptop' }), selected, result.current.index)).toBe(true);
  expect(normalizeTaskCreators([...old, cindyKey], result.current.options)).toEqual([cindyKey]);
});
