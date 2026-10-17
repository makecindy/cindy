// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { LEGAL_LINKS } from '../../../../shared/legalLinks';

const toast = vi.hoisted(() => ({
  error: vi.fn(),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, options?: { document?: string }) =>
      options?.document ? `${key}:${options.document}` : key,
  }),
}));

vi.mock('@/lib/toast', () => ({
  toast,
}));

vi.mock('@/hooks/useAutoUpdateSettings', () => ({ useAutoUpdateSettings: () => ({ state: { loading: false } }) }));
vi.mock('@/hooks/useAnalyticsSettings', () => ({ useAnalyticsSettings: () => ({ state: { loading: false } }) }));
vi.mock('@/hooks/useLogUploadSettings', () => ({ useLogUploadSettings: () => ({ state: { loading: false } }) }));
vi.mock('@/hooks/useExperimentalFeatures', () => ({ useExperimentalFlag: () => ({ enabled: false, setEnabled: vi.fn() }) }));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: vi.fn() }) }));
vi.mock('@/components/log-support/LogSupportActions', () => ({ OpenLogsRow: () => null, UploadLogsRow: () => null }));
vi.mock('../PiKernelVersionRow', () => ({ PiKernelVersionRow: () => null }));

import { AboutSection, LegalLinksRows } from '../AboutSection';

const openExternal = vi.fn();

describe('AboutSection legal links', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    openExternal.mockResolvedValue({ success: true });
    (window as unknown as { electronAPI: unknown }).electronAPI = {
      openExternal,
      maker: { agent: { getBinaryVersion: async () => ({ version: '1.0.0' }) } },
    };
  });

  afterEach(() => cleanup());

  // The old source checks never clicked a link or observed browser failures.
  // Reuse this component harness to verify the existing social actions.
  it('opens the displayed social destinations in community-first order', async () => {
    render(<AboutSection />);
    const panel = screen.getByRole('heading', { name: 'settings.about.social.title' }).parentElement!;
    const buttons = within(panel).getAllByRole('button');
    const destinations = ['https://discord.gg/V4yKguac7K', 'https://x.com/making_cindy', 'https://xhslink.com/m/XmfveHjLlL'];
    expect(buttons.map(button => button.title)).toEqual(destinations);
    for (const [index, button] of buttons.entries()) {
      fireEvent.click(button);
      await waitFor(() => expect(openExternal).toHaveBeenNthCalledWith(index + 1, destinations[index]));
    }
    expect(toast.error).not.toHaveBeenCalled();
  });

  it.each(['rejected', 'unsuccessful'])('shows the social failure message for a %s browser action', async mode => {
    if (mode === 'rejected') openExternal.mockRejectedValueOnce(new Error('Browser unavailable'));
    else openExternal.mockResolvedValueOnce({ success: false });
    render(<AboutSection />);
    fireEvent.click(screen.getByTitle('https://discord.gg/V4yKguac7K'));
    await waitFor(() => expect(toast.error).toHaveBeenCalledWith('settings.about.social.openFailed'));
  });

  it('renders both legal documents and opens the region-selected URLs externally', async () => {
    render(<LegalLinksRows />);

    const termsButton = screen.getByRole('button', {
      name: 'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
    });
    expect(termsButton.textContent).toContain(
      'settings.about.legal.viewDocument:settings.about.legal.termsOfServiceLabel',
    );
    expect(termsButton.className).toContain('px-6');
    expect(termsButton.className).toContain('h-9');

    fireEvent.click(termsButton);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(LEGAL_LINKS.termsOfService));

    const privacyButton = screen.getByRole('button', {
      name: 'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
    });
    expect(privacyButton.textContent).toContain(
      'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
    );

    fireEvent.click(privacyButton);
    await waitFor(() => expect(openExternal).toHaveBeenCalledWith(LEGAL_LINKS.privacyPolicy));
  });

  it('shows the localized failure message when the system browser cannot open a document', async () => {
    openExternal.mockResolvedValueOnce({ success: false });
    render(<LegalLinksRows />);

    fireEvent.click(
      screen.getByRole('button', {
        name: 'settings.about.legal.viewDocument:settings.about.legal.privacyPolicyLabel',
      }),
    );

    await waitFor(() =>
      expect(toast.error).toHaveBeenCalledWith('settings.about.legal.openFailed'),
    );
  });
});
