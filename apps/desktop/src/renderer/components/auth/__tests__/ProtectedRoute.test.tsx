// @vitest-environment jsdom

import { cleanup, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const authState = vi.hoisted(() => ({
  current: {
    mode: 'cloud' as 'signed-out' | 'local' | 'cloud',
    isInitializing: false,
    dataOwnerId: 'user-1' as string | null,
    canEnterApp: true,
  },
}));

vi.mock('@/contexts/AuthContext', () => ({
  useAuth: () => authState.current,
}));

import { ProtectedRoute } from '../ProtectedRoute';

function renderAt(path: string) {
  return render(
    <MemoryRouter initialEntries={[path]}>
      <Routes>
        <Route path="/login" element={<div data-testid="login-page" />} />
        <Route element={<ProtectedRoute />}>
          <Route path="/" element={<div data-testid="app-shell" />} />
        </Route>
      </Routes>
    </MemoryRouter>,
  );
}

describe('ProtectedRoute', () => {
  afterEach(() => {
    cleanup();
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
    };
  });

  it('keeps the shell mounted while same-owner refresh still allows entry', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      dataOwnerId: 'user-1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
    expect(screen.queryByTestId('login-page')).toBeNull();
  });

  it('leaves the shell during a real owner-change window', () => {
    authState.current = {
      mode: 'cloud',
      isInitializing: false,
      dataOwnerId: 'user-1',
      canEnterApp: false,
    };
    renderAt('/');
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('sends a real signed-out session to login', () => {
    authState.current = {
      mode: 'signed-out',
      isInitializing: false,
      dataOwnerId: null,
      canEnterApp: false,
    };
    renderAt('/');
    expect(screen.getByTestId('login-page')).toBeTruthy();
    expect(screen.queryByTestId('app-shell')).toBeNull();
  });

  it('lets local mode enter the app without a Cindy account', () => {
    authState.current = {
      mode: 'local',
      isInitializing: false,
      dataOwnerId: 'local-v1',
      canEnterApp: true,
    };
    renderAt('/');
    expect(screen.getByTestId('app-shell')).toBeTruthy();
  });
});
