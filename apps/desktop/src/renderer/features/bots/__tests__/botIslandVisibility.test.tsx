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
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: () => <div data-testid="chat" />,
}));
vi.mock('../botReadState', () => ({ getBotLastReadAt: () => null, markBotRead: vi.fn() }));

import { BotSessionView } from '../BotSessionView';
import { BotHistorySessionView } from '../BotHistorySessionView';

const report = vi.fn();
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
    localDb: { bots: { get, history, list: vi.fn(async () => []) } },
  } });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

describe.each([
  ['chat', BotSessionView], ['history', BotHistorySessionView],
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

// 只读历史的提醒由它自己的归属门禁处置:灵动岛入口把点击编号放进路由状态,门禁确认并显示
// 这段历史后才请 main 处置;门禁不放行(会被重定向走)或没有点击编号都不处置。
describe('history ownership gate disposes the clicked island card', () => {
  beforeEach(() => {
    mocks.params = { botId: 'bot-a', sessionId: 'old-a' };
    mocks.location = { state: { islandEntryId: '42' } };
  });

  it('disposes only once its gate has shown the transcript', async () => {
    let resolveGate!: (rows: unknown[]) => void;
    history.mockReturnValueOnce(new Promise((resolve) => { resolveGate = resolve; }));
    const view = render(<BotHistorySessionView />);
    await act(async () => {});
    expect(consumeEntryAlert).not.toHaveBeenCalled();
    await act(async () => resolveGate([{ id: 'old-a' }]));
    expect(view.getByTestId('chat')).toBeTruthy();
    expect(consumeEntryAlert).toHaveBeenCalledExactlyOnceWith('old-a', '42');
    // Re-rendering the same entry does not ask again; a new click on the open page does.
    view.rerender(<BotHistorySessionView />);
    mocks.location = { state: { islandEntryId: '43' } };
    view.rerender(<BotHistorySessionView />);
    expect(consumeEntryAlert).toHaveBeenLastCalledWith('old-a', '43');
    expect(consumeEntryAlert).toHaveBeenCalledTimes(2);
  });

  it('keeps the card when its gate redirects away (record gone or read failed)', async () => {
    history.mockResolvedValueOnce([{ id: 'other' }]);
    const gone = render(<BotHistorySessionView />);
    await act(async () => {});
    expect(gone.queryByTestId('chat')).toBeNull();
    gone.unmount();
    history.mockRejectedValueOnce(new Error('db busy'));
    render(<BotHistorySessionView />);
    await act(async () => {});
    expect(consumeEntryAlert).not.toHaveBeenCalled();
  });

  it('never disposes without an island click id', async () => {
    mocks.location = { state: null };
    history.mockResolvedValueOnce([{ id: 'old-a' }]);
    const view = render(<BotHistorySessionView />);
    await waitFor(() => expect(view.getByTestId('chat')).toBeTruthy());
    expect(consumeEntryAlert).not.toHaveBeenCalled();
  });
});
