// @vitest-environment jsdom
import React from 'react';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { InstalledGhost } from '../../../../shared/ghost';
import { RetiredFeatureDetail } from '../RetiredFeatureDetail';
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('../PluginDetailTopBar', () => ({
  PluginDetailTopBar: () => null,
  usePluginDetailScrolled: () => ({ scrolled: false, onScroll: () => {} }),
}));
vi.mock('../GhostPluginIcon', () => ({ GhostPluginIcon: () => null }));
const old = {
  manifest: { id: 'ios-simulator', name: 'iOS Simulator' },
  enabled: false,
  retirement: { id: 'embedded-ios-simulator', eligible: true, unread: true },
} as InstalledGhost;
const props = () => ({
  ghost: old,
  busy: false,
  onBack: vi.fn(),
  onReplace: vi.fn(),
  onDismiss: vi.fn(),
  onUninstall: vi.fn(),
});
afterEach(cleanup);
describe('retired feature page', () => {
  it('offers installation in the original entry without controls for the former implementation', () => {
    const p = props();
    render(<RetiredFeatureDetail {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.retirement.install' }));
    expect(p.onReplace).toHaveBeenCalledOnce();
    expect(screen.queryByRole('switch')).toBeNull();
    expect(document.querySelector('webview')).toBeNull();
    expect(
      screen.getByText('settings.ghosts.retirement.embeddedSimulator.dataNotice'),
    ).toBeTruthy();
  });
  it.each([true, false])('reuses an installed replacement (enabled=%s)', (enabled) => {
    render(
      <RetiredFeatureDetail
        {...props()}
        replacement={{ manifest: { id: 'baguette-simulator' }, enabled } as InstalledGhost}
      />,
    );
    expect(
      screen.getByRole('button', {
        name: `settings.ghosts.retirement.${enabled ? 'open' : 'enable'}`,
      }),
    ).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.retirement.install' })).toBeNull();
  });
  it('does not recommend migration to users whose original plugin was disabled', () => {
    render(
      <RetiredFeatureDetail
        {...props()}
        ghost={{ ...old, retirement: { ...old.retirement!, eligible: false } }}
      />,
    );
    expect(screen.queryByText('settings.ghosts.retirement.recommendation')).toBeNull();
    expect(screen.queryByRole('button', { name: 'settings.ghosts.retirement.install' })).toBeNull();
  });
  it('allows dismissal and prevents duplicate installation clicks while busy', () => {
    const p = props();
    const view = render(<RetiredFeatureDetail {...p} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.ghosts.retirement.later' }));
    expect(p.onDismiss).toHaveBeenCalledOnce();
    view.rerender(<RetiredFeatureDetail {...p} busy />);
    expect(
      (
        screen.getByRole('button', {
          name: 'settings.ghosts.retirement.install',
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
});
