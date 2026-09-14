// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '../../feature-context';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BotDirectMessageView } from '../BotDirectMessageView';

const mocks = vi.hoisted(() => ({
  getThread: vi.fn(),
  navigate: vi.fn(),
  profiles: [
    { id: 'bot-a', name: 'Cindy', avatar: '', avatarColor: 'red' },
    { id: 'bot-b', name: 'Planner', avatar: '', avatarColor: 'blue' },
  ],
  search: '',
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en-US' } }),
}));
vi.mock('react-router-dom', () => ({
  useLocation: () => ({
    search: mocks.search,
    state: { botDirectMessageReturnTo: '/bots/bot-a/session/a-main' },
  }),
  useNavigate: () => mocks.navigate,
  useParams: () => ({ botId: 'bot-a', threadId: 'dm-1' }),
}));
vi.mock('@/lib/remoteDataOwnerPushFence', () => ({ isDeviceLinkRemotePushCurrent: () => true }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => 1,
  isDataOwnerGenerationCurrent: () => true,
  isDataOwnerPushCurrent: () => true,
}));
vi.mock('../botStore', () => ({ useBotProfiles: () => mocks.profiles }));
vi.mock('../BotAvatar', () => ({
  BotAvatar: ({ bot }: { bot: { name: string } }) => <span data-avatar={bot.name} />,
}));

function HeaderSlot() {
  return <header data-testid="content-header">{useFeatureContentHeader()}</header>;
}

function TestPage({ showThread = true }: { showThread?: boolean }) {
  return (
    <FeatureSidebarSlotProvider isCollapsed={false}>
      <HeaderSlot />
      {showThread ? <BotDirectMessageView /> : null}
    </FeatureSidebarSlotProvider>
  );
}

beforeEach(() => {
  mocks.search = '';
  mocks.navigate.mockClear();
  mocks.getThread.mockReset();
  mocks.getThread.mockResolvedValue({
    ok: true,
    thread: {
      id: 'dm-1',
      botAId: 'bot-a',
      botAName: 'Cindy',
      botBId: 'bot-b',
      botBName: 'Planner',
      status: 'closed',
      closeReason: 'message-limit',
      messageCount: 2,
      maxMessages: 12,
      createdAt: 1,
      updatedAt: 2,
      closedAt: 2,
      messages: [
        {
          id: 'message-1',
          sequence: 1,
          senderBotId: 'bot-a',
          senderBotName: 'Cindy',
          recipientBotId: 'bot-b',
          recipientBotName: 'Planner',
          content: 'Can you check this?',
          createdAt: 1,
        },
        {
          id: 'message-2',
          sequence: 2,
          senderBotId: 'bot-b',
          senderBotName: 'Planner',
          recipientBotId: 'bot-a',
          recipientBotName: 'Cindy',
          content: 'Checked.',
          createdAt: 2,
        },
      ],
    },
  });
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      maker: {
        getBotDirectMessageThread: (...args: unknown[]) => mocks.getThread(...args),
        onBotDirectMessageChanged: () => () => undefined,
      },
    },
  });
});

afterEach(cleanup);

describe('BotDirectMessageView', () => {
  it('shows both sides read-only, renders the hard-limit ending, and returns to the source timeline', async () => {
    render(<TestPage />, { reactStrictMode: true });
    expect(await screen.findByText('Can you check this?')).toBeTruthy();
    expect(screen.getByText('Checked.')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.getByText('bots.directMessage.limitReached')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'bots.directMessage.close' }));
    expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot-a/session/a-main', { replace: true });
    expect(screen.getByTestId('content-header').textContent).toContain('Cindy');
  });

  it('fails closed when the thread is unavailable', async () => {
    mocks.getThread.mockResolvedValue({ ok: false, errorCode: 'NOT_FOUND', message: 'missing' });
    render(<TestPage />, { reactStrictMode: true });
    expect(await screen.findByText('bots.directMessage.unavailable')).toBeTruthy();
    expect(screen.queryByRole('textbox')).toBeNull();
  });
});

it('loads a remote private thread and refreshes it after reconnect without using local profiles', async () => {
  mocks.search = '?deviceId=home';
  let status!: (state: any) => void;
  const unsubscribePush = vi.fn();
  const unsubscribeStatus = vi.fn();
  const response = await mocks.getThread();
  mocks.getThread.mockClear();
  response.thread.botAName = 'Remote Cindy';
  response.thread.messages[0].senderBotName = 'Remote Cindy';
  const invoke = vi.fn(async () => structuredClone(response));
  window.electronAPI.deviceLink = {
    invoke,
    onRemotePush: () => unsubscribePush,
    onStatusChanged: (fn: any) => {
      status = fn;
      return unsubscribeStatus;
    },
  } as any;
  const view = render(<TestPage />, { reactStrictMode: true });
  await screen.findByText('Can you check this?');
  expect(invoke).toHaveBeenCalledWith('home', 'maker:bot-direct-message-thread:get', [
    'dm-1',
    'bot-a',
  ]);
  expect(mocks.getThread).not.toHaveBeenCalled();
  const header = screen.getByTestId('content-header');
  expect(header.textContent).toContain('Remote Cindy');
  const registeredHeader = header.firstElementChild;
  for (let i = 0; i < 20; i += 1) view.rerender(<TestPage />);
  expect(header.firstElementChild).toBe(registeredHeader);
  expect(invoke).toHaveBeenCalledTimes(2); // StrictMode setup / cleanup / setup.
  response.thread.botAName = 'Updated remote name';
  response.thread.messages[0].senderBotName = 'Updated remote name';
  act(() => status({ status: 'online' }));
  await waitFor(() => expect(invoke).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(header.textContent).toContain('Updated remote name'));
  view.rerender(<TestPage showThread={false} />);
  expect(header.textContent).toBe('');
  expect(unsubscribePush).toHaveBeenCalledTimes(2);
  expect(unsubscribeStatus).toHaveBeenCalledTimes(2);
});

it('clears the local header on navigation and registers fresh profile data when reopened', async () => {
  const view = render(<TestPage />, { reactStrictMode: true });
  await screen.findByText('Can you check this?');
  expect(screen.getByTestId('content-header').textContent).toContain('Planner');
  view.rerender(<TestPage showThread={false} />);
  expect(screen.getByTestId('content-header').textContent).toBe('');
  const previousProfiles = mocks.profiles;
  try {
    mocks.profiles = mocks.profiles.map((profile) => ({
      ...profile,
      name: `Renamed ${profile.name}`,
    }));
    view.rerender(<TestPage />);
    await waitFor(() =>
      expect(screen.getByTestId('content-header').textContent).toContain('Renamed Planner'),
    );
  } finally {
    mocks.profiles = previousProfiles;
  }
});

it('does not restore a header when a remote read finishes after navigation away', async () => {
  mocks.search = '?deviceId=home';
  const response = await mocks.getThread();
  let finish!: (value: typeof response) => void;
  const pending = new Promise<typeof response>((resolve) => {
    finish = resolve;
  });
  const unsubscribe = vi.fn();
  window.electronAPI.deviceLink = {
    invoke: vi.fn(() => pending),
    onRemotePush: () => unsubscribe,
    onStatusChanged: () => unsubscribe,
  } as any;
  const view = render(<TestPage />, { reactStrictMode: true });
  view.rerender(<TestPage showThread={false} />);
  await act(async () => {
    finish(response);
    await pending;
  });
  expect(screen.getByTestId('content-header').textContent).toBe('');
  expect(screen.queryByText('Can you check this?')).toBeNull();
  expect(unsubscribe).toHaveBeenCalledTimes(4);
});
