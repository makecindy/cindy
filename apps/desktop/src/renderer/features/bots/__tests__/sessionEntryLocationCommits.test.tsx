// @vitest-environment jsdom
/**
 * 灵动岛卡片的处置等到 React Router 真正提交目标地址后才发。这里用真实的内存路由
 * (含延迟加载的目标)驱动入口导航器,与 MainLayout 用同一个上报 hook。
 */
import { transferableAbortController } from 'node:util';
import { act, cleanup, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { Outlet, RouterProvider, createMemoryRouter, useNavigate } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createSessionEntryNavigator, type BotSessionEntryTarget, type SessionEntryNavigator } from '../botSessionOwners';
import { useSessionEntryLocationCommits } from '../useSessionEntryLocationCommits';

const targets: Record<string, BotSessionEntryTarget> = {
  lane: { route: '/bots/groups/g-1', consumesAlert: true },
  slow: { route: '/bots/groups/slow', consumesAlert: true },
};
/** Sessions whose route lookup waits for releaseLookup (e.g. Bot profiles still loading). */
const slowLookups = new Set(['lane-slow-lookup']);

const routers: Array<ReturnType<typeof createMemoryRouter>> = [];

function setup() {
  const consumeAlert = vi.fn<(sessionId: string, islandEntryId: string) => void>();
  const pathsAtConsume: string[] = [];
  let navigator!: SessionEntryNavigator;
  let releaseSlow!: () => void;
  const slowGate = new Promise<null>((resolve) => { releaseSlow = () => resolve(null); });
  let releaseLookup!: () => void;
  const lookupGate = new Promise<void>((resolve) => { releaseLookup = resolve; });

  function Shell() {
    const navigate = useNavigate();
    const [entryNavigator] = useState(() => createSessionEntryNavigator({
      resolveBotRoute: async (sessionId) => {
        if (slowLookups.has(sessionId)) {
          await lookupGate;
          return targets.lane!;
        }
        return targets[sessionId] ?? null;
      },
      openBotRoute: (route) => { void navigate(route); },
      consumeAlert: (sessionId, islandEntryId) => {
        pathsAtConsume.push(router.state.location.pathname);
        consumeAlert(sessionId, islandEntryId);
      },
      openOrdinary: vi.fn(),
    }));
    navigator = entryNavigator;
    useSessionEntryLocationCommits(entryNavigator);
    return <Outlet />;
  }

  const router = createMemoryRouter([
    {
      element: <Shell />,
      children: [
        { path: '/cc-agent/new', element: <p>new task</p> },
        { path: '/bots/groups/g-1', element: <p>group page</p> },
        { path: '/bots/groups/slow', loader: () => slowGate, element: <p>slow group page</p> },
        { path: '/elsewhere', element: <p>elsewhere</p> },
      ],
    },
  ], { initialEntries: ['/cc-agent/new'] });
  routers.push(router);
  render(<RouterProvider router={router} />);
  return { router, consumeAlert, pathsAtConsume, open: () => navigator, releaseSlow, releaseLookup };
}

const flush = () => act(async () => {
  await new Promise((resolve) => setTimeout(resolve, 0));
});

// React Router's Node-native Request requires a matching native AbortSignal (jsdom's
// does not satisfy it on newer Node, e.g. 25.x).
const nativeAbortController = transferableAbortController();
beforeEach(() => {
  vi.stubGlobal('AbortController', nativeAbortController.constructor);
  vi.stubGlobal('AbortSignal', nativeAbortController.signal.constructor);
});
afterEach(() => {
  cleanup();
  // Abort pending navigations / loaders while the native signal globals are still in place.
  for (const router of routers.splice(0)) router.dispose();
  vi.unstubAllGlobals();
});

describe('island card disposal waits for the router to commit the target', () => {
  it('disposes once the target location is committed, never before', async () => {
    const { router, consumeAlert, pathsAtConsume, open } = setup();
    await screen.findByText('new task');
    await act(async () => open()('lane', undefined, 'entry-1'));
    await flush();
    expect(await screen.findByText('group page')).toBeTruthy();
    expect(consumeAlert).toHaveBeenCalledExactlyOnceWith('lane', 'entry-1');
    expect(pathsAtConsume).toEqual(['/bots/groups/g-1']);
    expect(router.state.location.pathname).toBe('/bots/groups/g-1');
  });

  it('a delayed target that is superseded before it commits is never disposed', async () => {
    const { router, consumeAlert, open, releaseSlow } = setup();
    await screen.findByText('new task');
    await act(async () => open()('slow', undefined, 'entry-2'));
    await flush();
    // Still loading: the location has not been committed yet.
    expect(router.state.location.pathname).toBe('/cc-agent/new');
    expect(consumeAlert).not.toHaveBeenCalled();
    await act(async () => { void router.navigate('/elsewhere'); });
    await screen.findByText('elsewhere');
    releaseSlow();
    await flush();
    expect(consumeAlert).not.toHaveBeenCalled();
  });

  it('a delayed target that does commit is disposed only then', async () => {
    const { router, consumeAlert, open, releaseSlow } = setup();
    await screen.findByText('new task');
    await act(async () => open()('slow', undefined, 'entry-3'));
    await flush();
    expect(consumeAlert).not.toHaveBeenCalled();
    releaseSlow();
    await screen.findByText('slow group page');
    await flush();
    expect(router.state.location.pathname).toBe('/bots/groups/slow');
    expect(consumeAlert).toHaveBeenCalledExactlyOnceWith('slow', 'entry-3');
  });

  it('a commit while the lookup is still resolving forfeits disposal but keeps navigation', async () => {
    const { router, consumeAlert, open, releaseLookup } = setup();
    await screen.findByText('new task');
    await act(async () => open()('lane-slow-lookup', undefined, 'entry-5'));
    await act(async () => { void router.navigate('/elsewhere'); });
    await screen.findByText('elsewhere');
    releaseLookup();
    await screen.findByText('group page');
    await flush();
    expect(router.state.location.pathname).toBe('/bots/groups/g-1');
    expect(consumeAlert).not.toHaveBeenCalled();
  });

  it('a target that is already open is disposed without another navigation', async () => {
    const { router, consumeAlert, open } = setup();
    await screen.findByText('new task');
    await act(async () => { void router.navigate('/bots/groups/g-1'); });
    await screen.findByText('group page');
    await flush();
    await act(async () => open()('lane', undefined, 'entry-4'));
    await flush();
    expect(consumeAlert).toHaveBeenCalledExactlyOnceWith('lane', 'entry-4');
  });
});
