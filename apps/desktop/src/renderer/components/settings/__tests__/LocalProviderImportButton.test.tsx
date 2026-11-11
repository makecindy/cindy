// @vitest-environment jsdom
import { StrictMode } from 'react';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { LocalProviderImportScan } from '../../../../shared/localProviderImport';

const mocks = vi.hoisted(() => ({ toast: { error: vi.fn() } }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: mocks.toast }));
import { LocalProviderImportButton } from '../LocalProviderImportButton';

function fixture(): LocalProviderImportScan {
  return {
    sources: [{ source: 'claude-code' }, { source: 'alma', issue: 'invalid' }],
    items: [
      {
        importId: 'ready',
        source: 'claude-code',
        name: 'Relay A',
        endpoints: [
          {
            agent: 'claude-code',
            protocol: 'anthropic-messages',
            baseUrl: 'https://relay.test',
            hasCredential: true,
          },
        ],
      },
      {
        importId: 'duplicate',
        source: 'cc-switch',
        name: 'Relay duplicate',
        issue: 'duplicate',
        endpoints: [],
      },
      {
        importId: 'incomplete',
        source: 'opencode',
        name: 'Incomplete',
        issue: 'needsInput',
        endpoints: [{ agent: 'pi', baseUrl: '', hasCredential: false }],
      },
    ],
  };
}
const maker = {
  scanLocalProviderImports: vi.fn(async () => fixture()),
  cancelProviderImport: vi.fn(async (_id: string) => ({ ok: true })),
  editLocalProviderImport: vi.fn(async (_id: string, _input: unknown) => fixture().items[0]),
};
beforeEach(() => {
  vi.clearAllMocks();
  maker.scanLocalProviderImports.mockImplementation(async () => fixture());
  maker.editLocalProviderImport.mockImplementation(async () => fixture().items[0]);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { maker } });
});
afterEach(cleanup);
const clickOpen = () =>
  fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.local.title' }));

