// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider, useLocation } from 'react-router-dom';
import { transferableAbortController } from 'node:util';

// jsdom supplies its own AbortController while Request remains Node's native
// fetch implementation. React Router must construct both in the same realm.
const NativeAbortController = transferableAbortController().constructor;
beforeEach(() => vi.stubGlobal('AbortController', NativeAbortController));
afterEach(() => vi.unstubAllGlobals());

const guard = vi.hoisted(() => vi.fn(async () => true));
const nativeAbortController = transferableAbortController();
beforeEach(() => {
  guard.mockReset().mockResolvedValue(true);
  // React Router uses Node Request; its signal must come from the same realm.
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
  const controller = new AbortController();
  const request = new Request('https://example.invalid', { signal: controller.signal });
  expect(request.signal.aborted).toBe(false);
  controller.abort('realm-probe');
  expect(request.signal.aborted).toBe(true);
  expect(request.signal.reason).toBe('realm-probe');
});

vi.mock('../botPronounContext', () => ({
  useBotTranslation: () => ({ t: (key: string) => key }),
  BotPronounProvider: ({ children }: { children: ReactNode }) => children,
}));
const devices = vi.hoisted(() => ({ rows: null as null | Array<{ deviceId: string; online: boolean; remoteControlEnabled: boolean }> }));
vi.mock('@/features/device-link/useDeviceLinkDeviceList', () => ({ useDeviceLinkDeviceList: () => devices.rows }));
vi.mock('../useRemoteBots', () => ({ useRemoteBots: () => [{ id: 'remote-bot', deviceId: 'other-mac', name: 'Remote' }] }));
vi.mock('../RemoteTeammateSettings', () => ({ RemoteTeammateSettings: ({ bot, initialPage, controlOff }: { bot: { deviceId: string }; initialPage?: string; controlOff?: boolean }) => <div data-control-off={controlOff} data-testid="remote-settings" data-initial-page={initialPage}>{bot.deviceId}</div> }));
vi.mock('../botStore', () => ({
  useBotProfiles: () => [
    { id: 'bot-1', name: 'Filo', status: 'active', sessions: [], capabilities: {}, skills: [] },
    { id: 'bot-paused', name: 'Paused', status: 'paused', sessions: [], capabilities: {}, skills: [] },
  ],
}));
vi.mock('../BotsHomeView', async () => {
  const { useEffect } = await import('react');
  const { Popover, PopoverTrigger, PopoverContent } =
    await import('../../../components/ui/popover');
  return {
    BotSettings: ({
      beforeCloseRef,
      initialPage,
    }: {
      beforeCloseRef: { current: (() => Promise<boolean>) | null };
      initialPage?: string;
    }) => {
      useEffect(() => {
        beforeCloseRef.current = guard;
        return () => {
          beforeCloseRef.current = null;
        };
      }, [beforeCloseRef]);
      return (
        <div data-testid="simple-bot-settings" data-initial-page={initialPage}>
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

const cloud = vi.hoisted(() => ({ demotedBotIds: [] as string[], actors: [] as CompanionCloudActor[] }));
vi.mock('../companionCloudStore', () => ({
  useCompanionCloud: () => ({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', actors: cloud.actors, demotedBotIds: cloud.demotedBotIds }),
}));
beforeEach(() => { devices.rows = null; cloud.demotedBotIds = []; cloud.actors = []; });

import { BotSettingsDrawer } from '../BotSettingsDrawer';
import { cloudRemoteBots } from '../companionCloudPresentation';
import type { CompanionCloudActor } from '../../../../shared/companionCloud';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

afterEach(() => {
  try {
    cleanup();
  } finally {
    vi.unstubAllGlobals();
  }
});

describe('BotSettingsDrawer', () => {
  // Settings leave/focus contract (cindy-bots-runtime.md: save before leaving;
  // DESIGN.md §14.2): real drawer/router/popover + a deferred save boundary.
  // Existing navigation cases resolve immediately and miss stale destinations
  // or a pointer lock surviving an allowed navigation. Minimal input: two
  // destinations while one guard is pending; unit/jsdom, no host or network I/O.
  // Measured file: 45.71s total / 6.24s execution; these branches 2.232s / 0.967s.
  it.each([true, false])('keeps pending navigation responsive and applies only the latest destination (allowed=%s)', async (allowed) => {
    let finish!: (value: boolean) => void;
    guard.mockImplementationOnce(() => new Promise<boolean>(resolve => { finish = resolve; }));
    const router = createMemoryRouter([{ path: '*', element: <><LocationProbe /><BotSettingsDrawer /></> }], {
      initialEntries: ['/bots/bot-1?settings=1'],
    });
    render(<RouterProvider router={router} />);
    await act(async () => { await router.navigate('/cc-agent/task-a'); });
    expect(guard).toHaveBeenCalledOnce();
    expect(router.state.location.search).toBe('?settings=1');
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    expect(await screen.findByRole('button', { name: 'Model row' })).toBeTruthy();
    await act(async () => { await router.navigate('/bots/bot-paused'); });
    expect(guard).toHaveBeenCalledOnce();
    await act(async () => { finish(allowed); });
    await waitFor(() => expect(router.state.location.pathname).toBe(allowed ? '/bots/bot-paused' : '/bots/bot-1'));
    expect(router.state.location.search).toBe(allowed ? '' : '?settings=1');
    if (allowed) await waitFor(() => expect(document.body.style.pointerEvents).toBe(''));
    else expect(screen.getByRole('dialog', { name: 'bots.settings' })).toBeTruthy();
  });

  // Unit regression for the reported inert scrim (DESIGN.md §4: side drawers dismiss outside).
  // Existing cases cover navigation, Escape and ×, but not pointer dismissal through the real
  // BotSettingsDrawer. A pointer on the scrim must close only when the save/draft guard permits;
  // pointers inside the drawer or its portal must leave it open.
  it('closes from the scrim only after the draft guard allows leaving', async () => {
    guard.mockResolvedValue(false);
    const router = createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
      initialEntries: ['/bots/bot-1?settings=1&settingsPage=memory&keep=1'],
    });
    render(<RouterProvider router={router} />);
    // Radix installs its document pointer listener on the next task.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    const scrim = screen.getByRole('dialog').parentElement!;
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 });
    fireEvent.click(scrim);
    await waitFor(() => expect(guard).toHaveBeenCalledOnce());
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(router.state.location.search).toContain('settings=1');

    guard.mockResolvedValue(true);
    fireEvent.pointerDown(scrim, { pointerType: 'mouse', button: 0 });
    fireEvent.click(scrim);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(guard).toHaveBeenCalledTimes(2);
    expect(router.state.location.pathname).toBe('/bots/bot-1');
    expect(router.state.location.search).toBe('?keep=1');
  });

  it('keeps settings open when clicking inside the drawer or its portaled controls', async () => {
    render(<RouterProvider router={createMemoryRouter(
      [{ path: '*', element: <BotSettingsDrawer /> }],
      { initialEntries: ['/bots/bot-1?settings=1'] },
    )} />);
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
    fireEvent.pointerDown(screen.getByTestId('simple-bot-settings'), { pointerType: 'mouse', button: 0 });
    fireEvent.click(screen.getByRole('button', { name: 'Choose model' }));
    const option = await screen.findByRole('button', { name: 'Model row' });
    await act(async () => {
      fireEvent.pointerDown(option, { pointerType: 'mouse', button: 0 });
      fireEvent.click(option);
    });
    expect(screen.getByTestId('simple-bot-settings')).toBeTruthy();
    expect(guard).not.toHaveBeenCalled();
  });

  it('does not open editable settings for a copy demoted to another computer', async () => {
    cloud.demotedBotIds = ['bot-1'];
    const router = createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }],
      { initialEntries: ['/bots/bot-1?settings=1'] });
    render(<RouterProvider router={router} />);
    await act(async () => { await Promise.resolve(); });
    expect(screen.queryByTestId('simple-bot-settings')).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

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

  it('deep-links local and remote teammates to the messaging platforms page', () => {
    const local = render(
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
          initialEntries: ['/bots/bot-1?settings=1&settingsPage=channels'],
        })}
      />,
    );
    expect(screen.getByTestId('simple-bot-settings').getAttribute('data-initial-page')).toBe(
      'channels',
    );
    local.unmount();
    render(
      <RouterProvider
        router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
          initialEntries: ['/bots/remote/other-mac/remote-bot?settings=1&settingsPage=channels'],
        })}
      />,
    );
    // The remote host serves the same pages; one that cannot serve a page falls back to the home itself.
    expect(screen.getByTestId('remote-settings').getAttribute('data-initial-page')).toBe('channels');
  });

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

  it('opens as a compact right drawer without replacing the current chat route', async () => {
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
    expect(dialog.className).toContain('w-full');
    expect(dialog.className).toContain('max-w-md');
    // Portaled after the page's title-bar drag strip, so this no-drag wins under the close button.
    expect((dialog.style as CSSStyleDeclaration & { WebkitAppRegion?: string }).WebkitAppRegion).toBe('no-drag');
    expect(screen.getByTestId('chat-underlay')).toBeTruthy();
    expect(screen.getByTestId('simple-bot-settings')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByTestId('location').textContent).toBe('/bots/bot-1/session/chat-1');
    expect(screen.getByTestId('chat-underlay')).toBeTruthy();
  });
});

