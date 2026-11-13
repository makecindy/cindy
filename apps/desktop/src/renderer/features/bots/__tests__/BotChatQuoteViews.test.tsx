// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { BotChatReplyTarget } from '../BotChatQuoteViews';
import type { BotChatQuoteValue } from '../botChatQuoteContext';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);
// Unit: a deliberate quote is independent of the legacy preference and paged-in history.
it('renders and locates the selected snapshot with automatic targets disabled', () => {
  const locate = vi.fn();
  const context: BotChatQuoteValue = { sessionId: 's', showReplyTargets: false,
    names: { owner: 'Me', companion: 'Cindy' }, getMessage: () => undefined,
    isFirstReplyFor: () => false, locate, quote: vi.fn() };
  const { rerender } = render(<BotChatReplyTarget context={context} message={{ clientId: 'a',
    replyToClientId: 'latest', replyQuote: { clientId: 'old', role: 'user', excerpt: 'Earlier question' } }} />);
  fireEvent.click(screen.getByText('Earlier question'));
  expect(locate).toHaveBeenCalledWith('old');
  rerender(<BotChatReplyTarget context={context} message={{ clientId: 'a', replyToClientId: 'latest' }} />);
  expect(screen.queryByText('Earlier question')).toBeNull();
});