describe('local configuration import selection', () => {
  it('explains a helper-only source instead of silently showing an empty result', async () => {
    maker.scanLocalProviderImports.mockResolvedValue({ items: [], sources: [{ source: 'claude-code', issue: 'unsupported' }] });
    render(<LocalProviderImportButton onImported={vi.fn()} />);
    clickOpen();
    expect(await screen.findByText(/Claude Code · settings.providers.import.local.status.unsupported/)).toBeTruthy();
  });

  it('only reads on explicit open, reports a broken source, and hands selected IDs to existing review', async () => {
    const onImported = vi.fn();
    render(<LocalProviderImportButton onImported={onImported} />);
    expect(maker.scanLocalProviderImports).not.toHaveBeenCalled();
    clickOpen();
    await screen.findByText('Relay A');
    expect(screen.getByText(/Alma · settings.providers.import.local.status.invalid/)).toBeTruthy();
    const boxes = screen.getAllByRole('checkbox') as HTMLInputElement[];
    expect(boxes.map((e) => [e.checked, e.disabled])).toEqual([
      [true, false],
      [false, true],
      [false, true],
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.local.review' }));
    expect(onImported).toHaveBeenCalledWith(['ready']);
    expect(maker.cancelProviderImport.mock.calls.map((c) => c[0])).not.toContain('ready');
  });
  it('releases a late scan after dismissal instead of reopening or importing it', async () => {
    let resolve!: (value: LocalProviderImportScan) => void;
    maker.scanLocalProviderImports.mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const onImported = vi.fn();
    render(<LocalProviderImportButton onImported={onImported} />);
    clickOpen();
    fireEvent.click(screen.getByRole('button', { name: 'common.dismiss' }));
    await act(async () => resolve(fixture()));
    expect(onImported).not.toHaveBeenCalled();
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('ready');
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });
  it('StrictMode does not read without action or discard newly scanned candidates', async () => {
    render(
      <StrictMode>
        <LocalProviderImportButton onImported={vi.fn()} />
      </StrictMode>,
    );
    clickOpen();
    await screen.findByText('Relay A');
    expect(maker.scanLocalProviderImports).toHaveBeenCalledTimes(1);
    expect(maker.cancelProviderImport).not.toHaveBeenCalled();
  });
  it('edits incomplete candidates through the opaque Main bridge without retrieving secrets', async () => {
    render(<LocalProviderImportButton onImported={vi.fn()} />);
    clickOpen();
    await screen.findByText('Incomplete');
    fireEvent.click(
      screen.getAllByRole('button', { name: 'settings.providers.import.local.edit' })[1],
    );
    expect(screen.getAllByRole('alertdialog')).toHaveLength(1);
    fireEvent.change(screen.getByLabelText('settings.providers.import.local.baseUrl'), {
      target: { value: 'https://relay.test/v1' },
    });
    fireEvent.change(screen.getByLabelText('settings.providers.import.local.protocol'), {
      target: { value: 'openai-chat' },
    });
    fireEvent.change(screen.getByLabelText('settings.providers.import.local.apiKey'), {
      target: { value: 'FAKE-NEW-KEY' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() =>
      expect(maker.editLocalProviderImport).toHaveBeenCalledWith('incomplete', {
        name: 'Incomplete',
        endpoints: [
          { baseUrl: 'https://relay.test/v1', protocol: 'openai-chat', apiKey: 'FAKE-NEW-KEY' },
        ],
      }),
    );
  });
  it('keeps edited values after a failed save and closes only after a successful retry', async () => {
    let rejectEdit!: (error: Error) => void;
    maker.editLocalProviderImport.mockImplementationOnce(
      () => new Promise<LocalProviderImportScan['items'][number]>((_, reject) => {
        rejectEdit = reject;
      }),
    );
    render(<LocalProviderImportButton onImported={vi.fn()} />);
    clickOpen();
    await screen.findByText('Incomplete');
    fireEvent.click(screen.getAllByRole('button', { name: 'settings.providers.import.local.edit' })[1]);
    const values = {
      name: 'Edited relay',
      baseUrl: 'https://edited.test/v1',
      protocol: 'openai-chat',
      apiKey: 'FAKE-RETRY-KEY',
    };
    for (const [field, value] of Object.entries(values)) {
      fireEvent.change(screen.getByLabelText(`settings.providers.import.local.${field}`), {
        target: { value },
      });
    }
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await act(async () => rejectEdit(new Error('save failed')));
    expect(mocks.toast.error).toHaveBeenCalledWith('settings.providers.import.local.editFailed');
    for (const [field, value] of Object.entries(values)) {
      expect((screen.getByLabelText(`settings.providers.import.local.${field}`) as HTMLInputElement).value).toBe(value);
    }
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.custom.save' }));
    await waitFor(() => expect(maker.editLocalProviderImport).toHaveBeenCalledTimes(2));
    expect(maker.editLocalProviderImport).toHaveBeenLastCalledWith('incomplete', {
      name: values.name,
      endpoints: [{ baseUrl: values.baseUrl, protocol: values.protocol, apiKey: values.apiKey }],
    });
    await waitFor(() => expect(screen.queryByLabelText('settings.providers.import.local.apiKey')).toBeNull());
  });
  it('rescanning releases previous drafts and unmount releases the new scan', async () => {
    const view = render(<LocalProviderImportButton onImported={vi.fn()} />);
    clickOpen();
    await screen.findByText('Relay A');
    fireEvent.click(screen.getByRole('button', { name: 'settings.providers.import.local.rescan' }));
    await waitFor(() => expect(maker.scanLocalProviderImports).toHaveBeenCalledTimes(2));
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('ready');
    maker.cancelProviderImport.mockClear();
    view.unmount();
    await act(async () => {});
    expect(maker.cancelProviderImport).toHaveBeenCalledWith('incomplete');
  });
});
