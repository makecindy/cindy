// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PiPackageView } from '../../../../shared/piPackages';

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

const toastMocks = vi.hoisted(() => ({
  error: vi.fn(),
  success: vi.fn(),
}));

vi.mock('@/lib/toast', () => ({ toast: toastMocks }));

vi.mock('@/components/ui/switch', () => ({
  Switch: (props: {
    checked: boolean;
    disabled?: boolean;
    onCheckedChange?: (checked: boolean) => void;
    ['aria-label']?: string;
  }) => (
    <button
      role="switch"
      aria-checked={props.checked}
      aria-label={props['aria-label']}
      disabled={props.disabled}
      onClick={() => props.onCheckedChange?.(!props.checked)}
    />
  ),
}));

import { PiPackagesSection } from '../PiPackagesSection';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function packageView(index: number): PiPackageView {
  return {
    source: `npm:sample-extension-${index}`,
    name: `sample-extension-${index}`,
    version: `1.0.${index}`,
    enabled: false,
    resources: [{
      kind: 'extension',
      name: `extensions/index-${index}.ts`,
      compatibility: 'supported',
    }],
  };
}

function installElectronApi(options?: {
  listPiPackages?: ReturnType<typeof vi.fn>;
  mutatePiPackage?: ReturnType<typeof vi.fn>;
  onChanged?: (callback: () => void) => () => void;
}) {
  const listPiPackages = options?.listPiPackages ?? vi.fn(async () => ({
    available: true,
    packages: [packageView(1), packageView(2)],
  }));
  const mutatePiPackage = options?.mutatePiPackage ?? vi.fn(async () => ({
    available: true,
    packages: [packageView(1), packageView(2)],
  }));
  const onPiPackagesChanged = vi.fn(options?.onChanged ?? (() => () => undefined));
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    maker: { listPiPackages, mutatePiPackage, onPiPackagesChanged },
  };
  return { listPiPackages, mutatePiPackage, onPiPackagesChanged };
}

