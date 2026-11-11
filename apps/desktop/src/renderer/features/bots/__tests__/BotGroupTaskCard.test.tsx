// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
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

import { BotGroupTaskCard } from '../BotGroupTaskCard';

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
