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

import { GhostMainViewNavEntries } from '../GhostMainViewNavEntries';

function LocationProbe() {
  return <output data-testid="location">{useLocation().pathname}</output>;
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

    const buttons = screen.getAllByRole('button');
    expect(buttons.map((button) => button.getAttribute('aria-label'))).toEqual([
      'Alpha',
      'Workspace',
    ]);
    expect(buttons[0]?.getAttribute('aria-current')).toBe('page');
    expect(buttons[0]?.getAttribute('title')).toBe('Alpha');
    expect(buttons[0]?.getAttribute('data-native-title')).toBe('truncated-text');
    expect(buttons[0]?.querySelector('.lucide-puzzle')).toBeTruthy();
    expect(buttons[1]?.querySelector('.lucide-globe')).toBeTruthy();
    expect(buttons[0]?.querySelector('svg')?.getAttribute('width')).toBe('15');
    expect(buttons[0]?.querySelector('img')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Workspace' }));
    expect(screen.getByTestId('location').textContent).toBe('/apps/workspace');
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
