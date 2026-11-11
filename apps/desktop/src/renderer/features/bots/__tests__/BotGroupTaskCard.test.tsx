// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BotGroupTaskCardView } from '../../../../shared/botGroupChat';
import { EMPTY_COMPANION_CLOUD_SNAPSHOT, type CompanionCloudSnapshot } from '../../../../shared/companionCloud';

const stores = vi.hoisted(() => ({ profileIds: ['bot-a'] as string[], cloud: null as CompanionCloudSnapshot | null }));
vi.mock('../botStore', () => ({ useBotProfiles: () => stores.profileIds.map((id) => ({ id })) }));
vi.mock('../companionCloudStore', () => ({ useCompanionCloud: () => stores.cloud }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key.replace('bots.groupChat.task.state.', 'state:') }),
}));
// The live card reads stores of its own; this card only decides whether to show it.
vi.mock('../BotCollaborationCard', () => ({
  BotTaskCard: ({ sessionId }: { sessionId?: string }) => <span data-testid="live-card">live:{sessionId}</span>,
}));

const nav = vi.hoisted(() => ({ navigate: vi.fn(), pin: vi.fn(), route: vi.fn(async (id: string) => `/cc-agent/${id}`) }));
vi.mock('react-router-dom', () => ({ useNavigate: () => nav.navigate }));
vi.mock('@/features/device-link/remoteProjectsStore', () => ({ remoteProjectsStore: { pinSessionOrigin: nav.pin } }));
vi.mock('@/lib/orcaSessionIdentity', () => ({ resolveSessionRoute: nav.route }));

import { BotGroupLiveTaskCard, BotGroupTaskCard } from '../BotGroupTaskCard';

const task = (state: BotGroupTaskCardView['state'], summary?: string): BotGroupTaskCardView => ({
  meta: { v: 1, role: 'delegation-request', delegationId: 'task-1', fromBotId: 'bot-a', fromBotName: 'LiZi', toBotId: null,
    toBotName: 'Cindy', parentSessionId: 'group-lane', childSessionId: 'child-1', objective: 'Write the launch post' },
  state, title: 'Launch post', ...(summary ? { summary } : {}),
});

afterEach(() => {
  cleanup();
  stores.profileIds = ['bot-a'];
  stores.cloud = EMPTY_COMPANION_CLOUD_SNAPSHOT;
});
stores.cloud = EMPTY_COMPANION_CLOUD_SNAPSHOT;

const homedOn = (homeDeviceId: string): CompanionCloudSnapshot => ({
  ...EMPTY_COMPANION_CLOUD_SNAPSHOT, enabled: true, selfDeviceId: 'this-desktop',
  actors: [{ id: 'actor-a', externalId: 'bot-a', name: 'LiZi', avatar: null, homeDeviceId }],
});

describe('BotGroupTaskCard', () => {
  it('shows another owner\'s task as the posted snapshot: title and state', () => {
    render(<BotGroupTaskCard task={task('completed')} owned={false} botId="bot-b" />);
    const card = screen.getByTestId('bot-group-task');
    expect(card.dataset.state).toBe('completed');
    expect(card.textContent).toContain('Launch post');
    expect(card.textContent).toContain('state:completed');
    expect(screen.queryByTestId('live-card')).toBeNull();
  });

  it('shows what a waiting task asks for', () => {
    render(<BotGroupTaskCard task={task('waiting', 'Which audience?')} owned={false} botId="bot-b" />);
    expect(screen.getByTestId('bot-group-task').textContent).toContain('state:waiting · Which audience?');
  });

  it('shows my own teammate\'s task as the live background-task card, read through the group lane', () => {
    render(<BotGroupTaskCard task={task('started')} owned botId="bot-a" />);
    expect(screen.getByTestId('live-card').textContent).toBe('live:group-lane');
    expect(screen.getByTestId('bot-group-task').textContent).not.toContain('state:started');
  });

  it('shows my own teammate\'s task live on its home computer', () => {
    stores.cloud = homedOn('this-desktop');
    render(<BotGroupTaskCard task={task('started')} owned botId="bot-a" />);
    expect(screen.getByTestId('live-card')).toBeTruthy();
  });

  it('shows my own teammate\'s task as the snapshot on another of my computers: it runs on its home', () => {
    // A local copy whose home is elsewhere holds neither the group lane nor the task.
    stores.cloud = homedOn('home-desktop');
    render(<BotGroupTaskCard task={task('started')} owned botId="bot-a" />);
    expect(screen.queryByTestId('live-card')).toBeNull();
    expect(screen.getByTestId('bot-group-task').textContent).toContain('Launch post');
    cleanup();
    // No copy here at all.
    stores.cloud = EMPTY_COMPANION_CLOUD_SNAPSHOT;
    stores.profileIds = [];
    render(<BotGroupTaskCard task={task('started')} owned botId="bot-a" />);
    expect(screen.queryByTestId('live-card')).toBeNull();
    cleanup();
    // A copy shadowed after its home moved away.
    stores.profileIds = ['bot-a'];
    stores.cloud = { ...EMPTY_COMPANION_CLOUD_SNAPSHOT, demotedBotIds: ['bot-a'] };
    render(<BotGroupTaskCard task={task('started')} owned botId="bot-a" />);
    expect(screen.queryByTestId('live-card')).toBeNull();
  });
});

// bot-group-chat.md §10, revision 2: the teammate's owner opens the task where it runs; others see the card.
describe('BotGroupLiveTaskCard', () => {
  const live = { taskId: 'task-1', deviceId: 'other-mac', title: 'Fix login', state: 'waiting' as const, requesterName: 'Ann', botName: 'Cindy' };
  it.each([[true, false], [true, true], [false, true]])('opens the task only for its owner (owner: %s, here: %s)', async (openable, here) => {
    nav.navigate.mockClear(); nav.pin.mockClear();
    render(<BotGroupLiveTaskCard task={{ ...live, ...(openable ? { openable } : {}), ...(here ? { here } : {}) }} />);
    expect(screen.getByTestId('bot-group-live-task').textContent).toContain('Fix login');
    const button = screen.queryByRole('button', { name: 'bots.groupChat.task.open' });
    if (!openable) { expect(button).toBeNull(); return; }
    fireEvent.click(button!);
    await waitFor(() => expect(nav.navigate).toHaveBeenCalledWith('/cc-agent/task-1'));
    if (here) expect(nav.pin).not.toHaveBeenCalled();
    else expect(nav.pin).toHaveBeenCalledWith('other-mac', 'task-1');
  });

  // 2026-11-11 owner decision: where the task stopped follows its state on the same line.
  it('shows where the task stopped after its state', () => {
    render(<BotGroupLiveTaskCard task={{ ...live, state: 'idle', summary: 'Preflight failed' }} />);
    expect(screen.getByTitle('bots.groupChat.task.askedBy · bots.groupChat.task.live.idle · Preflight failed')).toBeTruthy();
  });
});
