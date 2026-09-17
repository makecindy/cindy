// @vitest-environment jsdom
import { act, cleanup, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { resolveBotChatIdentity, type BotChatBinding } from '../botChatPresentation';

const h = vi.hoisted(() => ({
  params: { botId: 'bot', sessionId: 'chat' },
  get: vi.fn(), list: vi.fn(), history: vi.fn(),
}));
vi.mock('react-router-dom', () => ({
  useParams: () => h.params,
  useNavigate: () => vi.fn(),
  Navigate: () => <div>unavailable</div>,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../useBotIslandVisibleSession', () => ({ useBotIslandVisibleSession: () => {} }));
vi.mock('@/features/cc-agent/CCAgentSessionView', () => ({
  CCAgentSessionView: ({ botIdentity }: { botIdentity?: BotChatBinding }) => {
    const identity = resolveBotChatIdentity(botIdentity, h.params.sessionId);
    return <div>{identity ? `companion:${identity.id}` : 'task controls'}</div>;
  },
}));
import { BotSessionView } from '../BotSessionView';
import { BotHistorySessionView } from '../BotHistorySessionView';

beforeEach(() => {
  h.params = { botId: 'bot', sessionId: 'chat' };
  h.get.mockReset(); h.list.mockReset().mockResolvedValue([]); h.history.mockReset();
  window.electronAPI = { localDb: { bots: { get: h.get, list: h.list, history: h.history } } } as unknown as Window['electronAPI'];
});
afterEach(cleanup);
it('mounts the simplified chat only after verifying the durable link, without another session GET', async () => {
  let resolve!: (value: unknown) => void;
  h.get.mockReturnValue(new Promise((done) => { resolve = done; }));
  render(<BotSessionView />);
  expect(screen.queryByText('task controls')).toBeNull();
  await act(async () => resolve({ id: 'bot', name: 'Melody', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active', role: 'canonical' },
  ] }));
  expect(screen.getByText('companion:bot')).toBeTruthy();
});
it('does not accept an arbitrary task id from a Bot URL', async () => {
  h.get.mockResolvedValue({ id: 'bot', status: 'active', sessions: [
    { id: 'different', kind: 'chat', status: 'active' },
  ] });
  await act(async () => { render(<BotSessionView />); });
  expect(screen.queryByText('companion:bot')).toBeNull();
  expect(screen.queryByText('task controls')).toBeNull();
});
it('retains companion presentation while history profile loading is pending or fails', async () => {
  let reject!: (reason: Error) => void;
  h.get.mockReturnValue(new Promise((_done, fail) => { reject = fail; }));
  h.history.mockResolvedValue([{ id: 'chat' }]);
  await act(async () => { render(<BotHistorySessionView />); });
  expect(screen.getByText('companion:bot')).toBeTruthy();
  await act(async () => reject(new Error('temporarily unavailable')));
  expect(screen.getByText('companion:bot')).toBeTruthy();
});
it('drops the previous binding synchronously when navigating to a different Bot task', async () => {
  h.get.mockResolvedValue({ id: 'bot', status: 'active', sessions: [
    { id: 'chat', kind: 'chat', status: 'active' },
  ] });
  const view = render(<BotSessionView />);
  await screen.findByText('companion:bot');
  h.get.mockReturnValue(new Promise(() => {}));
  h.params = { botId: 'other', sessionId: 'other-chat' };
  view.rerender(<BotSessionView />);
  expect(screen.queryByText('companion:bot')).toBeNull();
  expect(screen.queryByText('task controls')).toBeNull();
});