it('keeps the drawer open while Escape only cancels an IME candidate', async () => {
  render(
    <RouterProvider
      router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
        initialEntries: ['/bots/bot-1?settings=1'],
      })}
    />,
  );
  const dialog = screen.getByRole('dialog');
  fireEvent.keyDown(dialog, { key: 'Escape', isComposing: true });
  fireEvent.keyDown(dialog, { key: 'Escape', keyCode: 229 });
  await act(async () => {});
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(guard).not.toHaveBeenCalled();
  fireEvent.keyDown(dialog, { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(guard).toHaveBeenCalledOnce();
});

it.each(['close button', 'Escape'])('closes a paused teammate\'s settings to the list via %s instead of bouncing back', async (kind) => {
  const router = createMemoryRouter([{ path: '*', element: <><LocationProbe /><BotSettingsDrawer /></> }], {
    initialEntries: ['/bots/bot-paused?settings=1'],
  });
  render(<RouterProvider router={router} />);
  if (kind === 'Escape') fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  else fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.getByTestId('location').textContent).toBe('/bots/list'));
  // The save / draft guard still runs before leaving.
  expect(guard).toHaveBeenCalledOnce();
});

it('opens remote settings for the route device instead of searching the local bot store', () => {
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], { initialEntries: ['/bots/remote/other-mac/remote-bot?settings=1'] })} />);
  expect(screen.getByTestId('remote-settings').textContent).toBe('other-mac');
  expect(screen.queryByTestId('simple-bot-settings')).toBeNull();
});

