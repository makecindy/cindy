// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  current: {
    mode: 'signed-out' as 'signed-out' | 'local' | 'cloud',
    isInitializing: false,
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

import { GuestRoute } from '../GuestRoute';

function renderAt(path: string, state?: { returnTo: string }) {
  return render(
    <MemoryRouter initialEntries={[{ pathname: path, state }]}>
      <Routes>
        <Route path="/" element={<div data-testid="app-shell" />} />
        <Route path="/plugins" element={<div data-testid="plugins-page" />} />
        <Route path="/login" element={<GuestRoute />}>
          <Route index element={<div data-testid="login-page" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('GuestRoute', () => {
  afterEach(() => {
    cleanup();
    authState.current = {
      mode: 'signed-out',
      isInitializing: false,
    };
  });

  it('keeps the login page for a real signed-out session', () => {
    renderAt('/login');
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('leaves login once skip-sign-in has committed local mode', () => {
    authState.current = {
      mode: 'local',
      isInitializing: false,
    };
    renderAt('/login');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });

  it('leaves login for a cloud session', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
    };
    renderAt('/login');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });

  it('restores the internal plugin destination after signing in', () => {
    authState.current = { mode: 'cloud', isInitializing: false };
    renderAt('/login', { returnTo: '/plugins?contribution=hello' });
    expect(screen.getByTestId('plugins-page')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });

  it.each(['https://example.com', '//example.com', '/login', '/login?returnTo=/plugins'])(
    'rejects an external destination or login loop: %s', (returnTo) => {
      authState.current = { mode: 'cloud', isInitializing: false };
      renderAt('/login', { returnTo });
      expect(screen.getByTestId('app-shell')).toBeTruthy();
      expect(screen.queryByTestId('login-page')).toBeNull();
    },
  );
});
