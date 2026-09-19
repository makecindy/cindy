// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CindyMakeTestCard } from '../CindyMakeTestCard';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { CindyMakeCompletionMeta } from '../../../../shared/cindyMakeSession';
const h = vi.hoisted(() => ({ api: vi.fn(), patch: vi.fn() }));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }),
}));
vi.mock('@/lib/makerChatStore', () => ({ makerChatStore: { updateSystemCardData: h.patch } }));
vi.mock('@/features/device-link/stickySessionOrigin', () => ({
  getStickySessionDeviceId: () => undefined,
}));
const meta: CindyMakeCompletionMeta = { reportedAt: 123, commit: 'a'.repeat(40), changedFiles: 2 };
const view = () =>
  render(<CindyMakeTestCard sessionId="session" completionId="completion" meta={meta} />);
beforeEach(() => {
  vi.clearAllMocks();
  setDataOwnerGeneration('test-owner');
  h.api.mockResolvedValue(meta);
  vi.stubGlobal('electronAPI', { cindyMakeTest: h.api });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('completion card in the input area', () => {
  it('only reads status on mount and starts the isolated build after the user clicks', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'status'));
    expect(h.api).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole('textbox')).toBeNull();
    h.api.mockResolvedValueOnce({ ...meta, test: { status: 'starting' } });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.start' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'start'));
  });
  it('does not let a delayed status read undo the acknowledged launch', async () => {
    let status!: (value: CindyMakeCompletionMeta) => void;
    h.api.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          status = resolve;
        }),
    );
    h.api.mockResolvedValueOnce({ ...meta, test: { status: 'starting' } });
    view();
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.start' }));
    await waitFor(() => expect(h.patch).toHaveBeenCalledOnce());
    await act(async () => status(meta));
    expect(h.patch).toHaveBeenCalledOnce();
    expect(h.patch.mock.calls[0][2].test.status).toBe('starting');
  });
  it('keeps the card when continuing is rejected and persists continuation only after acknowledgment', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    h.api.mockRejectedValueOnce(new Error('rejected'));
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await screen.findByRole('alert');
    expect(h.patch.mock.calls.some(([, , value]) => value.continuedAt)).toBe(false);
    h.api.mockResolvedValueOnce({ ...meta, continuedAt: 456 });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    await waitFor(() =>
      expect(h.patch).toHaveBeenCalledWith('session', 'completion', { ...meta, continuedAt: 456 }),
    );
  });
  it('prevents duplicate launches while the first request is pending', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    let resolve!: (value: CindyMakeCompletionMeta) => void;
    h.api.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const start = screen.getByRole('button', { name: 'cindyMake.test.start' });
    fireEvent.click(start);
    fireEvent.click(start);
    expect(h.api.mock.calls.filter(([, , action]) => action === 'start')).toHaveLength(1);
    await act(async () => resolve({ ...meta, test: { status: 'starting' } }));
  });
  it('does not offer a launch without a verified commit', () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ reportedAt: 123 }}
      />,
    );
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.start' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(screen.getByRole('alert').textContent).toContain('cindyMake.test.errors.unavailable');
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it('offers all three choices and generates a personal installer only on click', async () => {
    view();
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    expect(screen.getByRole('button', { name: 'cindyMake.test.continue' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'cindyMake.test.start' })).toBeDefined();
    h.api.mockResolvedValueOnce({ ...meta, lastAction: 'build', personal: { status: 'waiting' } });
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.generate' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'build'));
    expect(h.patch).toHaveBeenCalledWith(
      'session',
      'completion',
      expect.objectContaining({ personal: { status: 'waiting' } }),
    );
  });
  it('shows personal build progress and disables every action until it finishes', () => {
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{ ...meta, lastAction: 'build', personal: { status: 'packaging' } }}
      />,
    );
    expect(screen.getByText('cindyMake.personal.status.packaging')).toBeDefined();
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.continue' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.test.start' }) as HTMLButtonElement).disabled,
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.test.continue' }));
    expect(h.api.mock.calls.some(([, , action]) => action !== 'status')).toBe(false);
  });
  it('offers the installer when ready and gives failed builds a retry', async () => {
    const { rerender } = render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', artifactName: 'Cindy.exe' },
        }}
      />,
    );
    await waitFor(() => expect(h.api).toHaveBeenCalledOnce());
    expect(
      screen.getAllByRole('button').every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'cindyMake.personal.open' }));
    await waitFor(() => expect(h.api).toHaveBeenCalledWith('session', 'completion', 'open-build'));
    rerender(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'failed', error: 'checksFailed' },
        }}
      />,
    );
    expect(screen.getByRole('alert').textContent).toBe('cindyMake.personal.errors.checksFailed');
    expect(
      screen.getAllByRole('button').every((button) => !(button as HTMLButtonElement).disabled),
    ).toBe(true);
    expect(
      (screen.getByRole('button', { name: 'cindyMake.personal.generate' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
  });
  it('replaces the generation action with the shared version switch for a runnable snapshot', async () => {
    const switchVersion = vi
      .fn()
      .mockResolvedValue({
        currentId: 'original',
        selectedId: 'original',
        versions: [],
        switching: true,
      });
    vi.stubGlobal('electronAPI', {
      cindyMakeTest: h.api,
      getCindyVersions: vi
        .fn()
        .mockResolvedValue({
          currentId: 'original',
          selectedId: 'original',
          versions: [],
          switching: false,
        }),
      actCindyVersion: switchVersion,
    });
    render(
      <CindyMakeTestCard
        sessionId="session"
        completionId="completion"
        meta={{
          ...meta,
          lastAction: 'build',
          personal: { status: 'ready', versionId: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa' },
        }}
      />,
    );
    fireEvent.click(
      await screen.findByRole('button', { name: 'cindyMake.versions.switchPersonal' }),
    );
    await waitFor(() =>
      expect(switchVersion).toHaveBeenCalledWith('switch', 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa'),
    );
    expect(h.api.mock.calls.some(([, , action]) => action === 'open-build')).toBe(false);
  });
});
