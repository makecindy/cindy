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
    resources: [
      {
        kind: 'extension',
        name: `extensions/index-${index}.ts`,
        compatibility: 'supported',
      },
    ],
  };
}

function installElectronApi(options?: {
  listPiPackages?: ReturnType<typeof vi.fn>;
  mutatePiPackage?: ReturnType<typeof vi.fn>;
  onChanged?: (callback: () => void) => () => void;
}) {
  const listPiPackages =
    options?.listPiPackages ??
    vi.fn(async () => ({
      available: true,
      packages: [packageView(1), packageView(2)],
    }));
  const mutatePiPackage =
    options?.mutatePiPackage ??
    vi.fn(async () => ({
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

    expect((await screen.findByRole('alert')).textContent).toContain(
      'settings.piPackages.loadFailed',
    );
    expect(screen.queryByText('settings.piPackages.empty')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.retry' }));

    expect(await screen.findByText('sample-extension-1')).toBeTruthy();
    expect(listPiPackages).toHaveBeenCalledTimes(2);
  });

  it('keeps explicit install available when package projection fails to load', async () => {
    const installedPackage = { ...packageView(1), enabled: true };
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn().mockRejectedValue(new Error('projection unavailable')),
      mutatePiPackage: vi.fn(async () => ({
        available: true,
        packages: [installedPackage],
        affectedPackage: installedPackage,
      })),
    });
    render(<PiPackagesSection />);

    await screen.findByRole('alert');
    fireEvent.change(screen.getByPlaceholderText('settings.piPackages.sourcePlaceholder'), {
      target: { value: 'npm:new-extension' },
    });
    const installButton = screen.getByRole('button', { name: 'settings.piPackages.install' });
    expect((installButton as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(installButton);

    await waitFor(() =>
      expect(mutatePiPackage).toHaveBeenCalledWith({
        action: 'install',
        source: 'npm:new-extension',
      }),
    );
  });

  it('preserves the complete roster and exposes retry when a background refresh fails', async () => {
    let changed: (() => void) | undefined;
    const listPiPackages = vi
      .fn()
      .mockResolvedValueOnce({ available: true, packages: [packageView(1), packageView(2)] })
      .mockRejectedValueOnce(new Error('projection unavailable'));
    installElectronApi({
      listPiPackages,
      onChanged: (callback) => {
        changed = callback;
        return () => undefined;
      },
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    changed?.();

    expect(await screen.findByRole('alert')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'settings.piPackages.retry' })).toBeTruthy();
    expect(screen.getByText('sample-extension-1')).toBeTruthy();
    expect(screen.getByText('sample-extension-2')).toBeTruthy();
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
      (
        screen.getAllByRole('button', {
          name: 'settings.piPackages.removeAria',
        })[1] as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect((screen.getAllByRole('switch')[1] as HTMLButtonElement).disabled).toBe(true);
    expect(
      screen.getByRole('status', { name: 'settings.piPackages.operationInProgress' }),
    ).toBeTruthy();

    mutation.resolve({ available: true, packages: [packageView(1), packageView(2)] });
    await waitFor(() => expect((updateButtons[1] as HTMLButtonElement).disabled).toBe(false));
  });

  it('routes install directly into the Main-owned confirmation flow and keeps retry state on failure', async () => {
    const firstMutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const enabledPackage: PiPackageView = {
      ...packageView(1),
      enabled: true,
      resources: [{
        kind: 'extension',
        name: 'extensions/index-1.ts',
        compatibility: 'partial',
        compatibilityIssues: ['status-display'],
      }],
    };
    const mutatePiPackage = vi
      .fn()
      .mockImplementationOnce(() => firstMutation.promise)
      .mockResolvedValueOnce({
        available: true,
        packages: [enabledPackage],
        affectedPackage: enabledPackage,
      });
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

    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(mutatePiPackage).toHaveBeenCalledWith({
      action: 'install',
      source: 'npm:sample-extension-1',
    });
    expect(
      (screen.getByRole('button', { name: 'settings.piPackages.install' }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    firstMutation.reject(new Error('network'));
    await waitFor(() => {
      expect(
        (screen.getByRole('button', { name: 'settings.piPackages.install' }) as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    expect(
      (screen.getByPlaceholderText('settings.piPackages.sourcePlaceholder') as HTMLInputElement)
        .value,
    ).toBe('npm:sample-extension-1');

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.install' }));
    await waitFor(() => expect(screen.getByText('sample-extension-1')).toBeTruthy());
    expect(mutatePiPackage).toHaveBeenCalledTimes(2);
    expect(toastMocks.success).toHaveBeenCalledWith(
      'settings.piPackages.success.installEnabled',
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
  });

  it('does not claim enablement when an installed package remains disabled', async () => {
    const disabledPackage: PiPackageView = {
      ...packageView(1),
      enabled: false,
      canToggle: false,
      resources: [],
      warning: 'inspection-failed',
    };
    installElectronApi({
      listPiPackages: vi.fn(async () => ({ available: true, packages: [] })),
      mutatePiPackage: vi.fn(async () => ({
        available: true,
        packages: [disabledPackage],
        affectedPackage: disabledPackage,
      })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('settings.piPackages.empty');

    fireEvent.change(screen.getByPlaceholderText('settings.piPackages.sourcePlaceholder'), {
      target: { value: disabledPackage.source },
    });
    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.install' }));

    await waitFor(() =>
      expect(toastMocks.error).toHaveBeenCalledWith('settings.piPackages.operationFailed'),
    );
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('preserves the last complete roster when native success has no fresh projection', async () => {
    installElectronApi({
      mutatePiPackage: vi.fn(async () => ({
        available: false,
        packages: [],
        changed: true,
        projectionUnavailable: true,
      })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.removeAria' })[0]!);

    await waitFor(() => expect(toastMocks.success).toHaveBeenCalledWith(
      'settings.piPackages.success.settingsRemove',
    ));
    expect(toastMocks.error).toHaveBeenCalledWith(
      'settings.piPackages.failure.stateUnavailable',
    );
    expect(screen.getByText('sample-extension-1')).toBeTruthy();
    expect(screen.getByText('sample-extension-2')).toBeTruthy();
    expect(screen.getByRole('alert').textContent).toContain('settings.piPackages.loadFailed');
    expect(screen.getByRole('button', { name: 'settings.piPackages.retry' })).toBeTruthy();
    expect(screen.queryByText('settings.piPackages.empty')).toBeNull();
    expect(screen.queryByText('settings.piPackages.piUnavailable')).toBeNull();
  });

  it('reports partial runtime convergence without claiming every task stopped', async () => {
    installElectronApi({
      mutatePiPackage: vi.fn(async () => ({
        available: true,
        packages: [packageView(1), packageView(2)],
        changed: true,
        runtimeConvergence: 'partial',
      })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.updateAria' })[0]!);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(
      'settings.piPackages.failure.runtimeConvergencePartial',
    ));
    expect(toastMocks.success).not.toHaveBeenCalled();
  });

  it('shows the Main-sanitized actionable mutation failure', async () => {
    installElectronApi({
      mutatePiPackage: vi.fn(async () => {
        throw new Error('[PI_PACKAGE_MUTATION_FAILED] restart Cindy and refresh extensions');
      }),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('switch')[0]!);

    await waitFor(() => expect(toastMocks.error).toHaveBeenCalledWith(
      'restart Cindy and refresh extensions',
    ));
  });

  it('routes remove directly to Main without a dialog and retries after failure', async () => {
    const firstMutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const mutatePiPackage = vi
      .fn()
      .mockImplementationOnce(() => firstMutation.promise)
      .mockResolvedValueOnce({ available: true, packages: [packageView(2)] });
    installElectronApi({ mutatePiPackage });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-2');

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.removeAria' })[0]!);
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      (
        screen.getAllByRole('button', {
          name: 'settings.piPackages.removeAria',
        })[0] as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    firstMutation.reject(new Error('locked'));
    await waitFor(() => {
      expect(
        (
          screen.getAllByRole('button', {
            name: 'settings.piPackages.removeAria',
          })[0] as HTMLButtonElement
        ).disabled,
      ).toBe(false);
    });
    expect(screen.getByText('sample-extension-1')).toBeTruthy();

    fireEvent.click(screen.getAllByRole('button', { name: 'settings.piPackages.removeAria' })[0]!);
    await waitFor(() => expect(screen.queryByText('sample-extension-1')).toBeNull());
    expect(mutatePiPackage).toHaveBeenLastCalledWith({
      action: 'remove',
      source: 'npm:sample-extension-1',
    });
    expect(toastMocks.success).toHaveBeenLastCalledWith(
      'settings.piPackages.success.settingsRemove',
    );
  });

  it('uses a Main-owned opaque target for a redacted package source', async () => {
    const redactedPackage = {
      ...packageView(1),
      source: 'git:https://example.com/acme/package.git',
      mutationTarget: `cindy-pi-package:${'a'.repeat(64)}`,
    };
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn(async () => ({ available: true, packages: [redactedPackage] })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-1');

    fireEvent.click(screen.getByRole('button', { name: 'settings.piPackages.updateAria' }));

    await waitFor(() => expect(mutatePiPackage).toHaveBeenCalledWith({
      action: 'update',
      source: redactedPackage.source,
      mutationTarget: redactedPackage.mutationTarget,
    }));
  });

  it('keeps rows with the same redacted source independent by opaque target', async () => {
    const redactedSource = 'git:https://example.com/acme/package.git';
    const firstPackage: PiPackageView = {
      ...packageView(1),
      source: redactedSource,
      name: 'credential-a',
      mutationTarget: `cindy-pi-package:${'a'.repeat(64)}`,
    };
    const secondPackage: PiPackageView = {
      ...packageView(2),
      source: redactedSource,
      name: 'credential-b',
      mutationTarget: `cindy-pi-package:${'b'.repeat(64)}`,
    };
    const mutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn(async () => ({
        available: true,
        packages: [firstPackage, secondPackage],
      })),
      mutatePiPackage: vi.fn(() => mutation.promise),
    });
    render(<PiPackagesSection />);
    await screen.findByText('credential-b');

    const detailButtons = screen.getAllByRole('button', {
      name: 'settings.piPackages.showDetails',
    });
    fireEvent.click(detailButtons[0]!);
    expect(screen.getAllByText(redactedSource)).toHaveLength(1);
    fireEvent.click(detailButtons[1]!);
    expect(screen.getAllByText(redactedSource)).toHaveLength(2);
    fireEvent.click(screen.getAllByRole('button', {
      name: 'settings.piPackages.collapseDetails',
    })[0]!);
    expect(screen.getAllByText(redactedSource)).toHaveLength(1);

    const updateButtons = screen.getAllByRole('button', {
      name: 'settings.piPackages.updateAria',
    });
    fireEvent.click(updateButtons[1]!);
    await waitFor(() => expect(mutatePiPackage).toHaveBeenCalledWith({
      action: 'update',
      source: redactedSource,
      mutationTarget: secondPackage.mutationTarget,
    }));
    expect(updateButtons[0]?.getAttribute('aria-busy')).toBe('false');
    expect(updateButtons[1]?.getAttribute('aria-busy')).toBe('true');

    mutation.resolve({ available: true, packages: [firstPackage, secondPackage] });
    await waitFor(() => expect(updateButtons[1]?.getAttribute('aria-busy')).toBe('false'));
  });

  it('routes enable directly to Main without a dialog and shows progress', async () => {
    const mutation = deferred<{ available: boolean; packages: PiPackageView[] }>();
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn(async () => ({
        available: true,
        packages: [{ ...packageView(1), requiresExtensionApproval: true }, packageView(2)],
      })),
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
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(
      screen.getByRole('status', { name: 'settings.piPackages.operationInProgress' }),
    ).toBeTruthy();

    mutation.resolve({ available: true, packages: [packageView(1), packageView(2)] });
    await waitFor(() =>
      expect(
        screen.queryByRole('status', { name: 'settings.piPackages.operationInProgress' }),
      ).toBeNull(),
    );
  });

  it('disables directly without a dialog and reports immediate runtime revocation', async () => {
    const enabledPackage = { ...packageView(1), enabled: true };
    const disabledPackage = { ...enabledPackage, enabled: false };
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn(async () => ({
        available: true,
        packages: [enabledPackage],
      })),
      mutatePiPackage: vi.fn(async () => ({
        available: true,
        packages: [disabledPackage],
      })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-1');

    fireEvent.click(screen.getByRole('switch'));

    await waitFor(() => expect(mutatePiPackage).toHaveBeenCalledWith({
      action: 'set-enabled',
      source: 'npm:sample-extension-1',
      enabled: false,
    }));
    expect(screen.queryByRole('alertdialog')).toBeNull();
    expect(toastMocks.success).toHaveBeenLastCalledWith(
      'settings.piPackages.success.settingsDisable',
    );
  });

  it('disables only the enable switch for packages without launchable resources', async () => {
    const noResources: PiPackageView = {
      source: 'npm:no-resources',
      name: 'no-resources',
      enabled: false,
      canToggle: false,
      resources: [],
      warning: 'no-resources',
    };
    const themeOnly: PiPackageView = {
      source: 'npm:theme-only',
      name: 'theme-only',
      enabled: false,
      canToggle: false,
      resources: [{ kind: 'theme', name: 'night.json', compatibility: 'unsupported' }],
    };
    const inspectionFailed: PiPackageView = {
      source: 'npm:inspection-failed',
      name: 'inspection-failed',
      enabled: false,
      canToggle: false,
      resources: [],
      warning: 'inspection-failed',
    };
    const promptOnly: PiPackageView = {
      source: 'npm:prompt-only',
      name: 'prompt-only',
      enabled: true,
      resources: [{ kind: 'prompt', name: 'hello.md', compatibility: 'supported' }],
    };
    const skillOnly: PiPackageView = {
      source: 'npm:skill-only',
      name: 'skill-only',
      enabled: true,
      resources: [{ kind: 'skill', name: 'hello', compatibility: 'supported' }],
    };
    const { mutatePiPackage } = installElectronApi({
      listPiPackages: vi.fn(async () => ({
        available: true,
        packages: [noResources, themeOnly, inspectionFailed, promptOnly, skillOnly, packageView(1)],
      })),
    });
    render(<PiPackagesSection />);
    await screen.findByText('sample-extension-1');

    const switches = screen.getAllByRole('switch') as HTMLButtonElement[];
    expect(switches.slice(0, 3).every((control) => control.disabled)).toBe(true);
    expect(switches.slice(3).every((control) => !control.disabled)).toBe(true);
    expect(
      screen.getAllByRole('button', { name: 'settings.piPackages.updateAria' })
        .every((control) => !(control as HTMLButtonElement).disabled),
    ).toBe(true);
    fireEvent.click(switches[0]!);
    expect(mutatePiPackage).not.toHaveBeenCalled();
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