it('routes a local voice deep link to the voice settings page', async () => {
  const router = createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
    initialEntries: ['/bots/bot-1?settings=1&settingsPage=voice'],
  });
  render(<RouterProvider router={router} />);
  expect(screen.getByTestId('simple-bot-settings').getAttribute('data-initial-page')).toBe('voice');
});

// #10045 unit regression: the existing drawer cases only use a physically discovered remote
// row. A cloud actor with no roster row must still open the production route's dialog;
// a stale row on another computer must not override the cloud's current home.
it('opens cloud-only settings and closes back to the same chat without exposing local edits', async () => {
  cloud.demotedBotIds = ['bot-1'];
  cloud.actors = [{ id: 'actor-1', externalId: 'bot-1', name: 'Cloud teammate', avatar: null,
    homeDeviceId: 'offline-mac', homeDevice: { deviceId: 'offline-mac', name: 'Offline Mac', online: false, isSelf: false } }];
  const rows = cloudRemoteBots({ enabled: true, selfDeviceId: 'desk', humanActorId: 'human', ...cloud }, []);
  expect(rows).toMatchObject([{ id: 'bot-1', deviceId: 'offline-mac', online: false }]);
  const router = createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
    initialEntries: ['/bots/remote/offline-mac/bot-1?settings=1&settingsPage=memory&keep=1'],
  });
  render(<RouterProvider router={router} />);
  expect(screen.getByRole('dialog')).toBeTruthy();
  expect(screen.getByTestId('remote-settings').textContent).toBe('offline-mac');
  expect(screen.getByTestId('remote-settings').getAttribute('data-initial-page')).toBe('memory');
  expect(screen.queryByTestId('simple-bot-settings')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'bots.close' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(router.state.location.pathname).toBe('/bots/remote/offline-mac/bot-1');
  expect(router.state.location.search).toBe('?keep=1');
});

it('does not open a stale remote settings route after the cloud home changes', () => {
  cloud.actors = [{ id: 'actor-remote', externalId: 'remote-bot', name: 'Remote', avatar: null,
    homeDeviceId: 'new-mac' }];
  render(<RouterProvider router={createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
    initialEntries: ['/bots/remote/other-mac/remote-bot?settings=1'],
  })} />);
  expect(screen.queryByRole('dialog')).toBeNull();
  expect(screen.queryByTestId('simple-bot-settings')).toBeNull();
});

// #10045 review: real drawer must prefer live presence over a stale cloud snapshot,
// while preserving the cloud-only read-only projection. Unit tier; remote consumer tested separately.
it.each([true, false])('uses live home presence (%s) for the cloud-only settings reason', (online) => {
  cloud.actors = [{ id: 'actor', externalId: 'cloud-bot', name: 'Cloud', avatar: null,
    homeDeviceId: 'home', homeDevice: { deviceId: 'home', name: 'Home', online: !online, isSelf: false, remoteControlEnabled: false } }];
  devices.rows = [{ deviceId: 'home', online, remoteControlEnabled: false }];
  const router = createMemoryRouter([{ path: '*', element: <BotSettingsDrawer /> }], {
    initialEntries: ['/bots/remote/home/cloud-bot?settings=1'],
  });
  render(<RouterProvider router={router} />);
  expect(screen.getByTestId('remote-settings').getAttribute('data-control-off')).toBe(String(online));
  expect(screen.queryByTestId('simple-bot-settings')).toBeNull();
});
