// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '../../feature-context';
import { BotGroupChatView } from '../BotGroupChatView';
import type {
  BotGroupChangedPayload,
  BotGroupDetail,
  BotGroupMessageView,
} from '../../../../shared/botGroupChat';

const mocks = vi.hoisted(() => ({
  navigate: vi.fn(),
  getBotGroup: vi.fn(),
  sendBotGroupMessage: vi.fn(),
  stopBotGroupRound: vi.fn(),
  continueBotGroupRound: vi.fn(),
  pushes: [] as Array<(payload: BotGroupChangedPayload, stamp?: unknown) => void>,
  toastError: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options && 'name' in options ? `${key}:${String(options.name)}` : key,
    i18n: { language: 'en-US', resolvedLanguage: 'en' },
  }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({ pathname: '/bots/groups/g1', search: '' }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ groupId: 'g1' }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('@/lib/toast', () => ({ toast: { error: mocks.toastError } }));
vi.mock('@/components/chat/MarkdownRenderer', () => ({
  MarkdownRenderer: ({ content }: { content: string }) => <div data-markdown>{content}</div>,
}));
vi.mock('../BotGroupPendingInteraction', () => ({
  BotGroupPendingInteraction: ({ sessionId }: { sessionId: string }) => (
    <div data-testid="pending-interaction">{sessionId}</div>
  ),
}));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));
vi.mock('../BotGenerationLabel', () => ({
  BotGenerationLabel: ({ phase }: { phase?: string }) => <span>{`phase:${phase}`}</span>,
}));
vi.mock('@/state/agentIslandActivity', () => ({ useAgentIslandActivity: () => null }));

beforeAll(() => {
  // jsdom has no layout; scrolling is a no-op here.
  Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get: () => 0 });
});

function msg(overrides: Partial<BotGroupMessageView>): BotGroupMessageView {
  return {
    id: 'm',
    sequence: 1,
    kind: 'message',
    authorKind: 'user',
    authorBotId: null,
    authorName: '',
    content: '',
    mentions: { all: false, botIds: [] },
    noticeCode: null,
    createdAt: 1_700_000_000_000,
    ...overrides,
  };
}

function detail(overrides: Partial<BotGroupDetail> = {}): BotGroupDetail {
  return {
    id: 'g1',
    name: '周末出游',
    replyMode: 'all',
    speakingMode: 'auto',
    members: [
      { botId: 'mimi', name: '咪咪', avatar: '', avatarColor: 'red', status: 'active' },
      { botId: 'xiaoman', name: '小满', avatar: '', avatarColor: 'blue', status: 'active' },
    ],
    lastMessage: null,
    speakingBotIds: [],
    createdAt: 1,
    updatedAt: 1,
    messages: [
      msg({ id: 'u1', sequence: 1, content: '@小满 帮我查余票' }),
      msg({
        id: 'b1',
        sequence: 2,
        authorKind: 'bot',
        authorBotId: 'xiaoman',
        authorName: '小满',
        content: '周六 8:10 有票',
      }),
      msg({
        id: 'n1',
        sequence: 3,
        kind: 'notice',
        authorKind: 'system',
        authorName: '咪咪',
        noticeCode: 'member-timeout',
      }),
      msg({ id: 'e1', sequence: 4, kind: 'round-end', authorKind: 'system' }),
    ],
    hasMoreBefore: false,
    round: { status: 'idle', speakers: [], canContinue: true },
    ...overrides,
  };
}

function HeaderSlot() {
  return <header data-testid="content-header">{useFeatureContentHeader()}</header>;
}

function renderView() {
  return render(
    <FeatureSidebarSlotProvider isCollapsed={false}>
      <HeaderSlot />
      <BotGroupChatView />
    </FeatureSidebarSlotProvider>,
  );
}

beforeEach(() => {
  mocks.navigate.mockReset();
  mocks.toastError.mockReset();
  mocks.pushes = [];
  mocks.getBotGroup.mockReset().mockResolvedValue({ ok: true, group: detail() });
  mocks.sendBotGroupMessage.mockReset().mockResolvedValue({ ok: true, messageId: 'u2' });
  mocks.stopBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  mocks.continueBotGroupRound.mockReset().mockResolvedValue({ ok: true });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        listBotGroups: vi.fn(async () => ({ ok: true, groups: [] })),
        getBotGroup: (...args: unknown[]) => mocks.getBotGroup(...args),
        sendBotGroupMessage: (...args: unknown[]) => mocks.sendBotGroupMessage(...args),
        stopBotGroupRound: (...args: unknown[]) => mocks.stopBotGroupRound(...args),
        continueBotGroupRound: (...args: unknown[]) => mocks.continueBotGroupRound(...args),
        onBotGroupChanged: (cb: (payload: BotGroupChangedPayload, stamp?: unknown) => void) => {
          mocks.pushes.push(cb);
          return () => {
            mocks.pushes = mocks.pushes.filter((entry) => entry !== cb);
          };
        },
      },
    },
  });
});

afterEach(cleanup);

