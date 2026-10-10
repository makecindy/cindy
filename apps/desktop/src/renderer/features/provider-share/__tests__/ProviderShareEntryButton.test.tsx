// @vitest-environment jsdom
/**
 * 「允许被远程调用」一行的「远程与分享」入口：有组时写组的台数，没有组时写「远程与分享」；
 * 始终可点(供应商组不依赖远程调用)；有待审批申请时带提示点。
 */
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ProviderShareEntryButton } from '../ProviderShareEntryButton';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { count?: number }) => (options?.count !== undefined ? `${key}:${options.count}` : key),
  }),
}));

afterEach(() => cleanup());

describe('ProviderShareEntryButton', () => {
  it('names the page when the provider has no group and opens it', () => {
    const onOpen = vi.fn();
    render(<ProviderShareEntryButton groupSize={null} pendingCount={0} onOpen={onOpen} />);
    const button = screen.getByTestId('provider-share-entry');
    expect(button.textContent).toBe('providerShare.entry.label');
    expect(button.getAttribute('aria-label')).toBeNull();
    expect(screen.queryByTestId('provider-share-entry-dot')).toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows how many computers the group has instead of a separate group row', () => {
    render(<ProviderShareEntryButton groupSize={3} pendingCount={0} onOpen={vi.fn()} />);
    expect(screen.getByTestId('provider-share-entry').textContent).toBe('settings.providers.remote.groupBadge:3');
  });

  it('shows a dot and the pending count when requests wait for approval', () => {
    render(<ProviderShareEntryButton groupSize={2} pendingCount={2} onOpen={vi.fn()} />);
    expect(screen.getByTestId('provider-share-entry').getAttribute('aria-label')).toBe(
      'settings.providers.remote.groupBadge:2 · providerShare.entry.pending:2',
    );
    expect(screen.getByTestId('provider-share-entry-dot')).toBeTruthy();
  });
});
