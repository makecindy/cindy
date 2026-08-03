/**
 * Plugin page entry refreshes Git custom sources once per session key.
 * @vitest-environment jsdom
 */

import { render, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { usePluginMarketSourceAutoRefresh } from '../usePluginMarketSourceAutoRefresh';

const refreshGitSourcesIfStale = vi.fn();

function Harness({
  sessionKey,
  refreshMarket,
}: {
  sessionKey: string;
  refreshMarket: () => void | Promise<void>;
}) {
  usePluginMarketSourceAutoRefresh(sessionKey, refreshMarket);
  return null;
}

beforeEach(() => {
  refreshGitSourcesIfStale.mockReset();
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    pluginMarket: { refreshGitSourcesIfStale },
  };
});

describe('usePluginMarketSourceAutoRefresh', () => {
  it('refreshes the snapshot after a successful page-entry Git sync', async () => {
    refreshGitSourcesIfStale.mockResolvedValue({ refreshed: true });
    const refreshMarket = vi.fn();
    const view = render(<Harness sessionKey="cloud:user-1" refreshMarket={refreshMarket} />);

    await waitFor(() => expect(refreshGitSourcesIfStale).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(refreshMarket).toHaveBeenCalledTimes(1));

    view.rerender(<Harness sessionKey="cloud:user-1" refreshMarket={refreshMarket} />);
    expect(refreshGitSourcesIfStale).toHaveBeenCalledTimes(1);
  });

  it('does not reread the snapshot when Main throttles the Git sync', async () => {
    refreshGitSourcesIfStale.mockResolvedValue({ refreshed: false });
    const refreshMarket = vi.fn();
    render(<Harness sessionKey="cloud:user-1" refreshMarket={refreshMarket} />);

    await waitFor(() => expect(refreshGitSourcesIfStale).toHaveBeenCalledTimes(1));
    expect(refreshMarket).not.toHaveBeenCalled();
  });
});