describe('PiPackagesSection interaction state machine', () => {
  beforeEach(() => {
    toastMocks.error.mockReset();
    toastMocks.success.mockReset();
  });

  afterEach(() => {
    cleanup();
    Reflect.deleteProperty(window, 'electronAPI');
  });

  it('shows a persistent load error with retry instead of a false empty state', async () => {
    const listPiPackages = vi
      .fn()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce({ available: true, packages: [packageView(1)] });
    installElectronApi({ listPiPackages });

    render(<PiPackagesSection />);

    expect((await screen.findByRole('alert')).textContent).toContain('settings.piPackages.loadFailed');
    expect(screen.queryByText('settings.piPackages.empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.retry' }));

    expect(await screen.findByText('sample-extension-1')).toBeTruthy();
    expect(listPiPackages).toHaveBeenCalledTimes(2);
  });

  it('disables every mutation control while one row is busy and exposes progress', async () => {
    const mutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const { mutatePiPackage } = installElectronApi({
      mutatePiPackage: vi.fn(() => mutation.promise),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    const updateButtons = screen.getAllByRole('button', { name: 'settings.piPackages.updateAria' });
    fireEvent.click(updateButtons[0]!);

    await waitFor(() => expect(mutatePiPackage).toHaveBeenCalledTimes(1));
    expect((updateButtons[1] as HTMLButtonElement).disabled).toBe(true);
    expect(
      (screen.getAllByRole('button', { name: 'settings.piPackages.removeAria' })[1] as HTMLButtonElement).disabled,
    ).toBe(true);
    expect((screen.getAllByRole('switch')[1] as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByRole('status', { name: 'settings.piPackages.operationInProgress' })).toBeTruthy();

    mutation.resolve({ available: true, packages: [packageView(1), packageView(2)] });
    await waitFor(() => expect((updateButtons[1] as HTMLButtonElement).disabled).toBe(false));
  });

  it('keeps the install confirmation open while working and after failure so it can retry', async () => {
    const firstMutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const mutatePiPackage = vi
      .fn()
      .mockImplementationOnce(() => firstMutation.promise)
      .mockResolvedValueOnce({ available: true, packages: [packageView(1)] });
    installElectronApi({
      listPiPackages: vi.fn(async () => ({ available: true, packages: [] })),
      mutatePiPackage,
    });
    render(<PiPackagesSection />);
    await screen.findByText('settings.piPackages.empty');

    fireEvent.change(screen.getByPlaceholderText('settings.piPackages.sourcePlaceholder'), {
      target: { value: 'npm:sample-extension-1' },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.install' }));
    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.confirmInstall' }));

    expect(screen.getByRole('alertdialog')).toBeTruthy();
    expect(
      (screen.getByRole('button', { name: 'settings.piPackages.confirmInstall' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    firstMutation.reject(new Error('network'));
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'settings.piPackages.confirmInstall' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.confirmInstall' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mutatePiPackage).toHaveBeenCalledTimes(2);
  });

  it('keeps the uninstall confirmation open after failure and closes it only after success', async () => {
    const firstMutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const mutatePiPackage = vi
      .fn()
      .mockImplementationOnce(() => firstMutation.promise)
      .mockResolvedValueOnce({ available: true, packages: [packageView(2)] });
    installElectronApi({ mutatePiPackage });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.removeAria' })[0]!);
    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.confirmUninstall' }));
    expect(
      (screen.getByRole('button', { name: 'settings.piPackages.confirmUninstall' }) as HTMLButtonElement).disabled,
    ).toBe(true);

    firstMutation.reject(new Error('locked'));
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'settings.piPackages.confirmUninstall' }) as HTMLButtonElement).disabled,
      ).toBe(false);
    });
    expect(screen.getByRole('alertdialog')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.confirmUninstall' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(mutatePiPackage).toHaveBeenLastCalledWith({
      action: 'remove',
      source: 'npm:sample-extension-1',
    });
  });

  it('shows progress for enable or disable mutations', async () => {
    const mutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const { mutatePiPackage } = installElectronApi({
      mutatePiPackage: vi.fn(() => mutation.promise),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('switch')[0]!);
    await waitFor(() => {
      expect(mutatePiPackage).toHaveBeenCalledWith({
        action: 'set-enabled',
        source: 'npm:sample-extension-1',
        enabled: true,
      });
    });
    expect(screen.getByRole('status', { name: 'settings.piPackages.operationInProgress' })).toBeTruthy();

    mutation.resolve({ available: true, packages: [packageView(1), packageView(2)] });
    await waitFor(() => expect(screen.queryByRole('status', { name: 'settings.piPackages.operationInProgress' })).toBeNull());
  });

  it('accepts only the latest refresh result and ignores a late callback after unmount', async () => {
    const firstLoad = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const lateLoad = deferred<{ available: boolean; packages: PiPackageView[] }>();
    let notifyChanged: (() => void) | undefined;
    const listPiPackages = vi
      .fn()
      .mockImplementationOnce(() => firstLoad.promise)
      .mockResolvedValueOnce({ available: true, packages: [packageView(2)] })
      .mockImplementationOnce(() => lateLoad.promise);
    installElectronApi({
      listPiPackages,
      onChanged: (callback) => {
        notifyChanged = callback;
        return () => undefined;
      },
    });

    const rendered = render(<PiPackagesSection />);
    notifyChanged?.();
    expect(await screen.findByText('sample-extension-2')).toBeTruthy();

    firstLoad.resolve({ available: true, packages: [packageView(1)] });
    await Promise.resolve();
    expect(screen.queryByText('sample-extension-1')).toBeNull();

    notifyChanged?.();
    rendered.unmount();
    lateLoad.reject(new Error('late failure'));
    await Promise.resolve();
    expect(toastMocks.error).not.toHaveBeenCalledWith('settings.piPackages.operationFailed');
  });
});
