// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/toast', () => ({ toast: { error: vi.fn(), success: vi.fn() } }));
import { LlamaCppProviderDetail } from '../LlamaCppProviderDetail';

const variant = {
  repo: 'owner/model',
  file: 'model.gguf',
  quantization: 'Q4_K_M',
  sizeBytes: 1234,
  verifiedAt: '2026-09-25',
};
const catalog = [
  {
    id: 'model',
    name: 'Test model',
    aliases: [],
    descriptions: { en: 'Shared model description' },
    variants: [variant],
  },
];
afterEach(cleanup);
function api(installed = false) {
  const maker = {
    llamaCppStatus: vi
      .fn()
      .mockResolvedValue({ installed, supported: true, running: installed, models: [], catalog }),
    llamaCppInstall: vi.fn().mockResolvedValue(undefined),
    llamaCppFiles: vi.fn().mockResolvedValue([{ name: 'model.gguf', size: 1234 }]),
    llamaCppDownload: vi.fn().mockResolvedValue(undefined),
    llamaCppStart: vi.fn().mockResolvedValue(undefined),
    llamaCppStop: vi.fn(),
    llamaCppCancel: vi.fn().mockResolvedValue(undefined),
  };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker } });
  return maker;
}
describe('llama.cpp uses the Ollama detail flow', () => {
  it('only exposes pause when supported and resumes the same download after reopening', async () => {
    const maker = api(true);
    const snapshot = {
      installed: true,
      supported: true,
      running: true,
      canPauseDownload: true,
      models: [],
      catalog,
      operation: { kind: 'download', model: variant, completed: 50, total: 100, paused: false },
    };
    maker.llamaCppStatus.mockImplementation(async () => structuredClone(snapshot));
    maker.llamaCppCancel.mockImplementation(async (action) => {
      snapshot.operation.paused = action === 'pause';
    });
    const first = render(<LlamaCppProviderDetail onChanged={() => {}} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.providers.local.pauseDownload' }),
    );
    expect(
      await screen.findByRole('button', { name: 'settings.providers.local.resumeDownload' }),
    ).toBeTruthy();
    first.unmount();
    render(<LlamaCppProviderDetail onChanged={() => {}} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.providers.local.resumeDownload' }),
    );
    await waitFor(() => expect(maker.llamaCppCancel).toHaveBeenLastCalledWith('resume'));
    expect(maker.llamaCppDownload).not.toHaveBeenCalled();
    expect(maker.llamaCppStart).not.toHaveBeenCalled();
  });
  it('installs without starting the service; model use owns startup', async () => {
    const maker = api();
    render(<LlamaCppProviderDetail onChanged={() => {}} />);
    expect(await screen.findByText('Test model')).toBeTruthy();
    expect(screen.getByText('Shared model description')).toBeTruthy();
    expect(
      screen
        .getByRole('button', { name: 'settings.providers.local.downloadAdd' })
        .hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(
      screen.getByRole('button', { name: 'settings.providers.local.installInCindy' }),
    );
    await waitFor(() => expect(maker.llamaCppStatus).toHaveBeenCalledTimes(2));
    expect(maker.llamaCppStart).not.toHaveBeenCalled();
    expect(maker.llamaCppInstall).toHaveBeenCalledOnce();
    expect(maker.llamaCppDownload).not.toHaveBeenCalled();
  });
  it('allows downloads while stopped without a manual startup step', async () => {
    const maker = api(true);
    maker.llamaCppStatus.mockResolvedValue({ installed: true, supported: true, running: false, models: [], catalog });
    render(<LlamaCppProviderDetail onChanged={() => {}} />);
    const button = await screen.findByRole('button', { name: 'settings.providers.local.downloadAdd' });
    expect(button.hasAttribute('disabled')).toBe(false);
    expect(screen.queryByRole('button', { name: 'settings.providers.local.start' })).toBeNull();
    fireEvent.click(button);
    await waitFor(() => expect(maker.llamaCppDownload).toHaveBeenCalledOnce());
    expect(maker.llamaCppStart).not.toHaveBeenCalled();
  });
  it('puts progress and cancellation in the model card and finishes without a second apply action', async () => {
    const maker = api(true);
    let finish!: () => void;
    maker.llamaCppDownload.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const onChanged = vi.fn();
    render(<LlamaCppProviderDetail onChanged={onChanged} />);
    const name = await screen.findByText('Test model');
    const card = name.closest('article')!;
    fireEvent.click(
      within(card).getByRole('button', { name: 'settings.providers.local.downloadAdd' }),
    );
    const activeCard = screen.getByText('Test model').closest('article')!;
    // Old running main/preload can still coexist with HMR renderer; never send pause to its cancel handler.
    expect(
      screen.queryByRole('button', { name: 'settings.providers.local.pauseDownload' }),
    ).toBeNull();
    expect(within(activeCard).getByRole('progressbar')).toBeTruthy();
    fireEvent.click(
      within(activeCard).getByRole('button', { name: 'settings.providers.local.cancelDownload' }),
    );
    expect(maker.llamaCppCancel).toHaveBeenCalledOnce();
    maker.llamaCppStatus.mockResolvedValue({
      installed: true,
      supported: true,
      running: true,
      models: [{ ...variant, id: 'downloaded', size: 1234 }],
      catalog,
    });
    await act(async () => finish());
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
    expect(screen.queryByRole('progressbar')).toBeNull();
    expect(screen.queryByText('settings.providers.llamacpp.applyModels')).toBeNull();
    expect(maker.llamaCppStart).not.toHaveBeenCalled();
    fireEvent.change(
      screen.getByRole('textbox', { name: 'settings.providers.local.searchPlaceholder' }),
      { target: { value: 'Test' } },
    );
    expect(screen.getByText('settings.providers.local.alreadyInstalled')).toBeTruthy();
  });
  it('offers retry on the failed card and does not add or start a failed download', async () => {
    const maker = api(true);
    maker.llamaCppDownload.mockRejectedValueOnce(
      new Error('[PRECONDITION_FAILED] DOWNLOAD_CHECKSUM'),
    );
    const changed = vi.fn();
    render(<LlamaCppProviderDetail onChanged={changed} />);
    fireEvent.click(
      await screen.findByRole('button', { name: 'settings.providers.local.downloadAdd' }),
    );
    const retry = await screen.findByRole('button', {
      name: 'settings.providers.local.retryDownload',
    });
    expect(changed).not.toHaveBeenCalled();
    expect(maker.llamaCppStart).not.toHaveBeenCalled();
    fireEvent.click(retry);
    await waitFor(() => expect(maker.llamaCppDownload).toHaveBeenCalledTimes(2));
  });
  it('restores a download in its card after leaving and reopening details', async () => {
    const maker = api(true);
    maker.llamaCppStatus.mockResolvedValue({
      installed: true,
      supported: true,
      running: true,
      models: [],
      catalog,
      operation: {
        kind: 'download',
        model: variant,
        completed: 50,
        total: 100,
        bytesPerSecond: 25,
      },
    });
    const { unmount } = render(<LlamaCppProviderDetail onChanged={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'),
    );
    unmount();
    render(<LlamaCppProviderDetail onChanged={() => {}} />);
    await waitFor(() =>
      expect(screen.getByRole('progressbar').getAttribute('aria-valuenow')).toBe('50'),
    );
    expect(screen.getByRole('progressbar').closest('article')?.textContent).toContain('Test model');
  });
});
