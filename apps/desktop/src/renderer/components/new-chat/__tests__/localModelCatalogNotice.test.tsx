// @vitest-environment jsdom
import { act, fireEvent, render, screen, cleanup } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModelCatalogNotice } from '../LocalModelCatalogNotice';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(cleanup);

describe('local catalog recovery notice', () => {
  it('explains the local failure and makes retry await the complete catalog refresh', async () => {
    let resolve!: (value: boolean) => void;
    const retry = vi.fn(() => new Promise<boolean>((done) => { resolve = done; }));
    const view = render(<LocalModelCatalogNotice failure={{ reason: 'legacy-busy' }} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('catalogRecovery.legacy');
    const button = screen.getByRole('button', { name: 'settings.providers.catalogRecovery.retry' });
    fireEvent.click(button);
    fireEvent.click(button);
    expect(retry).toHaveBeenCalledOnce();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    await act(async () => resolve(false));
    expect((button as HTMLButtonElement).disabled).toBe(false);
    view.rerender(<LocalModelCatalogNotice failure={{ reason: 'storage-quota' }} onRetry={retry} />);
    expect(screen.getByRole('status').textContent).toContain('catalogRecovery.quota');
    expect(screen.getByRole('status').textContent).not.toContain('remote');
  });
});
