// @vitest-environment jsdom
import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { describe, expect, it, vi } from 'vitest';

import { FeatureSidebarSlotProvider, useFeatureContentHeader } from '@/features/feature-context';
import {
  SettingsContentHeader,
  SettingsContentHeaderRegistration,
} from '../SettingsContentHeader';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string) =>
      ({
        'settings.title': 'Settings',
        'settings.back': 'Back',
      })[key] ?? key,
  }),
}));

function HeaderSlotProbe() {
  const headerContent = useFeatureContentHeader();
  return <div data-testid="header-slot">{headerContent}</div>;
}

describe('SettingsContentHeader', () => {
  it('renders the settings title at chat-titlebar typography', () => {
    render(
      <MemoryRouter>
        <SettingsContentHeader />
      </MemoryRouter>,
    );

    const title = screen.getByRole('heading', { name: 'Settings' });
    expect(title.className).toContain('text-sm');
    expect(title.className).toContain('font-medium');
  });

  it('keeps the back button outside the window drag region and returns home', () => {
    render(
      <MemoryRouter initialEntries={['/settings']}>
        <Routes>
          <Route path="/" element={<div>home</div>} />
          <Route path="/settings" element={<SettingsContentHeader />} />
        </Routes>
      </MemoryRouter>,
    );

    const back = screen.getByRole('button', { name: 'Back' });
    expect(back.className).toContain('rounded-full');
    expect(back.className).toContain('active:scale-[0.98]');
    expect(back.getAttribute('data-state')).toBe('closed');
    expect(
      (back.style as CSSStyleDeclaration & { WebkitAppRegion: string }).WebkitAppRegion,
    ).toBe('no-drag');

    fireEvent.click(back);
    expect(screen.getByText('home')).toBeTruthy();
  });

  it('registers the title into the shared ContentHeader slot', () => {
    render(
      <MemoryRouter>
        <FeatureSidebarSlotProvider isCollapsed={false}>
          <SettingsContentHeaderRegistration />
          <HeaderSlotProbe />
        </FeatureSidebarSlotProvider>
      </MemoryRouter>,
    );

    expect(screen.getByTestId('header-slot').textContent).toContain('Settings');
    expect(screen.getByRole('button', { name: 'Back' })).toBeTruthy();
  });
});
