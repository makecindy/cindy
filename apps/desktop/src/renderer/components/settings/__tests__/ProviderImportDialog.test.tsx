// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderImportPreview, ProviderImportConfirmResult } from '../../../../shared/providerImport';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }));
import { ProviderImportDialog, ProviderImportBatchDialog, ProviderImportFileButton } from '../ProviderImportDialog';

const preview: ProviderImportPreview = {
  importId: 'draft-one',
  kind: 'custom',
  name: 'Vendor Demo',
  authMethod: 'apiKey',
  action: 'create',
  providerId: 'new-connection',
  runtimes: [
    {
      agent: 'codex',
      protocol: 'openai-chat',
      baseUrl: 'https://vendor.test/v1',
      modelCount: 1,
      willFetchModels: false,
      hasApiKey: true,
      headerNames: [],
    },
  ],
  updateTargets: [{ id: 'old-connection', name: 'My Account' }],
};
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
function api() {
  return {
    importProviderFile: vi.fn(async (): Promise<string | string[] | null> => 'draft-one'),
    previewProviderImport: vi.fn(async (_id: string, target?: string) => ({
      ...preview,
      ...(target
        ? { action: 'update' as const, providerId: target, existingProviderName: 'My Account' }
        : {}),
    })),
    confirmProviderImport: vi.fn(async (_id: string): Promise<ProviderImportConfirmResult> => ({
      ok: true,
      providerId: 'new-connection',
      authMethod: 'apiKey',
    })),
    cancelProviderImport: vi.fn(async (_id: string) => ({ ok: true })),
    providerOAuthLogin: vi.fn(async () => ({ ok: true })),
    providerOAuthCancel: vi.fn(async () => ({ ok: true })),
    onProviderOAuthProgress: vi.fn(() => () => undefined),
  };
}
let maker: ReturnType<typeof api>;
beforeEach(() => {
  vi.clearAllMocks();
  maker = api();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker } });
});
afterEach(cleanup);

