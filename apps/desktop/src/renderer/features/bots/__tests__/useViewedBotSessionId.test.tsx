// @vitest-environment jsdom
import { renderHook } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  profiles: [
    { id: 'writer', sessions: [{ id: 'writer-chat', role: 'canonical' }] },
    { id: 'roster-less', sessions: [] },
  ],
  remoteBots: [
    { id: 'cindy-default', deviceId: 'cloud', sessionId: 'cloud-chat' },
    { id: 'cindy-default', deviceId: 'mac', sessionId: null },
  ],
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => mocks.profiles,
  canonicalBotSessionId: (bot: { sessions: Array<{ id: string; role?: string }> }) =>
    bot.sessions.find((session) => session.role === 'canonical')?.id,
}));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => mocks.remoteBots }));

import { useViewedBotSessionId } from '../useViewedBotSessionId';

function viewedAt(path: string) {
  const wrapper = ({ children }: { children: ReactNode }) =>
    <MemoryRouter initialEntries={[path]}>{children}</MemoryRouter>;
  return renderHook(() => useViewedBotSessionId(), { wrapper }).result.current;
}

describe('useViewedBotSessionId', () => {
  it('uses the session in the route for session and history chats', () => {
    expect(viewedAt('/bots/writer/session/task-7')).toBe('task-7');
    expect(viewedAt('/bots/writer/history/old-chat')).toBe('old-chat');
  });

  it('resolves a teammate route to its canonical chat', () => {
    expect(viewedAt('/bots/writer')).toBe('writer-chat');
    expect(viewedAt('/bots/roster-less')).toBeUndefined();
  });

  it('resolves a remote teammate route through the device roster', () => {
    expect(viewedAt('/bots/remote/cloud/cindy-default')).toBe('cloud-chat');
    expect(viewedAt('/bots/remote/mac/cindy-default')).toBeUndefined();
    expect(viewedAt('/bots/remote/gone/cindy-default')).toBeUndefined();
  });

  it.each(['/bots', '/bots/roster', '/bots/list', '/bots/groups/g1', '/cc-agent/writer-chat', '/plugins'])(
    'reports nothing being viewed on %s',
    (path) => {
      expect(viewedAt(path)).toBeUndefined();
    },
  );
});
