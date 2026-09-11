// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';

const guard = vi.hoisted(() => vi.fn(async () => true));
beforeEach(() => guard.mockReset().mockResolvedValue(true));

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
  const { useEffect } = await import('react');
  const { Popover, PopoverTrigger, PopoverContent } =
    await import('../../../components/ui/popover');
  return {
    BotSettings: ({
      beforeCloseRef,
    }: {
      beforeCloseRef: { current: (() => Promise<boolean>) | null };
    }) => {
      useEffect(() => {
        beforeCloseRef.current = guard;
        return () => {
          beforeCloseRef.current = null;
        };
      }, [beforeCloseRef]);
      return (
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
      );
    },
  };
});

import { BotSettingsDrawer } from '../BotSettingsDrawer';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(cleanup);

describe('BotSettingsDrawer', () => {
  it.each(['query', 'sidebar', 'back'])(
    'protects drafts when %s navigation removes settings',
    async (kind) => {
      guard.mockResolvedValue(false);
      const router = createMemoryRouter(
        [
          {
            path: '*',
            element: (
              <>
                <LocationProbe />
                <BotSettingsDrawer />
              </>
            ),
          },
        ],
        {
          initialEntries: ['/bots/bot-1', '/bots/bot-1?settings=1'],
          initialIndex: 1,
        },
      );
      render(<RouterProvider router={router} />);
      const destination = kind === 'back' ? -1 : kind === 'query' ? '/bots/bot-1' : '/cc-agent';
      const leave = () =>
        act(async () => {
          if (typeof destination === 'number') await router.navigate(destination);
          else await router.navigate(destination);
        });
      await leave();
      await waitFor(() => expect(guard).toHaveBeenCalledOnce());
      expect(screen.getByRole('dialog')).toBeTruthy();
      expect(router.state.location.search).toBe('?settings=1');
      guard.mockResolvedValue(true);
      await leave();
      await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
      expect(guard).toHaveBeenCalledTimes(2);
      expect(router.state.location.pathname).toBe(kind === 'sidebar' ? '/cc-agent' : '/bots/bot-1');
    },
  );

  it('allows wheel events in portaled model lists while blocking background scrolling', async () => {
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
          initialEntries: ['/bots/bot-1?settings=1'],
        })}
      />,
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
      <RouterProvider
        router={createMemoryRouter(
          [
            {
              path: '/bots/:botId/session/:sessionId',
              element: (
                <>
                  <div data-testid="chat-underlay" />
                  <LocationProbe />
                  <BotSettingsDrawer />
                </>
              ),
            },
          ],
          { initialEntries: ['/bots/bot-1/session/chat-1?settings=1'] },
        )}
      />,
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