// #7760, unit: actual file button hands only an opaque id to the existing review;
// prior dialog tests do not cover guidance, sample downloads, native picker
// cancellation/errors or late replies. Minimal inputs: open without selecting,
// expand format help, download the sample, then select/cancel a native file.
// Measured standalone on Windows: 1.90s (16 tests, 2026-10-29).
describe('ProviderImportFileButton', () => {
  function openGuide() {
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.fromFile' }));
  }
  function selectFile() {
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.selectJsonFile' }));
  }

  it('explains the format before opening the native picker and can dismiss without importing', () => {
    render(<ProviderImportFileButton onImported={vi.fn()} />);
    openGuide();
    expect(screen.getByRole('alertdialog').textContent).toContain('settings.providers.import.fileGuideDescription');
    expect(maker.importProviderFile).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.cancel' }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(maker.importProviderFile).not.toHaveBeenCalled();
  });

  it('offers a JSON download and expandable format help without starting an import', () => {
    render(<ProviderImportFileButton onImported={vi.fn()} />);
    openGuide();
    const download = screen.getByRole('link', { name: 'settings.providers.import.downloadExample' }) as HTMLAnchorElement;
    expect(download.download).toBe('cindy-provider-example.json');
    const sample = JSON.parse(decodeURIComponent(download.href.split(',')[1]));
    expect(sample.kind).toBe('custom');
    expect(sample.endpoints[0].models[0]).toMatchObject({ group: 'custom:example', maxOutputTokens: 32000 });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.showFormat' }));
    expect(screen.getByRole('button', { name: 'settings.providers.import.hideFormat' }).getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('settings.providers.import.formatModels')).toBeTruthy();
    expect(screen.getByText('settings.providers.import.formatMetadata')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.hideFormat' }));
    expect(screen.queryByText('settings.providers.import.formatModels')).toBeNull();
    expect(maker.importProviderFile).not.toHaveBeenCalled();
    expect(maker.confirmProviderImport).not.toHaveBeenCalled();
  });

  it('opens review only after selection and never confirms automatically', async () => {
    const onImported = vi.fn();
    render(<ProviderImportFileButton onImported={onImported} />);
    openGuide();
    selectFile();
    await waitFor(() => expect(onImported).toHaveBeenCalledExactlyOnceWith('draft-one'));
    expect(maker.importProviderFile).toHaveBeenCalledWith();
    expect(maker.confirmProviderImport).not.toHaveBeenCalled();
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('ignores cancellation and lets the user retry', async () => {
    maker.importProviderFile.mockResolvedValueOnce(null);
    const onImported = vi.fn();
    render(<ProviderImportFileButton onImported={onImported} />);
    openGuide();
    const button = screen.getByRole('button', { name: 'settings.providers.import.selectJsonFile' });
    selectFile();
    await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
    expect(onImported).not.toHaveBeenCalled();
    expect(mocks.toast.error).not.toHaveBeenCalled();
    fireEvent.click(button);
    await waitFor(() => expect(onImported).toHaveBeenCalledWith('draft-one'));
  });

  it.each([
    ['PROVIDER_IMPORT_FILE_TOO_LARGE', 'fileTooLarge'],
    ['PROVIDER_IMPORT_FILE_INVALID', 'fileInvalid'],
    ['PROVIDER_IMPORT_FILE_READ_FAILED', 'fileReadFailed'],
  ])('shows localized feedback for %s without echoing file details', async (code, key) => {
    maker.importProviderFile.mockRejectedValueOnce(new Error(`[${code}] FAKE-SECRET-PATH`));
    render(<ProviderImportFileButton onImported={vi.fn()} />);
    openGuide();
    selectFile();
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith(`settings.providers.import.${key}`));
    expect(screen.getByRole('alertdialog')).toBeTruthy();
  });

  it('releases a late draft when leaving settings or switching accounts', async () => {
    const pending = deferred<string | null>();
    maker.importProviderFile.mockReturnValueOnce(pending.promise);
    const onImported = vi.fn();
    const view = render(<ProviderImportFileButton onImported={onImported} />);
    openGuide();
    selectFile();
    view.unmount();
    await act(async () => pending.resolve('draft-late'));
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-late');
    expect(onImported).not.toHaveBeenCalled();
  });

  it('hands a batch to review and releases all late drafts after leaving settings', async () => {
    const pending = deferred<string[]>();
    maker.importProviderFile.mockReturnValueOnce(pending.promise);
    const onImported = vi.fn();
    const view = render(<ProviderImportFileButton onImported={onImported} />);
    openGuide(); selectFile(); view.unmount();
    await act(async () => pending.resolve(['draft-a', 'draft-b']));
    expect(maker.cancelProviderImport.mock.calls.map(([id]) => id)).toEqual(['draft-a', 'draft-b']);
    expect(onImported).not.toHaveBeenCalled();
    render(<ProviderImportFileButton onImported={onImported} />);
    maker.importProviderFile.mockResolvedValueOnce(['draft-a', 'draft-b']);
    openGuide(); selectFile();
    await waitFor(() => expect(onImported).toHaveBeenCalledWith(['draft-a', 'draft-b']));
    expect(maker.confirmProviderImport).not.toHaveBeenCalled();
  });
});

// Batch UI, standard tier: real component + existing IPC contracts. Smallest
// distinguishing input is two drafts; exercise selection, partial writes and departure.
describe('ProviderImportBatchDialog', () => {
  const ids = ['draft-a', 'draft-b'];
  const start = () => fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.batchImport' }));
  beforeEach(() => {
    maker.previewProviderImport.mockImplementation(async id => ({ ...preview, importId: id, name: id, providerId: id }));
    maker.confirmProviderImport.mockImplementation(async id => ({ ok: true, providerId: id, authMethod: 'apiKey' }));
  });

  it('imports only checked entries and releases the rest when closed', async () => {
    const onDone = vi.fn();
    const view = render(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByRole('checkbox', { name: 'draft-a' });
    fireEvent.click(screen.getByRole('checkbox', { name: 'draft-b' })); start();
    await screen.findByText('settings.providers.import.batchStatus.saved');
    expect(maker.confirmProviderImport.mock.calls).toEqual([['draft-a']]);
    expect(onDone).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(onDone).toHaveBeenCalledWith('draft-a');
    view.unmount();
    await waitFor(() => expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-b'));
  });

  it('retains successful results and retries only failed entries', async () => {
    maker.confirmProviderImport.mockRejectedValueOnce(new Error('failure'));
    render(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('checkbox', { name: 'draft-a' }); start();
    await screen.findByText('settings.providers.import.batchStatus.saved');
    expect(screen.getByText('settings.providers.import.batchStatus.failed')).toBeTruthy();
    start();
    await waitFor(() => expect(screen.getAllByText('settings.providers.import.batchStatus.saved')).toHaveLength(2));
    expect(maker.confirmProviderImport.mock.calls).toEqual([['draft-a'], ['draft-b'], ['draft-a']]);
  });

  it('defers OAuth and interruption consent to individual review without automatically authorizing', async () => {
    maker.previewProviderImport.mockImplementation(async id => ({ ...preview, importId: id, name: id,
      authMethod: id === 'draft-b' ? 'oauth' : 'apiKey' }));
    maker.confirmProviderImport.mockResolvedValueOnce({ ok: false, confirmationRequired: 'codex-image-generation-reload', busyCount: 1 });
    render(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByRole('checkbox', { name: 'draft-a' }); start();
    await waitFor(() => expect(screen.getAllByText('settings.providers.import.batchStatus.manual')).toHaveLength(2));
    expect(maker.confirmProviderImport.mock.calls).toEqual([['draft-a']]);
    expect(maker.providerOAuthLogin).not.toHaveBeenCalled();
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.providers.import.batchReviewOne' })[0]);
    await screen.findByRole('button', { name: 'settings.providers.import.create' });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.cancel' }));
    await screen.findByText('settings.providers.import.batchStatus.skipped');
    expect(maker.confirmProviderImport).toHaveBeenCalledTimes(1);
  });

  it('stops before the next write after unmount and cleans up the in-flight draft again', async () => {
    const pending = deferred<ProviderImportConfirmResult>();
    maker.confirmProviderImport.mockReturnValueOnce(pending.promise);
    const onDone = vi.fn();
    const view = render(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByRole('checkbox', { name: 'draft-a' }); start(); start(); view.unmount();
    await act(async () => pending.resolve({ ok: true, providerId: 'draft-a', authMethod: 'apiKey' }));
    expect(maker.confirmProviderImport.mock.calls).toEqual([['draft-a']]);
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-a');
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-b');
    expect(onDone).not.toHaveBeenCalled();
  });

  it('reports an OAuth connection already saved when authorization is cancelled instead of retrying its creation', async () => {
    maker.previewProviderImport.mockImplementation(async id => ({ ...preview, importId: id, name: id, authMethod: 'oauth' }));
    maker.confirmProviderImport.mockResolvedValueOnce({ ok: true, providerId: 'saved-oauth', authMethod: 'oauth' });
    maker.providerOAuthLogin.mockResolvedValueOnce({ ok: false });
    const onDone = vi.fn();
    const view = render(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByRole('checkbox', { name: 'draft-a' });
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.providers.import.batchReviewOne' })[0]);
    fireEvent.click(await screen.findByRole('button', { name: 'settings.providers.import.addAndAuthorize' }));
    await waitFor(() => expect(mocks.toast.error).toHaveBeenCalledWith('settings.providers.import.oauthFailed'));
    const previewsBeforeRefresh = maker.previewProviderImport.mock.calls.length;
    view.rerender(<ProviderImportBatchDialog importIds={ids} onClose={vi.fn()} onDone={onDone} />);
    await screen.findByRole('button', { name: 'settings.providers.import.retryOAuth' });
    expect(maker.previewProviderImport).toHaveBeenCalledTimes(previewsBeforeRefresh);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.cancel' }));
    await screen.findByText('settings.providers.import.batchStatus.authorizationPending');
    expect(maker.confirmProviderImport).toHaveBeenCalledTimes(1);
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    expect(onDone).toHaveBeenCalledWith('saved-oauth');
  });
});

describe('ProviderImportDialog', () => {
  it('releases drafts when the review is replaced or unmounted without cancelling the new review', async () => {
    const view = render(
      <StrictMode><ProviderImportDialog key="one" importId="draft-one" onClose={vi.fn()} onDone={vi.fn()} /></StrictMode>,
    );
    await screen.findByText('Vendor Demo');
    expect(maker.cancelProviderImport).not.toHaveBeenCalled();
    view.rerender(
      <StrictMode><ProviderImportDialog key="two" importId="draft-two" onClose={vi.fn()} onDone={vi.fn()} /></StrictMode>,
    );
    await waitFor(() => expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-one'));
    expect(maker.cancelProviderImport).not.toHaveBeenCalledWith('draft-two');
    view.unmount();
    await waitFor(() => expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-two'));
  });

  it('releases a failed confirmed draft after its review unmounts', async () => {
    let reject!: (error: Error) => void;
    maker.confirmProviderImport.mockImplementationOnce(() => new Promise((_resolve, fail) => { reject = fail; }));
    const view = render(<ProviderImportDialog importId="draft-one" onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('Vendor Demo');
    fireEvent.click(screen.getByText('settings.providers.import.create'));
    view.unmount();
    await waitFor(() => expect(maker.cancelProviderImport).toHaveBeenCalledTimes(1));
    await act(async () => reject(new Error('save failed')));
    expect(maker.cancelProviderImport).toHaveBeenCalledTimes(2);
  });

  it('survives StrictMode and saves only on explicit confirmation, not the automatic Radix close event', async () => {
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(
      <StrictMode>
        <ProviderImportDialog importId="draft-one" onClose={onClose} onDone={onDone} />
      </StrictMode>,
    );
    await screen.findByText('Vendor Demo');
    expect(maker.confirmProviderImport).not.toHaveBeenCalled();
    expect(maker.cancelProviderImport).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings.providers.import.create'));
    await waitFor(() => expect(onDone).toHaveBeenCalledExactlyOnceWith('new-connection'));
    expect(maker.confirmProviderImport).toHaveBeenCalledExactlyOnceWith(
      'draft-one',
      undefined,
      undefined,
    );
    expect(onClose).not.toHaveBeenCalled();
    expect(maker.cancelProviderImport).not.toHaveBeenCalled();
  });

  it('re-previews an explicitly selected target and disables confirmation while waiting', async () => {
    render(<ProviderImportDialog importId="draft-one" onClose={vi.fn()} onDone={vi.fn()} />);
    await screen.findByText('Vendor Demo');
    const next = deferred<ProviderImportPreview>();
    maker.previewProviderImport.mockImplementationOnce(() => next.promise);
    fireEvent.change(screen.getByLabelText('settings.providers.import.destination'), {
      target: { value: 'old-connection' },
    });
    expect(
      (screen.getByText('settings.providers.import.create').closest('button') as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    await act(async () =>
      next.resolve({ ...preview, action: 'update', providerId: 'old-connection' }),
    );
    expect(maker.previewProviderImport).toHaveBeenLastCalledWith('draft-one', 'old-connection');
    fireEvent.click(screen.getByText('settings.providers.import.replaceKey'));
    await waitFor(() =>
      expect(maker.confirmProviderImport).toHaveBeenCalledExactlyOnceWith(
        'draft-one',
        'old-connection',
        undefined,
      ),
    );
  });

  it('requires another click before interrupting busy Codex work', async () => {
    maker.confirmProviderImport.mockResolvedValueOnce({
      ok: false,
      confirmationRequired: 'codex-image-generation-reload',
      busyCount: 2,
    } as never);
    const onClose = vi.fn();
    render(<ProviderImportDialog importId="draft-one" onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText('Vendor Demo');
    fireEvent.click(screen.getByText('settings.providers.import.create'));
    await screen.findByText('settings.providers.import.busyWarning');
    expect(maker.confirmProviderImport).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings.providers.custom.imageGenerationReload.interrupt'));
    await waitFor(() =>
      expect(maker.confirmProviderImport).toHaveBeenLastCalledWith('draft-one', undefined, true),
    );
  });

  it('cancels without saving, including Escape', async () => {
    const onClose = vi.fn();
    render(<ProviderImportDialog importId="draft-one" onClose={onClose} onDone={vi.fn()} />);
    await screen.findByText('Vendor Demo');
    fireEvent.keyDown(screen.getByRole('alertdialog'), { key: 'Escape' });
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('draft-one');
    expect(maker.confirmProviderImport).not.toHaveBeenCalled();
  });

  it('retains the saved OAuth connection for login retry and can cancel its waiting authorization', async () => {
    maker.previewProviderImport.mockResolvedValue({
      ...preview,
      authMethod: 'oauth',
      updateTargets: [],
      oauth: {
        flow: 'authorization-code',
        authorizeHost: 'auth.vendor.test',
        tokenHost: 'auth.vendor.test',
      },
    } as never);
    maker.confirmProviderImport.mockResolvedValue({
      ok: true,
      providerId: 'new-connection',
      authMethod: 'oauth',
    });
    maker.providerOAuthLogin.mockResolvedValueOnce({ ok: false });
    const onClose = vi.fn();
    const onDone = vi.fn();
    render(<ProviderImportDialog importId="draft-one" onClose={onClose} onDone={onDone} />);
    await screen.findByText('Vendor Demo');
    fireEvent.click(screen.getByText('settings.providers.import.addAndAuthorize'));
    await waitFor(() =>
      expect(mocks.toast.error).toHaveBeenCalledWith('settings.providers.import.oauthFailed'),
    );
    const login = deferred<{ ok: boolean }>();
    maker.providerOAuthLogin.mockImplementationOnce(() => login.promise);
    fireEvent.click(screen.getByText('settings.providers.import.retryOAuth'));
    await waitFor(() => expect(maker.providerOAuthLogin).toHaveBeenCalledTimes(2));
    expect(maker.confirmProviderImport).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('settings.providers.import.cancel'));
    expect(maker.providerOAuthCancel).toHaveBeenCalledWith(
      'new-connection',
      expect.objectContaining({ releaseOwner: true }),
    );
    await act(async () => login.resolve({ ok: true }));
    expect(onDone).not.toHaveBeenCalled();
  });

  it('ignores an unmounted import completion instead of closing the next import', async () => {
    const pending = deferred<ProviderImportConfirmResult>();
    maker.confirmProviderImport.mockImplementationOnce(() => pending.promise);
    const onDone = vi.fn();
    const view = render(
      <ProviderImportDialog importId="draft-one" onClose={vi.fn()} onDone={onDone} />,
    );
    await screen.findByText('Vendor Demo');
    fireEvent.click(screen.getByText('settings.providers.import.create'));
    view.unmount();
    await act(async () => pending.resolve({ ok: true, providerId: 'old', authMethod: 'apiKey' }));
    expect(onDone).not.toHaveBeenCalled();
  });
});
