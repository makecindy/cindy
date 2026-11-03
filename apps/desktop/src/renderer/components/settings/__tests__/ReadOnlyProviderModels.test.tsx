// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ReadOnlyProviderModelSection } from '../ReadOnlyProviderModels';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

afterEach(cleanup);

describe('ReadOnlyProviderModelSection refresh', () => {
  it('leaves the section without a refresh action when no handler is provided', () => {
    render(<ReadOnlyProviderModelSection title="Models" models={[]} note={null} />);
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('refreshes even when an empty catalog is shown as a note', () => {
    const onRefresh = vi.fn();
    render(<ReadOnlyProviderModelSection title="Models" models={[]} note="No models" onRefresh={onRefresh} />);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.models.refreshBuiltinAria' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });

  it('disables refresh while busy and enables it again after loading', () => {
    const onRefresh = vi.fn();
    const view = render(<ReadOnlyProviderModelSection title="Models" models={[]} note={null} onRefresh={onRefresh} refreshing />);
    const button = screen.getByRole('button', { name: 'settings.providers.models.refreshingAria' });
    expect(button.hasAttribute('disabled')).toBe(true);
    expect(button.getAttribute('aria-busy')).toBe('true');
    expect(button.querySelector('.animate-spinner')).not.toBeNull();
    fireEvent.click(button);
    expect(onRefresh).not.toHaveBeenCalled();

    view.rerender(<ReadOnlyProviderModelSection title="Models" models={[]} note={null} onRefresh={onRefresh} />);
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(button.getAttribute('aria-busy')).toBe('false');
    expect(button.querySelector('.animate-spinner')).toBeNull();
    fireEvent.click(button);
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});
