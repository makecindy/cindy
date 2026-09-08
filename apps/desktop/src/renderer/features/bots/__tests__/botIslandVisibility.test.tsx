// @vitest-environment jsdom
import { act, cleanup, render, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  params: { botId: 'bot-a', sessionId: 'chat-a' },
  supported: true,
}));
vi.mock('react-router-dom', () => ({
  useParams: () => mocks.params,
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
const get = vi.fn();
const history = vi.fn();
const profile = {
  id: 'bot-a', status: 'active',
  sessions: [{ id: 'chat-a', kind: 'chat', status: 'active' }],
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.params = { botId: 'bot-a', sessionId: 'chat-a' };
  mocks.supported = true;
  vi.spyOn(document, 'hasFocus').mockReturnValue(true);
  get.mockResolvedValue(profile);
  history.mockResolvedValue([{ id: 'chat-a' }]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    agentIsland: { setVisibleSession: report },
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

  it('reports on refocus and clears on unmount, without background reads', async () => {
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
    expect(report).not.toHaveBeenCalledWith('chat-a');
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
