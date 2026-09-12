// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProviderImportPreview } from '../../../../shared/providerImport';

const mocks = vi.hoisted(() => ({
  t: (key: string) => key,
  toast: { success: vi.fn(), error: vi.fn() },
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: mocks.t }) }));
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }));
import { ProviderImportDialog } from '../ProviderImportDialog';

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
    previewProviderImport: vi.fn(async (_id: string, target?: string) => ({
      ...preview,
      ...(target
        ? { action: 'update' as const, providerId: target, existingProviderName: 'My Account' }
        : {}),
    })),
    confirmProviderImport: vi.fn(async () => ({
      ok: true,
      providerId: 'new-connection',
      authMethod: 'apiKey',
    })),
    cancelProviderImport: vi.fn(async () => ({ ok: true })),
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

describe('ProviderImportDialog', () => {
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
    const pending = deferred<{ ok: boolean; providerId: string; authMethod: string }>();
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
