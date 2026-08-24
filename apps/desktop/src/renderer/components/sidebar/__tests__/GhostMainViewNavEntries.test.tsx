/** @vitest-environment jsdom */

import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

const items = [
  {
    ghostId: 'alpha',
    title: 'Alpha',
    icon: 'puzzle',
    manifest: { id: 'alpha', name: 'Alpha Plugin' },
    installedGhost: {},
  },
  {
    ghostId: 'workspace',
    title: 'Workspace',
    icon: 'globe',
    manifest: { id: 'workspace', name: 'Workspace Plugin' },
    installedGhost: {},
  },
];

vi.mock('@/cindy-brain/ghostMainViews', () => ({
  useGhostMainViews: () => ({ declared: items, routeCapable: items, sidebarVisible: items }),
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      key === 'settings.ghosts.page.manageAria' ? `Manage ${options?.name}` : key,
  }),
}));

import { GhostMainViewNavEntries } from '../GhostMainViewNavEntries';

function LocationProbe() {
  const location = useLocation();
  return <output data-testid="location">{`${location.pathname}${location.search}`}</output>;
}

describe('GhostMainViewNavEntries', () => {
  it('renders the shared order, active state and encoded navigation', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <Routes>
          <Route
            path="*"
            element={
              <>
                <GhostMainViewNavEntries variant="row" />
                <LocationProbe />
              </>
            }
          />
        </Routes>
      </MemoryRouter>,
    );

    const alphaButton = screen.getByRole('button', { name: 'Alpha' });
    const workspaceButton = screen.getByRole('button', { name: 'Workspace' });
    expect(alphaButton.getAttribute('aria-current')).toBe('page');
    expect(alphaButton.getAttribute('title')).toBe('Alpha');
    expect(alphaButton.getAttribute('data-native-title')).toBe('truncated-text');
    expect(alphaButton.querySelector('.lucide-puzzle')).toBeTruthy();
    expect(workspaceButton.querySelector('.lucide-globe')).toBeTruthy();
    expect(alphaButton.querySelector('svg')?.getAttribute('width')).toBe('15');
    expect(alphaButton.querySelector('img')).toBeNull();

    fireEvent.click(workspaceButton);
    expect(screen.getByTestId('location').textContent).toBe('/apps/workspace');

    const manageAlphaButton = screen.getByRole('button', { name: 'Manage Alpha Plugin' });
    expect(manageAlphaButton.querySelector('.lucide-sliders-horizontal')).toBeTruthy();
    fireEvent.click(manageAlphaButton);
    expect(screen.getByTestId('location').textContent).toBe('/settings?tab=ghosts&ghost=alpha');
  });

  it('uses the native 18px rail icon geometry without a fallback tile', () => {
    render(
      <MemoryRouter initialEntries={['/apps/alpha']}>
        <GhostMainViewNavEntries variant="rail" />
      </MemoryRouter>,
    );

    const railIcon = screen.getByRole('button', { name: 'Alpha' }).querySelector('svg');
    expect(railIcon?.classList.contains('lucide-puzzle')).toBe(true);
    expect(railIcon?.getAttribute('width')).toBe('18');
  });
});
