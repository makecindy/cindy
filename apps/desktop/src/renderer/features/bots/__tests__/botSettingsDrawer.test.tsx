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
vi.mock('../BotsHomeView', async () => {
  const { Popover, PopoverTrigger, PopoverContent } =
    await import('../../../components/ui/popover');
  return {
    BotSettings: () => (
      <div data-testid="simple-bot-settings">
        <Popover>
          <PopoverTrigger>Choose model</PopoverTrigger>
          <PopoverContent>
            <div data-testid="model-list" style={{ overflowY: 'auto', height: 100 }}>
              <button>Model row</button>
            </div>
          </PopoverContent>
        </Popover>
      </div>
    ),
  };
});

import { BotSettingsDrawer } from '../BotSettingsDrawer';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(cleanup);

describe('BotSettingsDrawer', () => {
  it('allows wheel events in portaled model lists while blocking background scrolling', async () => {
    render(
      <MemoryRouter initialEntries={['/bots/bot-1?settings=1']}>
        <BotSettingsDrawer />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const list = await screen.findByTestId('model-list');
    // jsdom has no layout; supply dimensions but let the real Dialog/Popover
    // and react-remove-scroll decide whether to cancel the browser's wheel.
    Object.defineProperties(list, {
      scrollHeight: { value: 1000 },
      clientHeight: { value: 100 },
      scrollTop: { value: 400, writable: true },
    });
    expect(
      screen
        .getByRole('button', { name: 'Choose model' })
        .closest('[role="dialog"]')
        ?.contains(list),
    ).toBe(false);
    for (const deltaY of [-50, 50]) {
      const wheel = new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY });
      fireEvent(screen.getByRole('button', { name: 'Model row' }), wheel);
      expect(wheel.defaultPrevented).toBe(false);
    }
    const backgroundWheel = new WheelEvent('wheel', {
      bubbles: true,
      cancelable: true,
      deltaY: 50,
    });
    fireEvent(document.body, backgroundWheel);
    expect(backgroundWheel.defaultPrevented).toBe(true);
  });

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
