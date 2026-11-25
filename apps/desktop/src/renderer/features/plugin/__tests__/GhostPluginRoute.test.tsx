// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { RouteErrorFallback } from '@/components/error/RouteErrorFallback';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { createPluginPageLoader } from '../GhostPluginRoute';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));

function Shell() {
  const { activeKey, navigateToView } = useActiveMainView();
  return (
    <>
      <button aria-current={activeKey === 'plugins' ? 'page' : undefined}
        onClick={() => navigateToView('plugins')}>
        Plugins
      </button>
      <Outlet />
    </>
  );
}

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

function renderRoute(initialPath = '/cc-agent') {
  const module = Promise.withResolvers<{ GhostPluginPage: () => React.JSX.Element }>();
  const importPage = vi.fn(() => module.promise);
  const { loadPluginPage, preloadPluginPage } = createPluginPageLoader(importPage);
  const router = createMemoryRouter([{
    Component: Shell,
    children: [{
      errorElement: <RouteErrorFallback variant="section" />,
      children: [
        { path: '/cc-agent', element: <div>Old task</div> },
        {
          path: '/plugins',
          lazy: () => loadPluginPage().then(({ GhostPluginPage }) => ({ Component: GhostPluginPage })),
          HydrateFallback: () => null,
        },
      ],
    }],
  }], { initialEntries: [initialPath] });
  render(<RouterProvider router={router} />);
  const resolvePage = () => module.resolve({
    GhostPluginPage: function FixturePluginPage() {
      const { search, hash } = useLocation();
      return <div>Plugin page{search}{hash}</div>;
    },
  });
  const open = () => act(async () => { fireEvent.click(screen.getByRole('button', { name: 'Plugins' })); });
  return { router, importPage, preloadPluginPage, module, resolvePage, open };
}

// Unit / 工程约定 §7: the shared page loader must retain the outlet with no
// placeholder even for a slow import, and reuse the loaded module through history.
it('keeps the task during a slow import, then restores the plugin route through history', async () => {
  vi.useFakeTimers();
  const { router, importPage, open, resolvePage } = renderRoute();
  expect(importPage).not.toHaveBeenCalled();
  const task = screen.getByText('Old task');
  await open();
  expect(importPage).toHaveBeenCalledOnce();
  await act(() => vi.advanceTimersByTimeAsync(3_000));
  expect(screen.getByText('Old task')).toBe(task);
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { resolvePage(); });
  expect(screen.queryByText('Old task')).toBeNull();
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();

  await act(() => router.navigate(-1));
  expect(screen.getByText('Old task')).toBeTruthy();
  await act(() => router.navigate(1));
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(importPage).toHaveBeenCalledTimes(1);
});

// Unit / 工程约定 §7: a stale lazy navigation cannot replace the current task.
// The history test resolves the import before leaving, so it misses this ordering.
it('keeps the current task when an unfinished plugin navigation is superseded', async () => {
  const { router, importPage, open, resolvePage } = renderRoute();
  const task = screen.getByText('Old task');
  await open();
  expect(router.state.navigation.location?.pathname).toBe('/plugins');
  await act(() => router.navigate('/cc-agent'));
  expect(router.state.navigation.state).toBe('idle');

  await act(async () => { resolvePage(); });
  expect(screen.getByText('Old task')).toBe(task);
  expect(screen.queryByText('Plugin page')).toBeNull();
  expect(router.state.location.pathname).toBe('/cc-agent');

  await open();
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(importPage).toHaveBeenCalledOnce();
});

it('opens a plugin deep link with its query and fragment intact', async () => {
  const { importPage, resolvePage } = renderRoute('/plugins?ghost=example#permissions');
  expect(importPage).toHaveBeenCalledOnce();
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { resolvePage(); });
  expect(screen.getByText('Plugin page?ghost=example#permissions')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('reuses the prewarmed plugin module on the first visit', async () => {
  const { importPage, preloadPluginPage, open, resolvePage } = renderRoute();
  preloadPluginPage();
  await act(async () => { resolvePage(); });
  preloadPluginPage();
  expect(screen.getByText('Old task')).toBeTruthy();
  await open();
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(importPage).toHaveBeenCalledOnce();
});

it('shares a single intent load and shows a rejected import only after navigating', async () => {
  const { module, importPage, preloadPluginPage, open } = renderRoute();
  expect(importPage).not.toHaveBeenCalled();
  preloadPluginPage();
  preloadPluginPage();
  expect(importPage).toHaveBeenCalledTimes(1);
  await act(async () => { module.reject(new Error('fixture chunk load failed')); });
  expect(screen.queryByText('appError.title')).toBeNull();
  expect(screen.getByText('Old task')).toBeTruthy();
  const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await open();
    expect(screen.getByText('appError.title')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Plugins' }).getAttribute('aria-current')).toBe('page');
    expect(screen.queryByText('Old task')).toBeNull();
    expect(importPage).toHaveBeenCalledTimes(1);
  } finally {
    consoleError.mockRestore();
  }
});
