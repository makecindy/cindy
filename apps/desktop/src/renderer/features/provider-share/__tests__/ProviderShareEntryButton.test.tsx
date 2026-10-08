// @vitest-environment jsdom
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
  it('opens the management page when every capability is on', () => {
    const onOpen = vi.fn();
    render(<ProviderShareEntryButton gate="on" pendingCount={0} onOpen={onOpen} />);
    const button = screen.getByTestId('provider-share-entry');
    expect(button.getAttribute('aria-label')).toBe('providerShare.entry.manage');
    expect(button.getAttribute('aria-disabled')).toBeNull();
    expect(screen.queryByTestId('provider-share-entry-dot')).toBeNull();
    fireEvent.click(button);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('shows a dot and the pending count when requests wait for approval', () => {
    render(<ProviderShareEntryButton gate="on" pendingCount={2} onOpen={vi.fn()} />);
    expect(screen.getByTestId('provider-share-entry').getAttribute('aria-label')).toBe(
      'providerShare.entry.manageWithPending:2',
    );
    expect(screen.getByTestId('provider-share-entry-dot')).toBeTruthy();
  });

  it.each([
    ['invocation-off', 'providerShare.entry.disabledInvocation'],
    ['remote-off', 'providerShare.entry.disabledRemoteControl'],
  ] as const)('stays visible but unavailable when %s, explaining which step to enable', (gate, label) => {
    const onOpen = vi.fn();
    render(<ProviderShareEntryButton gate={gate} pendingCount={3} onOpen={onOpen} />);
    const button = screen.getByTestId('provider-share-entry');
    expect(button.getAttribute('aria-disabled')).toBe('true');
    expect(button.getAttribute('aria-label')).toBe(label);
    expect(screen.queryByTestId('provider-share-entry-dot')).toBeNull();
    fireEvent.click(button);
    expect(onOpen).not.toHaveBeenCalled();
  });
});
