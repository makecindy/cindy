import { readFileSync } from 'node:fs';

import { PiManagedPackageMutationFailedError } from '@cindy/maker-core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const loggerMocks = vi.hoisted(() => ({
  warn: vi.fn(),
}));

const storeMocks = vi.hoisted(() => ({
  mayHaveChangedState: vi.fn(() => false),
}));

vi.mock('../pi-package-store.js', () => ({
  mutatePiPackage: vi.fn(),
  piPackageMutationMayHaveChangedState: storeMocks.mayHaveChangedState,
}));

vi.mock('../../logger.js', () => ({
  createLogger: () => ({ warn: loggerMocks.warn }),
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
  beforeEach(() => {
    vi.clearAllMocks();
  });

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

  it.each(['update', 'remove'] as const)(
    'forwards the host runtime hook to the native %s commit edge',
    async (action) => {
      const { deps, grant } = buildDeps();
      const hooks = { onRuntimeInvalidationPublished: vi.fn() };

      await mutateAuthorizedPiManagedPackage({
        action,
        source: 'npm:context-mode',
        authorization: 'confirmed-tool-call',
      }, deps, hooks);

      expect(deps.mutate).toHaveBeenCalledWith(
        { action, source: 'npm:context-mode' },
        grant,
        hooks,
      );
    },
  );

  it('publishes sibling convergence before retiring the exact caller snapshot', () => {
    const piHostSource = readFileSync(new URL('../pi-host.ts', import.meta.url), 'utf8');
    const makerHostSource = readFileSync(new URL('../index.ts', import.meta.url), 'utf8');

    expect(piHostSource).toContain(
      '{ onRuntimeInvalidationPublished: opts.onPiManagedPackageMutationCommitted }',
    );
    expect(piHostSource).toContain(
      'onPiManagedPackageMutationSettled: opts.onPiManagedPackageMutationSettled',
    );
    expect(makerHostSource).toContain(
      "onPiManagedPackageMutationCommitted: async (phase = 'commit') =>",
    );
    expect(makerHostSource).toContain(
      'await captureLocalPiPackageRuntimeInvalidationSnapshot(maker)',
    );
    expect(makerHostSource).toContain(
      'pendingPiPackageRuntimeSnapshots[pendingPiPackageRuntimeSnapshots.length - 1] = snapshot',
    );
    expect(makerHostSource).toContain(
      'snapshot.entries.filter(({ session }) => session.id === callerSessionId)',
    );
    expect(makerHostSource).toContain(
      'snapshot.entries.filter(({ session }) => session.id !== callerSessionId)',
    );
    expect(makerHostSource).toContain("recoveryAction: 'restart-cindy-to-refresh-packages'");
    const publishIndex = makerHostSource.indexOf('if (initiallyPartial) partial()');
    const callerRetirementIndex = makerHostSource.indexOf('{ entries: callerEntries }');
    expect(publishIndex).toBeGreaterThan(-1);
    expect(callerRetirementIndex).toBeGreaterThan(publishIndex);
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

  it('carries only the runtime-convergence bit across a failed host mutation', async () => {
    const { deps } = buildDeps();
    const rawError = new Error('private native failure');
    vi.mocked(deps.mutate).mockRejectedValueOnce(rawError);
    storeMocks.mayHaveChangedState.mockReturnValueOnce(true);

    const failure = await mutateAuthorizedPiManagedPackage({
      action: 'update',
      source: 'npm:context-mode',
      authorization: 'local-desktop-command',
    }, deps).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(PiManagedPackageMutationFailedError);
    expect(failure).toMatchObject({
      mayHaveChangedState: true,
      failureCode: 'native-command-failed',
    });
    expect(failure).not.toHaveProperty('cause');
  });

  it.each([
    ['npm ERR! code ETARGET No matching version found', 'version-not-found'],
    ['npm ERR! code E404 package not found', 'package-not-found'],
    ['getaddrinfo ENOTFOUND registry.example', 'source-unavailable'],
    ['Pi extension state is unavailable', 'state-unavailable'],
  ] as const)('classifies recoverable native failure: %s', async (message, failureCode) => {
    const { deps } = buildDeps();
    vi.mocked(deps.mutate).mockRejectedValueOnce(new Error(message));

    await expect(mutateAuthorizedPiManagedPackage({
      action: 'install',
      source: 'npm:context-mode',
      authorization: 'local-desktop-command',
    }, deps)).rejects.toMatchObject({ failureCode });
  });

  it.each([
    ['credentials', 'https://user:secret@example.com/pkg.git'],
    ['query', 'https://example.com/pkg.git?token=query-secret'],
    ['fragment', 'https://example.com/pkg.git#fragment-secret'],
  ])('never persists raw %s details from a failed wrapper mutation', async (_kind, source) => {
    const { deps } = buildDeps();
    const rawMessage = `npm failed while fetching ${source}`;
    vi.mocked(deps.mutate).mockRejectedValueOnce(new Error(rawMessage));

    await expect(mutateAuthorizedPiManagedPackage({
      action: 'install',
      source,
      authorization: 'local-desktop-command',
    }, deps)).rejects.toBeInstanceOf(PiManagedPackageMutationFailedError);

    const logged = JSON.stringify(loggerMocks.warn.mock.calls);
    expect(logged).not.toContain(source);
    expect(logged).not.toContain(rawMessage);
    expect(loggerMocks.warn).toHaveBeenCalledWith(
      'Pi managed package native mutation failed',
      {
        action: 'install',
        failureCode: 'native-command-failed',
        mayHaveChangedState: false,
      },
    );
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
