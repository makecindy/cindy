// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  params: { botId: 'bot-a', sessionId: 'chat-a' },
  location: { state: null as unknown },
  supported: true,
}));
vi.mock('react-router-dom', () => ({
  useParams: () => mocks.params,
  useLocation: () => mocks.location,
  useNavigate: () => vi.fn(),
  Navigate: () => null,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (s: string) => s }) }));
vi.mock('@/hooks/useAgentIslandSettings', () => ({
  isAgentIslandSupported: () => mocks.supported,
}));
// The private-chat topic host belongs to the chat surface these tests isolate.
vi.mock('../BotDmThreadHost', () => ({ BotDmThreadHost: ({ children }: { children: import('react').ReactNode }) => <>{children}</> }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ readOnly }: { readOnly?: boolean }) => <div data-testid="chat" data-readonly={String(!!readOnly)} />,
}));
vi.mock('../botReadState', () => ({ getBotLastReadAt: () => null, markBotRead: vi.fn() }));

import { BotSessionView } from '../BotSessionView';
import { BotHistorySessionView } from '../BotHistorySessionView';

const report = vi.fn();
const focus = vi.fn();
const consumeEntryAlert = vi.fn(async () => ({ ok: true as const, consumed: true }));
const get = vi.fn();
const history = vi.fn();
const profile = {
  id: 'bot-a', status: 'active',
  sessions: [{ id: 'chat-a', kind: 'chat', status: 'active' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = { botId: 'bot-a', sessionId: 'chat-a' };
  mocks.location = { state: null };
  mocks.supported = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  get.mockResolvedValue(profile);
  history.mockResolvedValue([{ id: 'chat-a' }]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    agentIsland: { setVisibleSession: report, consumeEntryAlert },
    ghosts: { noteSessionFocused: focus },
    localDb: { bots: { get, history, list: vi.fn(async () => []) } },
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe.each([
  ['chat', BotSessionView],
] as const)('%s ownership and visibility', (_, View) => {
  it('waits for validation and discards the previous grant on route changes', async () => {
    let resolveGate!: (value: never) => void;
    const pending = new Promise((resolve) => { resolveGate = resolve; });
    if (View === BotSessionView) get.mockReturnValueOnce(pending);
    else history.mockReturnValueOnce(pending);
    const view = render(<View />);
    expect(report).not.toHaveBeenCalledWith('chat-a');
    await act(async () => resolveGate((View === BotSessionView ? profile : [{ id: 'chat-a' }]) as never));
    await waitFor(() => expect(report).toHaveBeenCalledWith('chat-a'));
    report.mockClear();
    mocks.params = { botId: 'bot-b', sessionId: 'not-owned' };
    view.rerender(<View />);
    await act(async () => {});
    expect(report).not.toHaveBeenCalledWith('not-owned');
    expect(view.queryByTestId('chat')).toBeNull();
    expect(report).toHaveBeenLastCalledWith(null);
  });

  it('ignores a late validation result after navigation', async () => {
    let resolveGate!: (value: never) => void;
    const pending = new Promise((resolve) => { resolveGate = resolve; });
    if (View === BotSessionView) get.mockReturnValueOnce(pending);
    else history.mockReturnValueOnce(pending);
    const view = render(<View />);
    mocks.params = { botId: 'bot-b', sessionId: 'not-owned' };
    view.rerender(<View />);
    await act(async () => resolveGate((View === BotSessionView ? profile : [{ id: 'chat-a' }]) as never));
    expect(report.mock.calls.every(([id]) => id === null)).toBe(true);
  });

  it('does not report a failed lookup', async () => {
    get.mockRejectedValue(new Error('unavailable'));
    history.mockRejectedValue(new Error('unavailable'));
    render(<View />);
    await act(async () => {});
    expect(report.mock.calls.every(([id]) => id === null)).toBe(true);
  });

  it('reports validated ownership before DOM focus settles, then resyncs and cleans up', async () => {
    vi.mocked(document.hasFocus).mockReturnValue(false);
    let resolveGate!: (value: never) => void;
    const pending = new Promise((resolve) => { resolveGate = resolve; });
    if (View === BotSessionView) get.mockReturnValueOnce(pending);
    else history.mockReturnValueOnce(pending);
    const view = render(<View />);
    expect(view.queryByTestId('chat')).toBeNull();
    expect(report).not.toHaveBeenCalledWith('chat-a');
    // Settle ownership and flush its passive effects before dispatching focus.
    // Observing the chat DOM alone can precede the visibility effect's commit.
    await act(async () => resolveGate((View === BotSessionView ? profile : [{ id: 'chat-a' }]) as never));
    expect(view.getByTestId('chat')).toBeTruthy();
    // Main owns foreground/pending-focus acceptance; do not lose its first ack.
    expect(report).toHaveBeenLastCalledWith('chat-a');
    report.mockClear();
    vi.mocked(document.hasFocus).mockReturnValue(true);
    act(() => window.dispatchEvent(new Event('focus')));
    expect(report).toHaveBeenLastCalledWith('chat-a');
    view.unmount();
    expect(report).toHaveBeenLastCalledWith(null);
    report.mockClear();
    act(() => window.dispatchEvent(new Event('focus')));
    expect(report).not.toHaveBeenCalled();
  });

  it('does not call the bridge when Agent Island is unsupported', async () => {
    mocks.supported = false;
    const view = render(<View />);
    await waitFor(() => expect(view.getByTestId('chat')).toBeTruthy());
    expect(report).not.toHaveBeenCalled();
  });
});

// 不可用页自己从不处置提醒:只有灵动岛入口导航器在目标地址提交后、带着那次点击的编号
// 才会请 main 处置(见 botSessionOwners)。直接打开地址、被新点击取代后再访问都不消费。
describe('unavailable Bot task page never disposes island alerts by itself', () => {
  it('shows the unavailable state without asking main to dispose anything', async () => {
    mocks.params = { botId: 'bot-a', sessionId: 'delegated-a' };
    get.mockResolvedValue({
      ...profile,
      sessions: [...profile.sessions, { id: 'delegated-a', kind: 'worker', role: 'delegation', status: 'active' }],
    });
    const view = render(<BotSessionView />);
    await waitFor(() => expect(view.getByText('bots.sessionUnavailableTitle')).toBeTruthy());
    view.rerender(<BotSessionView />);
    await act(async () => {});
    expect(consumeEntryAlert).not.toHaveBeenCalled();
    expect(report.mock.calls.every(([id]) => id === null)).toBe(true);
  });

  it('keeps the alert for a live chat and for a retryable load failure', async () => {
    const live = render(<BotSessionView />);
    await waitFor(() => expect(live.getByTestId('chat')).toBeTruthy());
    live.unmount();
    get.mockRejectedValue(new Error('db busy'));
    const failed = render(<BotSessionView />);
    await waitFor(() => expect(failed.getByText('bots.sessionLoadFailedTitle')).toBeTruthy());
    expect(consumeEntryAlert).not.toHaveBeenCalled();
  });
});

// The retired history wrapper only redirects; the standard task page owns alert recovery.
it('does not consume an error or acknowledge visibility merely by following a history URL', async () => {
  mocks.location = { state: { islandEntryId: '42' } };
  render(<BotHistorySessionView />);
  await act(async () => {});
  expect(consumeEntryAlert).not.toHaveBeenCalled();
  expect(report).not.toHaveBeenCalled();
  expect(get).not.toHaveBeenCalled();
});

describe.each([BotSessionView])('validated task in front for plugins', (View) => {
  // A companion chat is where someone uses the simulator; plugins were told "no task"
  // there, so "open in the current task" failed. Report it once ownership is proven.
  it('reports the validated chat, never an unowned route, and clears it on leave', async () => {
    mocks.supported = false;
    const view = render(<View />);
    await waitFor(() => expect(focus).toHaveBeenLastCalledWith('chat-a'));
    mocks.params = { botId: 'bot-b', sessionId: 'not-owned' };
    view.rerender(<View />);
    await act(async () => {});
    expect(focus).not.toHaveBeenCalledWith('not-owned');
    expect(focus).toHaveBeenLastCalledWith(null);
    view.unmount();
    expect(focus).toHaveBeenLastCalledWith(null);
  });
});
