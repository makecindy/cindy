// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  BOT_GROUP_LANE_SESSION,
  botOwnedSessionNotificationTitle,
} from '@/lib/sessionEventNotification';
import { BotLifecycleSettings } from '../BotLifecycleSettings';
import { isBotGroupLaneSession, withoutBotGroupLanes } from '../botGroupLane';
import { botRosterActivityAt } from '../botRosterDisplay';
import type { BotProfile } from '../botStore';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({
  useConfirmDialog: () => ({ confirm: vi.fn(async () => true) }),
}));

function profile(sessions: BotProfile['sessions']): BotProfile {
  return {
    id: 'bot-1',
    name: 'Helper',
    description: '',
    avatar: '🤖',
    avatarColor: 'violet',
    enabled: true,
    status: 'active',
    skills: [],
    capabilities: {
      model: 'test-model',
      effort: '',
      fastMode: false,
      harness: 'pi',
      modelChain: [{ harness: 'pi', model: 'test-model', providerId: null, effort: '', fastMode: false }],
      skillMode: 'inherit',
      skillsExcluded: [],
      toolsetMode: 'inherit',
      toolsets: [],
      mcpMode: 'inherit',
      mcpServers: [],
      memory: true,
      permissions: 'ask',
    },
    createdAt: 1,
    sessions,
  };
}

const lane = { id: 'lane', title: 'group lane', kind: 'group' as const, role: 'group' as const, updatedAt: 900 };
const archivedLane = { ...lane, id: 'archived-lane', kind: 'history' as const, status: 'archived' as const };
const history = { id: 'old', title: 'Old private task', kind: 'history' as const, role: 'history' as const, updatedAt: 5 };

beforeEach(() => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value: {
      localDb: {
        bots: {
          list: vi.fn(async () => [
            { id: 'bot-1', name: 'Helper', sessions: [lane, { id: 'chat', title: 'Helper', role: 'canonical' }] },
          ]),
          health: vi.fn(async () => null),
          lifecycleEvents: vi.fn(async () => []),
          searchHistory: vi.fn(async () => ({ results: [] })),
        },
      },
    },
  });
});

afterEach(cleanup);

describe('group lanes stay out of a teammate’s own surfaces', () => {
  it('identifies lanes by role or kind', () => {
    expect(isBotGroupLaneSession(lane)).toBe(true);
    expect(isBotGroupLaneSession({ kind: 'group' })).toBe(true);
    expect(isBotGroupLaneSession(history)).toBe(false);
    expect(withoutBotGroupLanes([lane, history, archivedLane])).toEqual([history]);
  });

  it('does not let group activity reorder the teammate roster', () => {
    expect(botRosterActivityAt(profile([history, lane]))).toBe(5);
  });

  it('keeps lanes, even archived ones, out of the history list', () => {
    render(
      <MemoryRouter>
        <BotLifecycleSettings bot={profile([history, lane, archivedLane])} onOpenSession={vi.fn()} mode="history" />
      </MemoryRouter>,
    );
    expect(screen.getByText('Old private task')).toBeTruthy();
    expect(screen.queryByText('group lane')).toBeNull();
  });

  it('marks lanes so notification owners can skip them', async () => {
    await expect(botOwnedSessionNotificationTitle('lane')).resolves.toBe(BOT_GROUP_LANE_SESSION);
    await expect(botOwnedSessionNotificationTitle('chat')).resolves.toBe('Helper');
  });
});
