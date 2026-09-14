// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import React from 'react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const signInMock = vi.fn();

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@/hooks/useSignInToCindy', () => ({
  useSignInToCindy: () => signInMock,
}));

import { HomeZeroModelAction } from '../HomeZeroModelAction';

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderCard(authMode: 'signed-out' | 'local' | 'cloud') {
  return render(
    <MemoryRouter initialEntries={['/']}>
      <Routes>
        <Route
          path="/"
          element={
            <>
              <HomeZeroModelAction authMode={authMode} narrow={false} />
              <LocationProbe />
            </>
          }
        />
        <Route path="/settings" element={<LocationProbe />} />
      </Routes>
    </MemoryRouter>,
  );
}

afterEach(() => {
  cleanup();
  signInMock.mockReset();
});

describe('HomeZeroModelAction', () => {
  it('signed-out: login copy and CTA calls sign-in', () => {
    renderCard('signed-out');
    expect(screen.getByText('onboarding.homeZeroModel.title')).toBeTruthy();
    expect(screen.queryByText('onboarding.connectProvider.title')).toBeNull();
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      'bg-[var(--accent-cta-bg)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).toContain(
      'text-[var(--accent-pure-cta-fg)]',
    );
    expect(screen.getByTestId('home-zero-model-cta').className).not.toContain('send-btn-fg');
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(signInMock).toHaveBeenCalledTimes(1);
  });

  it('cloud: opens Cindy AI provider connect, not the provider list', () => {
    renderCard('cloud');
    fireEvent.click(screen.getByTestId('home-zero-model-cta'));
    expect(signInMock).not.toHaveBeenCalled();
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&connect=xd');
  });

  it('own API link opens the provider wizard', () => {
    renderCard('signed-out');
    fireEvent.click(screen.getByTestId('home-zero-model-own-api'));
    expect(screen.getByTestId('loc').textContent).toBe('/settings?tab=providers&wizard=1');
  });
});
