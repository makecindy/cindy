/**
 * 市场发现回执:插件数回执、skipped 与 unreadable 分开、submodule 空目录专门提示。
 * [PROTOCOL]: 变更时更新此头部，然后检查 CLAUDE.md
 * @vitest-environment jsdom
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

vi.mock('react-i18next', () => ({
  // 回显 key + 参数,便于断言 count/name 是否被传入。
  useTranslation: () => ({
    t: (key: string, params?: Record<string, unknown>) =>
      params ? `${key}:${JSON.stringify(params)}` : key,
  }),
}));

import { MarketplaceDiscoveryNotice } from '../MarketplaceDiscoveryNotice';

const base = { name: 'team-lib', pluginCount: 3, skippedCount: 0, unreadableCount: 0 };

describe('MarketplaceDiscoveryNotice', () => {
  it('shows the added receipt with market name and plugin count', () => {
    render(<MarketplaceDiscoveryNotice summary={base} action="added" />);
    expect(
      screen.getByText('settings.ghosts.market.sources.addedReceipt:{"name":"team-lib","count":3}'),
    ).toBeTruthy();
    expect(screen.queryByText(/skippedEntries/)).toBeNull();
    expect(screen.queryByText(/unreadableEntries/)).toBeNull();
    expect(screen.queryByText(/emptyWithEntries/)).toBeNull();
  });

  it('shows the refreshed receipt verb for refresh flows', () => {
    render(<MarketplaceDiscoveryNotice summary={base} action="refreshed" />);
    expect(
      screen.getByText(
        'settings.ghosts.market.sources.refreshedReceipt:{"name":"team-lib","count":3}',
      ),
    ).toBeTruthy();
  });

  it('keeps skipped and unreadable notices separate (invalid vs transient semantics)', () => {
    render(
      <MarketplaceDiscoveryNotice
        summary={{ ...base, pluginCount: 2, skippedCount: 3, unreadableCount: 1 }}
        action="added"
      />,
    );
    expect(
      screen.getByText('settings.ghosts.market.sources.skippedEntries:{"count":3}'),
    ).toBeTruthy();
    expect(
      screen.getByText('settings.ghosts.market.sources.unreadableEntries:{"count":1}'),
    ).toBeTruthy();
    // 可用数 > 0:不出 submodule 空目录提示。
    expect(screen.queryByText(/emptyWithEntries/)).toBeNull();
  });

  it('calls out the submodule-shaped empty market when entries exist but none are usable', () => {
    render(
      <MarketplaceDiscoveryNotice
        summary={{ ...base, pluginCount: 0, skippedCount: 2 }}
        action="added"
      />,
    );
    expect(screen.getByText('settings.ghosts.market.sources.emptyWithEntries')).toBeTruthy();
  });

  it('does not blame submodules for an unreadable-only zero result', () => {
    // 0 可用但只有 unreadable:是瞬时读取问题,submodule 提示会误导,只提示刷新重试。
    render(
      <MarketplaceDiscoveryNotice
        summary={{ ...base, pluginCount: 0, skippedCount: 0, unreadableCount: 2 }}
        action="refreshed"
      />,
    );
    expect(screen.queryByText(/emptyWithEntries/)).toBeNull();
    expect(
      screen.getByText('settings.ghosts.market.sources.unreadableEntries:{"count":2}'),
    ).toBeTruthy();
  });
});
