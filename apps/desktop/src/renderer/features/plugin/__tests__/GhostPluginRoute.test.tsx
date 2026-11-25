// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createMemoryRouter, Outlet, RouterProvider, useLocation } from 'react-router-dom';
import { afterEach, expect, it, vi } from 'vitest';
import { RouteErrorFallback } from '@/components/error/RouteErrorFallback';
import { useActiveMainView } from '@/hooks/useActiveMainView';
import { createGhostPluginRoute } from '../GhostPluginRoute';

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
  vi.useFakeTimers();
  const module = Promise.withResolvers<{
    default: () => React.JSX.Element;
  }>();
  const started = Promise.withResolvers<void>();
  const importPage = vi.fn(() => {
    started.resolve();
    return module.promise;
  });
  const { GhostPluginRoute, preloadPluginPage } = createGhostPluginRoute(importPage);
  const router = createMemoryRouter([{
    Component: Shell,
    children: [{
      errorElement: <RouteErrorFallback variant="section" />,
      children: [
        { path: '/cc-agent', element: <div>Old task</div> },
        { path: '/plugins', element: <GhostPluginRoute /> },
      ],
    }],
  }], { initialEntries: [initialPath] });
  render(<RouterProvider router={router} />);
  const resolvePage = () => module.resolve({
    default: () => <div>Plugin page{useLocation().search}</div>,
  });
  const advance = (ms: number) => act(() => vi.advanceTimersByTimeAsync(ms));
  const open = () => act(() => { fireEvent.click(screen.getByRole('button', { name: 'Plugins' })); });
  return { router, importPage, preloadPluginPage, module, resolvePage, advance, open, started };
}

it('commits a cold plugin navigation with the module pending and skips loading feedback for a short load', async () => {
  const { router, importPage, open, started, advance, resolvePage } = renderRoute();
  expect(importPage).not.toHaveBeenCalled();
  expect(screen.getByText('Old task')).toBeTruthy();
  await open();
  await started.promise;
  expect(router.state.location.pathname).toBe('/plugins');
  expect(screen.getByRole('button', { name: 'Plugins' }).getAttribute('aria-current')).toBe('page');
  expect(screen.queryByText('Old task')).toBeNull();
  await advance(100);
  expect(screen.queryByRole('status')).toBeNull();
  await act(async () => { resolvePage(); });
  await advance(300);
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();

  await act(() => router.navigate(-1));
  expect(screen.getByText('Old task')).toBeTruthy();
  await act(() => router.navigate(1));
  expect(screen.getByText('Plugin page')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
  expect(importPage).toHaveBeenCalledTimes(1);
});

it('shows the delayed loading status on a direct plugin deep link and keeps the query', async () => {
  const { started, advance, resolvePage } = renderRoute('/plugins?ghost=example');
  await started.promise;
  await advance(299);
  expect(screen.queryByRole('status')).toBeNull();
  await advance(1);
  expect(screen.getByRole('status').textContent).toBe('ccAgent.common.loading');
  await act(async () => { resolvePage(); });
  await advance(300);
  expect(screen.getByText('Plugin page?ghost=example')).toBeTruthy();
  expect(screen.queryByRole('status')).toBeNull();
});

it('shares a single intent load and shows a rejected import only after navigating', async () => {
  const { module, importPage, preloadPluginPage, open, started } = renderRoute();
  expect(importPage).not.toHaveBeenCalled();
  preloadPluginPage();
  preloadPluginPage();
  await started.promise;
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