describe('BotGroupChatView', () => {
  it('renders user, teammate, notice and round-end rows with the header lockup', async () => {
    renderView();
    expect(await screen.findByText('周六 8:10 有票')).toBeTruthy();
    // The user's mention renders as a chip inside the right-aligned bubble.
    expect(screen.getByText('@小满').className).toContain('rounded-full');
    expect(screen.getByText('bots.groupChat.notice.memberTimeout:咪咪')).toBeTruthy();
    expect(screen.getByText('bots.groupChat.timeline.roundEnded')).toBeTruthy();
    const header = screen.getByTestId('content-header');
    expect(header.textContent).toContain('周末出游');
    expect(header.textContent).toContain('咪咪');
    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.settings.open' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/groups/g1?groupSettings=1');
  });

  it('continues only from the latest continuable round end', async () => {
    renderView();
    fireEvent.click(await screen.findByRole('button', { name: 'bots.groupChat.timeline.continue' }));
    await waitFor(() => expect(mocks.continueBotGroupRound).toHaveBeenCalledWith('g1'));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('hides continue when main says the round cannot continue', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({ round: { status: 'idle', speakers: [], canContinue: false } }),
    });
    renderView();
    await screen.findByText('bots.groupChat.timeline.roundEnded');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();
  });

  it('shows the speaking teammate and turns send into stop while a round runs', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi'],
        round: { status: 'running', speakers: [{ botId: 'mimi', sessionId: 'lane-mimi' }], canContinue: false },
      }),
    });
    renderView();
    const speaking = await screen.findByTestId('bot-group-speaking');
    expect(speaking.textContent).toContain('咪咪');
    expect(speaking.textContent).toContain('phase:thinking');
    expect(screen.getByTestId('pending-interaction').textContent).toBe('lane-mimi');
    expect(screen.queryByRole('button', { name: 'bots.groupChat.timeline.continue' })).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'bots.groupChat.composer.stop' }));
    await waitFor(() => expect(mocks.stopBotGroupRound).toHaveBeenCalledWith('g1'));

    // Typing turns the button back into send: interrupting starts a new round.
    fireEvent.change(screen.getByRole('textbox'), { target: { value: '换个方案' } });
    expect(screen.getByRole('button', { name: 'bots.send' })).toBeTruthy();
  });

  it('shows every teammate thinking at once in a parallel circle', async () => {
    mocks.getBotGroup.mockResolvedValue({
      ok: true,
      group: detail({
        speakingBotIds: ['mimi', 'xiaoman'],
        round: {
          status: 'running',
          speakers: [{ botId: 'mimi', sessionId: 'lane-mimi' }, { botId: 'xiaoman', sessionId: 'lane-xiaoman' }],
          canContinue: false,
        },
      }),
    });
    renderView();
    await screen.findAllByTestId('bot-group-speaking');
    const rows = screen.getAllByTestId('bot-group-speaking');
    expect(rows.map((row) => row.textContent?.includes('咪咪') ? 'mimi' : row.textContent?.includes('小满') ? 'xiaoman' : '?'))
      .toEqual(['mimi', 'xiaoman']);
    expect(screen.getAllByTestId('pending-interaction').map((node) => node.textContent))
      .toEqual(['lane-mimi', 'lane-xiaoman']);
  });

  it('sends with Enter, parses mentions, and re-reads after main accepts', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    fireEvent.change(input, { target: { value: '@咪咪 规划一下', selectionStart: 8 } });
    // IME confirmation must not send.
    fireEvent.keyDown(input, { key: 'Enter', isComposing: true });
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(mocks.sendBotGroupMessage).toHaveBeenCalledTimes(1));
    const [input0] = mocks.sendBotGroupMessage.mock.calls[0] as [Record<string, unknown>];
    expect(input0).toMatchObject({
      groupId: 'g1',
      text: '@咪咪 规划一下',
      mentions: { all: false, botIds: ['mimi'] },
    });
    expect(typeof input0.clientId).toBe('string');
    expect(input.value).toBe('');
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
  });

  it('opens the @ picker with Everyone first and inserts the chosen teammate', async () => {
    renderView();
    const input = (await screen.findByRole('textbox')) as HTMLTextAreaElement;
    act(() => input.focus());
    fireEvent.change(input, { target: { value: '查一下 @', selectionStart: 5 } });
    const options = await screen.findAllByRole('option');
    expect(options.map((option) => option.textContent)).toEqual([
      'bots.groupChat.mention.allbots.groupChat.mention.allHint',
      '咪咪',
      '小满',
    ]);
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'ArrowDown' });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(input.value).toBe('查一下 @小满 ');
    expect(mocks.sendBotGroupMessage).not.toHaveBeenCalled();
  });

  it('refreshes on a push for this group and shows the unavailable state after delete', async () => {
    renderView();
    await screen.findByText('周六 8:10 有票');
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'other', change: 'messages' })));
    expect(mocks.getBotGroup).toHaveBeenCalledTimes(1);
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'messages' })));
    await waitFor(() => expect(mocks.getBotGroup).toHaveBeenCalledTimes(2));
    act(() => mocks.pushes.forEach((push) => push({ groupId: 'g1', change: 'deleted' })));
    expect(await screen.findByText('bots.groupChat.unavailableTitle')).toBeTruthy();
  });
});
