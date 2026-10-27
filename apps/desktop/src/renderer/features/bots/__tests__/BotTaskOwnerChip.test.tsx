// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { BotTaskOwnerChip } from '../BotTaskOwnerChip';

const mocks = vi.hoisted(() => ({ navigate: vi.fn(), ensure: vi.fn(), delegators: new Map<string, unknown>() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, options?: Record<string, unknown>) => `${key}:${JSON.stringify(options)}` }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => mocks.navigate }));
vi.mock('../BotAvatar', () => ({ BotAvatar: ({ bot }: any) => <span data-avatar={bot.name} /> }));
vi.mock('../botStore', () => ({ ensureBotProfilesLoaded: mocks.ensure }));
// The delegation projection of the same follow scopes the sidebar mark reads; the chip adds no second ownership rule.
vi.mock('../botFollowScopes', () => ({
  useSessionDelegatingBot: (session: { id: string }) => mocks.delegators.get(session.id) ?? null,
}));

const lizi = { id: 'bot/a', name: 'LiZi' };
const session = (id: string) => ({ id, status: 'active', source: 'desktop' }) as any;
beforeEach(() => {
  mocks.delegators = new Map([['task', lizi]]);
  mocks.ensure.mockReset().mockResolvedValue([]);
  mocks.navigate.mockReset();
});
afterEach(cleanup);

it("names a Bot's background task in its ordinary header and leads back to that Bot", () => {
  render(<BotTaskOwnerChip session={session('task')} />);
  expect(mocks.ensure).toHaveBeenCalledTimes(1);
  expect(screen.getByText('bots.session.ownedByBot:{"name":"LiZi"}')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'bots.session.backToBot:{"name":"LiZi"}' }));
  expect(mocks.navigate).toHaveBeenCalledWith('/bots/bot%2Fa');
});

it('stays out of the way for a task no Bot is responsible for', () => {
  const { container } = render(<BotTaskOwnerChip session={session('plain')} />);
  expect(container.firstChild).toBeNull();
});
