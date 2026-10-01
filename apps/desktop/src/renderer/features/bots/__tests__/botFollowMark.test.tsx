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
import { __testing } from '../botFollowScopes';

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
const followScopes = vi.fn(async () => [{ botId: 'bot-1', directories: ['/Users/me/repo'] }]);

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
  it('marks a task inside a handed-over project with its Bot, loading the scopes once for all rows', async () => {
    await act(async () => {
      render(<><Row session={session()} /><Row session={session({ id: 's2' })} /></>);
    });
    const marks = screen.getAllByTestId('bot-follow-mark');
    expect(marks).toHaveLength(2);
    expect(marks[0]!.getAttribute('aria-label')).toBe('bots.workbench.followingMark:Dash');
    expect(followScopes).toHaveBeenCalledTimes(1);
  });

  it('stays empty outside the project, for Bot-owned or remote tasks, and for hidden Bots', async () => {
    await act(async () => {
      render(<>
        <Row session={session({ workingDir: '/Users/me/repo-old' })} />
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
      { botId: 'bot-1', directories: ['/Users/me/repo'] },
      { botId: 'bot-2', directories: ['/Users/me'] },
    ]);
    await act(async () => { changed?.(); });
    expect(screen.getByTestId('bot-follow-mark').getAttribute('aria-label'))
      .toBe('bots.workbench.followingMark:Dash and Lizi');
  });
});
