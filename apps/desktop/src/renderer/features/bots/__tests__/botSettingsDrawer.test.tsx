// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';

vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({ t: (key: string) => key }),
  BotPronounProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('../botStore', () => ({
  useBotProfiles: () => [
    { id: 'bot-1', name: 'Filo', status: 'active', sessions: [], capabilities: {}, skills: [] },
  ],
}));
vi.mock('../BotsHomeView', () => ({
  BotSettings: () => <div data-testid="simple-bot-settings" />,
}));

import { BotSettingsDrawer } from '../BotSettingsDrawer';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(cleanup);

describe('BotSettingsDrawer', () => {
  it('opens as a right half-window without replacing the current chat route', async () => {
    render(
      <MemoryRouter initialEntries={['/bots/bot-1/session/chat-1?settings=1']}>
        <Routes>
          <Route
            path="/bots/:botId/session/:sessionId"
            element={
              <>
                <div data-testid="chat-underlay" />
                <LocationProbe />
                <BotSettingsDrawer />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const dialog = screen.getByRole('dialog');
    expect(dialog.className).toContain('right-0');
    expect(dialog.className).toContain('lg:w-1/2');
    expect(screen.getByTestId('chat-underlay')).toBeTruthy();
    expect(screen.getByTestId('simple-bot-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('location').textContent).toBe('/bots/bot-1/session/chat-1');
    expect(screen.getByTestId('chat-underlay')).toBeTruthy();
  });
});
