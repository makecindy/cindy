// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import type { ReactNode } from 'react';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

const fullscreenState = vi.hoisted(() => ({ isMac: true, isFullscreen: true }));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/hooks/useMacFullscreen', () => ({
  useMacFullscreen: () => fullscreenState,
}));
vi.mock('@/components/ui/dropdown-menu', () => ({
  DropdownMenu: ({ children }: { children: ReactNode }) => <>{children}</>,
  DropdownMenuContent: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  DropdownMenuItem: ({ children, onSelect }: { children: ReactNode; onSelect?: () => void }) => (
    <button onClick={onSelect}>{children}</button>
  ),
  DropdownMenuTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
}));

import { ChromeActions } from '../ChromeActions';

afterEach(() => {
  cleanup();
  fullscreenState.isMac = true;
  fullscreenState.isFullscreen = true;
  delete (window as Partial<Window>).electronAPI;
});

describe('ChromeActions fullscreen fallback', () => {
  it('lets a macOS user exit fullscreen when native traffic lights are unavailable', () => {
    const windowExitFullscreen = vi.fn();
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: { windowExitFullscreen } as Partial<Window['electronAPI']>,
    });

    render(
      <MemoryRouter>
        <ChromeActions isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole('button', { name: 'contentHeader.exitFullscreen' }));

    expect(windowExitFullscreen).toHaveBeenCalledOnce();
  });

  it('does not show the fallback outside macOS fullscreen', () => {
    fullscreenState.isFullscreen = false;

    render(
      <MemoryRouter>
        <ChromeActions isSidebarCollapsed={false} onToggleSidebar={vi.fn()} />
      </MemoryRouter>,
    );

    expect(screen.queryByRole('button', { name: 'contentHeader.exitFullscreen' })).toBeNull();
  });
});
