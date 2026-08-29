import { describe, expect, it, vi } from 'vitest';

vi.mock('../pi-package-store.js', () => ({
  mutatePiPackage: vi.fn(),
}));

vi.mock('../pi-package-mutation-grant.js', () => ({
  issuePiPackageMutationGrant: vi.fn(),
}));

import {
  mutateAuthorizedPiManagedPackage,
  type PiManagedPackageMutationDeps,
} from '../pi-managed-package-mutation.js';

function buildDeps() {
  const grant = {} as ReturnType<PiManagedPackageMutationDeps['issueGrant']>;
  const deps: PiManagedPackageMutationDeps = {
    issueGrant: vi.fn(() => grant),
    mutate: vi.fn(async () => ({ available: true, packages: [], changed: true })),
  };
  return { deps, grant };
}

describe('Pi managed package Main authorization', () => {
  it.each([
    'local-desktop-command',
    'authenticated-im-command',
    'confirmed-tool-call',
  ] as const)('treats host-trusted %s as the single authorization', async (authorization) => {
    const { deps, grant } = buildDeps();
    await mutateAuthorizedPiManagedPackage({
      action: 'install',
      source: 'npm:context-mode',
      authorization,
    }, deps);

    expect(deps.issueGrant).toHaveBeenCalledOnce();
    expect(deps.issueGrant).toHaveBeenCalledWith({
      action: 'install',
      source: 'npm:context-mode',
    });
    expect(deps.mutate).toHaveBeenCalledWith(
      { action: 'install', source: 'npm:context-mode' },
      grant,
    );
  });

  it('keeps the exact action and source bound to the one-shot grant', async () => {
    const { deps, grant } = buildDeps();
    const source = 'npm:trusted\tname\u001b\u202Etxt';

    await mutateAuthorizedPiManagedPackage({
      action: 'update',
      source,
      authorization: 'local-desktop-command',
    }, deps);

    expect(deps.issueGrant).toHaveBeenCalledWith({ action: 'update', source });
    expect(deps.mutate).toHaveBeenCalledWith({ action: 'update', source }, grant);
  });

  it('rejects authorization values outside the host-owned union at runtime', async () => {
    const { deps } = buildDeps();
    await expect(mutateAuthorizedPiManagedPackage({
      action: 'remove',
      source: 'npm:context-mode',
      authorization: 'renderer-claimed' as 'local-desktop-command',
    }, deps)).rejects.toThrow('missing host-trusted authorization');
    expect(deps.issueGrant).not.toHaveBeenCalled();
    expect(deps.mutate).not.toHaveBeenCalled();
  });
});
