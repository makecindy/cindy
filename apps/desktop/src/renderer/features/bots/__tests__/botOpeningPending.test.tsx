// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';
import { isBotOpeningPending } from '../botChatPresentation';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string, args?: { name?: string }) => `${key}:${args?.name ?? ''}` }),
}));
import { BotOpeningPending } from '../BotOpeningPending';

afterEach(cleanup);

it('shows the first-hello wait as a status line using the existing welcome copy, above the composer', () => {
  const { container } = render(<BotOpeningPending name="Melody" bottomInset={120} />);
  expect(screen.getByRole('status').textContent).toBe('bots.invitation.welcome:Melody');
  const layer = container.firstElementChild as HTMLElement;
  expect(layer.style.bottom).toBe('120px');
  // Never intercepts clicks meant for the chat or the composer.
  expect(layer.className).toContain('pointer-events-none');
});

it.each([
  ['welcome, history loaded, empty chat', { invitationStage: 'welcome', historyLoaded: true, messageCount: 0 }, true],
  ['history not loaded yet', { invitationStage: 'welcome', historyLoaded: false, messageCount: 0 }, false],
  ['the opening (or the user) is already in the chat', { invitationStage: 'welcome', historyLoaded: true, messageCount: 1 }, false],
  ['stage ready', { invitationStage: 'ready', historyLoaded: true, messageCount: 0 }, false],
  ['stage failed (the retry entry owns that state)', { invitationStage: 'failed', historyLoaded: true, messageCount: 0 }, false],
  ['earlier stages never have a chat to show it in', { invitationStage: 'skills', historyLoaded: true, messageCount: 0 }, false],
  ['no invitation (ordinary teammate or channel task)', { invitationStage: undefined, historyLoaded: true, messageCount: 0 }, false],
])('only appears while the hello is really pending: %s', (_name, input, expected) => {
  expect(isBotOpeningPending(input)).toBe(expected);
});
