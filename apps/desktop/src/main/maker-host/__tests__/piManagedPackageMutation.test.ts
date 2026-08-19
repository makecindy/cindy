import { beforeEach, describe, expect, it, vi } from 'vitest';

const electron = vi.hoisted(() => ({
  focusedWindow: null as object | null,
  showMessageBox: vi.fn(),
}));

vi.mock('electron', () => ({
  BrowserWindow: {
    getFocusedWindow: () => electron.focusedWindow,
  },
  dialog: {
    showMessageBox: electron.showMessageBox,
  },
}));

vi.mock('../pi-package-store.js', () => ({
  mutatePiPackage: vi.fn(),
}));

vi.mock('../pi-package-mutation-grant.js', () => ({
  issuePiPackageMutationGrant: vi.fn(),
}));

vi.mock('../../i18n.js', () => ({
  t: (key: string) => ({
    'settings.piPackages.uninstallDescription': 'remove {{name}}',
    'settings.piPackages.updateConfirmDescription': 'update {{source}}',
    'settings.piPackages.confirmDescription': 'install {{source}}',
  }[key] ?? key),
}));

import { PiManagedPackageMutationCancelledError } from '@cindy/maker-core';

import {
  confirmLocalPiManagedPackageMutation,
  mutateAuthorizedPiManagedPackage,
  type PiManagedPackageMutationDeps,
} from '../pi-managed-package-mutation.js';

function buildDeps() {
  const grant = {} as ReturnType<PiManagedPackageMutationDeps['issueGrant']>;
  const deps: PiManagedPackageMutationDeps = {
    confirmLocalMutation: vi.fn(async () => true),
    issueGrant: vi.fn(() => grant),
    mutate: vi.fn(async () => ({ available: true, packages: [], changed: true })),
  };
  return { deps, grant };
}

describe('Pi managed package Main authorization', () => {
  beforeEach(() => {
    electron.focusedWindow = null;
    electron.showMessageBox.mockReset();
  });

  it('requires native Main confirmation before a local Desktop command receives a grant', async () => {
    const { deps, grant } = buildDeps();
    const request = {
      action: 'install' as const,
      source: 'npm:context-mode',
      authorization: 'local-desktop-command' as const,
    };

    await mutateAuthorizedPiManagedPackage(request, deps);

    expect(deps.confirmLocalMutation).toHaveBeenCalledWith({
      action: 'install',
      source: 'npm:context-mode',
    });
    expect(vi.mocked(deps.confirmLocalMutation).mock.invocationCallOrder[0]).toBeLessThan(
      vi.mocked(deps.issueGrant).mock.invocationCallOrder[0]!,
    );
    expect(deps.mutate).toHaveBeenCalledWith(
      { action: 'install', source: 'npm:context-mode' },
      grant,
    );
  });

  it('does not issue a grant or mutate when the local Desktop confirmation is cancelled', async () => {
    const { deps } = buildDeps();
    vi.mocked(deps.confirmLocalMutation).mockResolvedValue(false);

    await expect(mutateAuthorizedPiManagedPackage({
      action: 'remove',
      source: 'npm:context-mode',
      authorization: 'local-desktop-command',
    }, deps)).rejects.toBeInstanceOf(PiManagedPackageMutationCancelledError);
    expect(deps.issueGrant).not.toHaveBeenCalled();
    expect(deps.mutate).not.toHaveBeenCalled();
  });

  it('keeps the original source bound to the grant and mutation after display-only escaping', async () => {
    const { deps, grant } = buildDeps();
    const source = 'npm:trusted\tname\u001b\u202Etxt';
    const request = {
      action: 'install' as const,
      source,
      authorization: 'local-desktop-command' as const,
    };

    await mutateAuthorizedPiManagedPackage(request, deps);

    expect(deps.confirmLocalMutation).toHaveBeenCalledWith({ action: 'install', source });
    expect(deps.issueGrant).toHaveBeenCalledWith({ action: 'install', source });
    expect(deps.mutate).toHaveBeenCalledWith({ action: 'install', source }, grant);
  });

  it.each(['authenticated-im-command', 'confirmed-tool-call'] as const)(
    'accepts host-trusted %s without a second Desktop dialog',
    async (authorization) => {
      const { deps } = buildDeps();
      await mutateAuthorizedPiManagedPackage({
        action: 'update',
        source: 'npm:context-mode',
        authorization,
      }, deps);
      expect(deps.confirmLocalMutation).not.toHaveBeenCalled();
      expect(deps.issueGrant).toHaveBeenCalledOnce();
      expect(deps.mutate).toHaveBeenCalledOnce();
    },
  );

  it('uses a Main-owned native dialog whose cancellation is the default', async () => {
    electron.showMessageBox.mockResolvedValue({ response: 1 });

    await expect(confirmLocalPiManagedPackageMutation({
      action: 'install',
      source: 'npm:context-mode',
    })).resolves.toBe(false);
    expect(electron.showMessageBox).toHaveBeenCalledWith(expect.objectContaining({
      buttons: [
        'settings.piPackages.confirmInstall',
        'settings.piPackages.cancel',
      ],
      defaultId: 1,
      cancelId: 1,
    }));
  });

  it('treats the Main native confirm button as the user gesture that authorizes mutation', async () => {
    const owner = {};
    electron.focusedWindow = owner;
    electron.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(confirmLocalPiManagedPackageMutation({
      action: 'remove',
      source: 'npm:context-mode',
    })).resolves.toBe(true);
    expect(electron.showMessageBox).toHaveBeenCalledWith(
      owner,
      expect.objectContaining({
        buttons: [
          'settings.piPackages.confirmUninstall',
          'settings.piPackages.cancel',
        ],
        defaultId: 1,
        cancelId: 1,
      }),
    );
  });

  it.each([
    ['install', 'install'] as const,
    ['update', 'update'] as const,
    ['remove', 'remove'] as const,
  ])('escapes untrusted controls in the %s dialog without changing the mutation source', async (
    action,
    verb,
  ) => {
    const source = 'C:\\safe\\pkg\tname\u001b\u202Etxt\u2066\u2028end';
    electron.showMessageBox.mockResolvedValue({ response: 0 });

    await expect(confirmLocalPiManagedPackageMutation({ action, source })).resolves.toBe(true);

    const options = electron.showMessageBox.mock.calls[0]?.at(-1) as { detail: string };
    expect(options.detail).toBe(
      `${verb} C:\\\\safe\\\\pkg\\u{0009}name\\u{001B}\\u{202E}txt\\u{2066}\\u{2028}end`,
    );
    expect(options.detail).not.toContain('\t');
    expect(options.detail).not.toContain('\u001b');
    expect(options.detail).not.toContain('\u202E');
    expect(options.detail).not.toContain('\u2066');
    expect(options.detail).not.toContain('\u2028');
  });
});
