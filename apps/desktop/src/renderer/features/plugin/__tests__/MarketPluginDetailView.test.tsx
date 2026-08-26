/**
 * Regression coverage for the market Plugin detail view's explicit same-ID
 * replacement action and its data-preservation explanation.
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarketPluginDetailView } from '../MarketPluginDetailView';
import type { GhostManifest } from '../../../../shared/ghost';
import type { PluginMarketDetail } from '../../../../shared/pluginMarket';

const manifest: GhostManifest = {
  schemaVersion: 2,
  id: 'google-calendar',
  name: 'Google Calendar',
  version: '1.3.11',
  kind: 'chip',
  entry: 'main.js',
  notify: true,
};

const detail: PluginMarketDetail = {
  pluginId: 'release-google-calendar',
  ghostId: 'google-calendar',
  name: 'Google Calendar',
  description: 'Connect Google Calendar',
  author: 'Cindy',
  scope: 'public',
  organizationId: null,
  defaultInstall: false,
  releaseId: 'release-1',
  version: '1.3.11',
  publishedAt: '2026-07-25T00:00:00.000Z',
  icon: null,
  installState: 'not-installed',
  enabled: null,
  sourceType: 'server',
  sourceMarketName: null,
  manifest,
};

const renderDetail = (overrides: Partial<PluginMarketDetail> = {}) =>
  render(
    <MarketPluginDetailView
      detail={{ ...detail, ...overrides }}
      busy={false}
      onBack={vi.fn()}
      onInstall={vi.fn()}
      onIconLoadError={vi.fn()}
    />,
  );

describe('MarketPluginDetailView', () => {
  it('shows the marketing description outside the conflict state', () => {
    renderDetail();
    const description = screen.getByText('Connect Google Calendar');
    expect(description.id).toBe('');
    expect(
      screen
        .getByRole('button', { name: /settings\.ghosts\.market\.install/ })
        .getAttribute('aria-describedby'),
    ).toBeNull();
  });

  it('presents server catalog permissions before the package is downloaded', () => {
    renderDetail();
    expect(screen.getByText('settings.ghosts.perm.grantsTitle')).toBeTruthy();
  });

  it('offers an explicit same-id replacement and binds its explanation to the action', () => {
    renderDetail({ installState: 'conflict' });

    const reason = screen.getByText('settings.ghosts.market.replaceDescription');
    expect(reason.id).toBeTruthy();
    // 冲突态下正文让位给原因,不再显示营销描述。
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.replace$/,
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(false);
    expect(action.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('falls back to the ghostId when a plugin has no description', () => {
    renderDetail({ description: null });
    expect(screen.getByText('google-calendar')).toBeTruthy();
  });

  it('hides the install action when the host does not provide one', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy={false}
        onBack={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );
    expect(screen.queryByRole('button', { name: /settings\.ghosts\.market\.install/ })).toBeNull();
  });

  it('replaces the install action with a spinner while busy', () => {
    render(
      <MarketPluginDetailView
        detail={detail}
        busy
        onBack={vi.fn()}
        onInstall={vi.fn()}
        onIconLoadError={vi.fn()}
      />,
    );

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.install/,
    });
    expect(action.getAttribute('aria-busy')).toBe('true');
    expect(action.querySelector('.animate-spin')).toBeTruthy();
    expect(action.textContent).toBe('');
  });
});
