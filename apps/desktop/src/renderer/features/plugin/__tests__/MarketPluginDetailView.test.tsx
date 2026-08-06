/**
 * Regression coverage for the market Plugin detail view's conflict state:
 * 行动按钮只说「暂不可用」,不可用的原因必须同时出现在正文并绑给按钮,
 * 否则详情页比改动前信息更少(改动前按钮文案本身就是「插件标识冲突」)。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

import { MarketPluginDetailView } from '../MarketPluginDetailView';
import type { PluginMarketDetail } from '../../../../shared/pluginMarket';

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
  manifest: {
    schemaVersion: 2,
    id: 'google-calendar',
    name: 'Google Calendar',
    version: '1.3.11',
    kind: 'chip',
    entry: 'index.html',
    slots: [],
  },
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

  it('explains why a conflicting plugin is unavailable and binds it to the action', () => {
    renderDetail({ installState: 'conflict' });

    const reason = screen.getByText('settings.ghosts.market.conflictDescription');
    expect(reason.id).toBeTruthy();
    // 冲突态下正文让位给原因,不再显示营销描述。
    expect(screen.queryByText('Connect Google Calendar')).toBeNull();

    const action = screen.getByRole('button', {
      name: /settings\.ghosts\.market\.conflict$/,
    }) as HTMLButtonElement;
    expect(action.disabled).toBe(true);
    expect(action.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('falls back to the ghostId when a plugin has no description', () => {
    renderDetail({ description: null });
    expect(screen.getByText('google-calendar')).toBeTruthy();
  });
});
