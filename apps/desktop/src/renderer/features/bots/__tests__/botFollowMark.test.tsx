// @vitest-environment jsdom

import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Session } from '@/lib/ccAgent.types';

const h = vi.hoisted(() => ({
  profiles: [] as Array<Record<string, unknown>>,
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

import { BotFollowMark, useSessionFollowers } from '../BotFollowMark';
import { __testing, useSessionDelegatingBot } from '../botFollowScopes';
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

  it('keeps naming the Bot for its archived background task, while the follow mark stays active-only', async () => {
    followScopes.mockResolvedValueOnce([{ botId: 'bot-1', sessionIds: ['s2'], delegatedSessionIds: ['s2'] }]);
    const archived = session({ id: 's2', status: 'archived' });
    await act(async () => render(<><Owner session={archived} /><Row session={archived} /></>));
    expect(screen.getByTestId('owner').textContent).toBe('Dash');
    expect(screen.queryByTestId('bot-follow-mark')).toBeNull();
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
